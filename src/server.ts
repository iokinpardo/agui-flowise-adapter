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

    // 👉 Mandamos ambas banderas
    const body: Record<string, any> = { question, stream: true, streaming: true };

    // Timeout
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

    // --- Parser SSE robusto ---
    let currentEvent: string | null = null;
    let sawAnyData = false;
    const decoder = new TextDecoder();
    let buffer = '';

    const handleDataPayload = (raw: string) => {
      const s = raw.trim();
      if (!s) return;
      if (s === '[DONE]') {
        sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
        sseEvent(res, 'run.completed', { id: runId });
        res.end();
        return 'DONE';
      }
      try {
        const chunk = JSON.parse(s);
        if (chunk && typeof chunk === 'object') {
          const token: any =
            chunk.text ??
            chunk.delta?.content ??
            chunk.data?.content ??
            chunk.data;
          if (typeof token === 'string' && token) {
            sseEvent(res, 'message.delta', { id: messageId, delta: { content: token } });
            return;
          }
        }
        if (typeof chunk === 'string' && chunk) {
          sseEvent(res, 'message.delta', { id: messageId, delta: { content: chunk } });
          return;
        }
      } catch {
        sseEvent(res, 'message.delta', { id: messageId, delta: { content: s } });
      }
    };

    const processLine = (line: string) => {
      let l = (line ?? '').trim();
      if (!l) return;
      if (l.startsWith('message:')) {
        l = l.slice('message:'.length).trim();
      }
      if (l.startsWith('event:')) {
        currentEvent = l.slice('event:'.length).trim() || null;
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

    // Fallback JSON
    sseEvent(res, 'status.update', { at: Date.now(), msg: 'Non-SSE response, parsing JSON…' });
    try {
      const json = JSON.parse(buffer || (await resp.text()));
      const final = extractFinalText(json);
      if (final) {
        sseEvent(res, 'message.delta', { id: messageId, delta: { content: final } });
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
