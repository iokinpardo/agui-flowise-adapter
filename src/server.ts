import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const FLOWISE_BASE_URL = process.env.FLOWISE_BASE_URL || 'http://localhost:3000';
const FLOWISE_API_KEY  = process.env.FLOWISE_API_KEY  || '';
const PORT = Number(process.env.PORT || 8787);

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

/** Emitir eventos SSE con nombre AG-UI */
function sseEvent(res: any, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Normaliza texto (por ejemplo <br> -> saltos de línea) */
function normalizeText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r\n/g, '\n');
}

/** ¿Es un token de control que no queremos mostrar? */
function isControlToken(s: string): boolean {
  const t = s.trim().toUpperCase();
  return t === 'INPROGRESS' || t === 'FINISHED' || t === '[DONE]';
}

/** Emite un texto largo en pequeños deltas (mejor UX visual) */
function emitChunked(res: any, messageId: string, text: string) {
  const clean = normalizeText(text);
  const sentences = clean.split(/(?<=[\.!\?])\s+(?=[A-ZÁÉÍÓÚÜÑ¡¿“"'\(]|$)/);
  if (sentences.length > 1) {
    for (const s of sentences) {
      const part = s.trim();
      if (!part) continue;
      sseEvent(res, 'message.delta', { id: messageId, delta: { content: part + ' ' } });
    }
    return;
  }
  const CHUNK = 120;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const slice = clean.slice(i, i + CHUNK);
    if (slice.trim()) {
      sseEvent(res, 'message.delta', { id: messageId, delta: { content: slice } });
    }
  }
}

/** Extraer texto final de respuestas JSON (array/objeto) de Flowise */
function extractFinalText(payload: any): string {
  try {
    if (Array.isArray(payload)) {
      if (payload[0]?.text && typeof payload[0].text === 'string') return payload[0].text;
      const exec = payload[0]?.agentFlowExecutedData;
      if (Array.isArray(exec)) {
        const directReply = exec.find(
          (n: any) =>
            (n?.data?.name === 'directReplyAgentflow' ||
             n?.nodeLabel?.toLowerCase?.().includes('welcome')) &&
            n?.data?.output?.content
        );
        if (directReply?.data?.output?.content) return String(directReply.data.output.content);
        const anyReply = exec.find((n: any) => n?.data?.output?.content);
        if (anyReply?.data?.output?.content) return String(anyReply.data.output.content);
      }
      if (payload[0]?.data?.output?.content) return String(payload[0].data.output.content);
      return JSON.stringify(payload);
    }
    if (payload && typeof payload === 'object') {
      if (typeof payload.text === 'string') return payload.text;
      if (payload.data?.output?.content) return String(payload.data.output.content);
      if (payload.output?.content) return String(payload.output.content);
      return JSON.stringify(payload);
    }
    if (typeof payload === 'string') return payload;
    return String(payload);
  } catch {
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
}

/** Emite diff de estado: cualquier clave que cambie */
function emitStateDiff(
  res: any,
  lastState: Record<string, any>,
  nextState: Record<string, any>,
  source?: { nodeId?: string; nodeLabel?: string }
) {
  if (!nextState || typeof nextState !== 'object') return;

  const changed: Record<string, any> = {};
  let somethingChanged = false;

  // Detecta cambios o nuevas claves
  for (const [k, v] of Object.entries(nextState)) {
    const prev = lastState[k];
    if (prev !== v) {
      changed[k] = v;
      lastState[k] = v;
      somethingChanged = true;
    }
  }

  // Detecta claves eliminadas (opc.)
  for (const k of Object.keys(lastState)) {
    if (!(k in nextState)) {
      changed[k] = undefined;
      delete lastState[k];
      somethingChanged = true;
    }
  }

  if (somethingChanged) {
    sseEvent(res, 'status.update', {
      at: Date.now(),
      state: { changed, full: { ...lastState } },
      ...(source ? { source } : {})
    });
  }
}

/**
 * GET /agui/stream?chatflowId=...&q=...
 * Traduce Flowise Prediction (SSE o JSON) -> eventos AG-UI,
 * emite status.update con diffs de flow.state, y evita duplicados
 * mostrando sólo el ÚLTIMO nodo de cada paquete acumulativo.
 */
app.get('/agui/stream', async (req, res) => {
  const chatflowId = String(req.query.chatflowId || '');
  const question   = String(req.query.q || '');
  const runId      = 'run_' + Date.now();
  const messageId  = 'msg_' + Date.now();

  if (!chatflowId || !question) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'chatflowId y q son obligatorios' }));
    return;
  }

  // SSE hacia el navegador
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });

  sseEvent(res, 'run.input', {
    id: runId,
    messages: [{ id: 'user_' + Date.now(), role: 'user', content: question }]
  });
  sseEvent(res, 'status.update', { at: Date.now(), msg: 'Calling Flowise…' });

  try {
    const url  = `${FLOWISE_BASE_URL}/api/v1/prediction/${encodeURIComponent(chatflowId)}`;

    // Enviamos ambas banderas por compatibilidad
    const body: Record<string, any> = { question, stream: true, streaming: true };

    // Timeout
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000); // flows largos

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FLOWISE_API_KEY ? { 'Authorization': `Bearer ${FLOWISE_API_KEY}` } : {}),
        'Accept': 'text/event-stream, application/json;q=0.9, */*;q=0.1'
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));

    const ct = resp.headers.get('content-type') || '';
    sseEvent(res, 'status.update', { at: Date.now(), msg: `Content-Type from Flowise: ${ct}` });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      sseEvent(res, 'run.error', { id: runId, error: `Prediction API ${resp.status}: ${text}` });
      sseEvent(res, 'message.error', { id: messageId, error: `Prediction API error` });
      sseEvent(res, 'run.completed', { id: runId });
      res.end();
      return;
    }

    // --- Parser SSE robusto con captura de estados + deduplicación ---
    let sawAnyData = false;
    const decoder = new TextDecoder();
    let buffer = '';
    const lastState: Record<string, any> = {}; // diff acumulado por request

    // Para evitar repeticiones: recordamos el último nodo procesado y contenidos ya emitidos
    let lastProcessedNodeId: string | null = null;
    const emittedContentKeys = new Set<string>(); // key = `${nodeId}:${hash(text)}`

    const hash = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
      }
      return h.toString(36);
    };

    const handleExecutedNode = (node: any) => {
      // Sólo procesamos el ÚLTIMO nodo de cada paquete:
      const nodeId = node?.nodeId || node?.data?.id || '';
      const nodeLabel = node?.nodeLabel || node?.data?.name;

      // Estado
      const st = node?.data?.state;
      if (st && typeof st === 'object') {
        emitStateDiff(res, lastState, st, { nodeId, nodeLabel });
      }
      // Updates declarativos
      const updates = node?.data?.input?.agentUpdateState;
      if (Array.isArray(updates)) {
        const next: Record<string, any> = {};
        for (const u of updates) {
          if (u?.key) next[u.key] = u?.value;
        }
        if (Object.keys(next).length) {
          emitStateDiff(res, lastState, next, { nodeId, nodeLabel });
        }
      }
      // Contenido (sólo si no lo emitimos ya para este nodo)
      const content = node?.data?.output?.content;
      if (typeof content === 'string' && content.trim()) {
        const k = `${nodeId}:${hash(content)}`;
        if (!emittedContentKeys.has(k)) {
          emittedContentKeys.add(k);
          emitChunked(res, messageId, content);
        }
      }

      lastProcessedNodeId = nodeId || lastProcessedNodeId;
    };

    const handleFlowiseControlEnvelope = (obj: any): boolean => {
      // Devuelve true si es "sobre" de control y ya fue manejado.
      const ev = obj?.event;
      const data = obj?.data;

      if (!ev) return false;

      if (ev === 'metadata' && data) {
        sseEvent(res, 'status.update', { at: Date.now(), metadata: data });
        return true;
      }

      if (ev === 'agentFlowEvent') {
        // INPROGRESS / FINISHED del flujo completo → ignoramos (ruido)
        return true;
      }

      if (ev === 'nextAgentFlow' && data) {
        const nodeId = data.nodeId;
        const nodeLabel = data.nodeLabel;
        const status = data.status;
        sseEvent(res, 'status.update', {
          at: Date.now(),
          node: { nodeId, nodeLabel, status }
        });
        return true;
      }

      if (ev === 'agentFlowExecutedData' && Array.isArray(data) && data.length) {
        // IMPORTANTE: Procesar SOLO el ÚLTIMO nodo del array (Flowise envía acumulativo).
        const latestNode = data[data.length - 1];
        // Si es el mismo nodo que ya procesamos y no hay cambios de contenido/estado, no hacer nada.
        // (emitStateDiff ya evita emitir si no hay cambios; contenido se deduplica por hash)
        handleExecutedNode(latestNode);
        return true;
      }

      // “Sobre” con estado directo
      if (data?.state && typeof data.state === 'object') {
        emitStateDiff(res, lastState, data.state);
        return true;
      }

      // Si llega un “sobre” con posible contenido en data.output.content (no común)
      if (data?.output?.content && typeof data.output.content === 'string') {
        const nodeId = data?.id || '';
        const k = `${nodeId}:${hash(data.output.content)}`;
        if (!emittedContentKeys.has(k)) {
          emittedContentKeys.add(k);
          emitChunked(res, messageId, data.output.content);
        }
        return true;
      }

      return false;
    };

    const handleDataPayload = (raw: string) => {
      const s = raw.trim();
      if (!s) return;
      if (s === '[DONE]') {
        sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
        sseEvent(res, 'run.completed', { id: runId });
        res.end();
        return 'DONE';
      }
      if (isControlToken(s)) return; // ignora INPROGRESS / FINISHED planos

      // Intenta JSON → puede ser “sobre” de control o chunk de texto
      try {
        const chunk = JSON.parse(s);

        // 1) “Sobre” de control (gestiona y, si hay, también contenido)
        if (chunk && typeof chunk === 'object' && (chunk.event || chunk.data?.state || chunk.data?.output?.content)) {
          const handled = handleFlowiseControlEnvelope(chunk);
          if (handled) return;
        }

        // 2) Texto simple en distintas ubicaciones
        let token: any =
          chunk?.text ??
          chunk?.delta?.content ??
          chunk?.data?.content ??
          chunk?.data;
        if (typeof token === 'string' && token.trim() && !isControlToken(token)) {
          // Evitar reemitir exactamente el mismo trozo consecutivo
          const k = `__free:${hash(token)}`;
          if (!emittedContentKeys.has(k)) {
            emittedContentKeys.add(k);
            emitChunked(res, messageId, token);
          }
          return;
        }

        // 3) Si no hay texto claro, emite raw “bonito” (casos raros)
        sseEvent(res, 'message.delta', { id: messageId, delta: { content: normalizeText(s) } });
      } catch {
        // No era JSON → emitimos tal cual troceado
        if (!isControlToken(s)) {
          const k = `__raw:${hash(s)}`;
          if (!emittedContentKeys.has(k)) {
            emittedContentKeys.add(k);
            emitChunked(res, messageId, s);
          }
        }
      }
    };

    const processLine = (line: string) => {
      let l = (line ?? '').trim();
      if (!l) return;
      if (l.startsWith('message:')) {
        l = l.slice('message:'.length).trim(); // deja "data: {...}" si viene así
      }
      if (l.startsWith('event:')) {
        // Flowise ya embebe su "event" en el JSON; no necesitamos fijarlo aquí
        return;
      }
      if (l.startsWith('data:')) {
        sawAnyData = true;
        const raw = l.slice('data:'.length).trim();
        return handleDataPayload(raw);
      }
    };

    const hasGetReader = typeof (resp.body as any).getReader === 'function';
    if (hasGetReader) {
      const reader = (resp.body as any).getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (processLine(line) === 'DONE') return;
        }
      }
    } else {
      for await (const chunk of resp.body as any) {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (processLine(line) === 'DONE') return;
        }
      }
    }

    if (sawAnyData) {
      sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
      sseEvent(res, 'run.completed', { id: runId });
      res.end();
      return;
    }

    // Fallback JSON (por si no hubo 'data:')
    sseEvent(res, 'status.update', { at: Date.now(), msg: 'Non-SSE response, parsing JSON…' });
    try {
      const json = JSON.parse(buffer || (await resp.text()));
      const final = extractFinalText(json);
      if (final) emitChunked(res, messageId, final);
      sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
      sseEvent(res, 'run.completed', { id: runId });
      res.end();
    } catch {
      sseEvent(res, 'run.error', { id: runId, error: 'Respuesta no-SSE y no-JSON de Flowise' });
      sseEvent(res, 'message.error', { id: messageId, error: 'Unexpected non-streaming response' });
      sseEvent(res, 'run.completed', { id: runId });
      res.end();
    }

  } catch (err: any) {
    sseEvent(res, 'run.error', { id: runId, error: String(err?.message || err) });
    sseEvent(res, 'message.error', { id: messageId, error: 'Unexpected streaming error' });
    sseEvent(res, 'run.completed', { id: runId });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`AG-UI adapter running on http://localhost:${PORT}`);
});
