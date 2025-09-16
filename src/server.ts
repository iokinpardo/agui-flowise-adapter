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

/** Utilidad: emitir eventos SSE con nombre AG-UI */
function sseEvent(res: any, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Extrae el texto final de respuestas JSON de Flowise (array u objeto) */
function extractFinalText(payload: any): string {
  try {
    // Caso 1: Array
    if (Array.isArray(payload)) {
      // 1A) Primer objeto con .text
      if (payload[0]?.text && typeof payload[0].text === 'string') {
        return payload[0].text;
      }
      // 1B) Busca en agentFlowExecutedData un nodo con output.content (p. ej. directReplyAgentflow)
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
      // 1C) Fallback
      if (payload[0]?.data?.output?.content) return String(payload[0].data.output.content);
      return JSON.stringify(payload);
    }

    // Caso 2: Objeto suelto
    if (payload && typeof payload === 'object') {
      if (typeof payload.text === 'string') return payload.text;
      if (payload.data?.output?.content) return String(payload.data.output.content);
      if (payload.output?.content) return String(payload.output.content);
      return JSON.stringify(payload);
    }

    // Caso 3: string/plano
    if (typeof payload === 'string') return payload;
    return String(payload);
  } catch {
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
}

/**
 * GET /agui/stream?chatflowId=...&q=...
 * Traduce Flowise Prediction (SSE o JSON) -> eventos AG-UI.
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

  // Preparar SSE hacia el navegador
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });

  // Emitimos el input de ejecución
  sseEvent(res, 'run.input', {
    id: runId,
    messages: [{ id: 'user_' + Date.now(), role: 'user', content: question }]
  });

  // Mensaje de estado (útil para depurar)
  sseEvent(res, 'status.update', { at: Date.now(), msg: 'Calling Flowise…' });

  try {
    const url  = `${FLOWISE_BASE_URL}/api/v1/prediction/${encodeURIComponent(chatflowId)}`;
    // Muchas versiones esperan "stream: true"; si tu flow no soporta streaming, devolverá JSON.
    const body: Record<string, any> = { question, stream: true };

    // Timeout (30s) para evitar quedar colgados si Flowise no responde
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);

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

    const isSSE = ct.includes('text/event-stream');

    /** Procesa una línea SSE ("data: ...") */
    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') {
        sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
        sseEvent(res, 'run.completed', { id: runId });
        res.end();
        return 'DONE';
      }
      try {
        const chunk = JSON.parse(raw);
        const token = typeof chunk === 'string' ? chunk : (chunk.text ?? '');
        if (token) sseEvent(res, 'message.delta', { id: messageId, delta: { content: token } });
      } catch {
        sseEvent(res, 'message.delta', { id: messageId, delta: { content: raw } });
      }
    };

    if (isSSE && typeof (resp.body as any).getReader === 'function') {
      // Web Streams (Undici)
      const reader = (resp.body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (processLine(line) === 'DONE') return;
        }
      }
      // Fin sin [DONE]
      sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
      sseEvent(res, 'run.completed', { id: runId });
      res.end();
      return;
    }

    if (isSSE) {
      // Node Readable clásico
      let buffer = '';
      for await (const chunk of resp.body as any) {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (processLine(line) === 'DONE') return;
        }
      }
      sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
      sseEvent(res, 'run.completed', { id: runId });
      res.end();
      return;
    }

    // NO es SSE → tratar como JSON único (tu caso actual)
    sseEvent(res, 'status.update', { at: Date.now(), msg: 'Non-SSE response, parsing JSON…' });
    const rawText = await resp.text();
    try {
      const json = JSON.parse(rawText);
      const final = extractFinalText(json);

      if (final) {
        sseEvent(res, 'message.delta', { id: messageId, delta: { content: final } });
      } else {
        sseEvent(res, 'status.update', { at: Date.now(), msg: 'No se encontró texto final en JSON de Flowise' });
      }

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
