import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const FLOWISE_BASE_URL = process.env.FLOWISE_BASE_URL || 'http://localhost:3000';
const FLOWISE_API_KEY  = process.env.FLOWISE_API_KEY  || '';
const PORT = Number(process.env.PORT || 8787);

app.get('/health', (_req, res) => res.json({ ok: true }));

function sseEvent(res: any, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function normalizeText(s: string): string {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/&nbsp;/gi, ' ').replace(/\r\n/g, '\n');
}
function isPlaceholderValue(value: any): boolean {
  return typeof value === 'string' && value.trim() === '{{ output }}';
}
function isControlToken(s: string): boolean {
  const t = s.trim().toUpperCase();
  return t === 'INPROGRESS' || t === 'FINISHED' || t === '[DONE]';
}
function emitChunked(res: any, messageId: string, text: string) {
  const clean = normalizeText(text);
  const sentences = clean.split(/(?<=[\.\!\?])\s+(?=[A-ZAÁÉÍÓÚÑ"'(|]|$)/);
  if (sentences.length > 1) {
    for (const s of sentences) {
      if (s.trim()) sseEvent(res, 'message.delta', { id: messageId, delta: { content: s.trim() + ' ' } });
    }
    return;
  }
  const CHUNK = 120;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const slice = clean.slice(i, i + CHUNK);
    if (slice.trim()) sseEvent(res, 'message.delta', { id: messageId, delta: { content: slice } });
  }
}
function extractFinalText(payload: any): string {
  try {
    if (Array.isArray(payload)) {
      if (payload[0]?.text) return payload[0].text;
      const exec = payload[0]?.agentFlowExecutedData;
      if (Array.isArray(exec)) {
        const reply = exec.find((n: any) => n?.data?.output?.content);
        if (reply?.data?.output?.content) return reply.data.output.content;
      }
    }
    if (payload && typeof payload === 'object') {
      return payload.text || payload.data?.output?.content || payload.output?.content || JSON.stringify(payload);
    }
    if (typeof payload === 'string') return payload;
    return JSON.stringify(payload);
  } catch {
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
}
function emitStateDiff(res: any, lastState: Record<string, any>, nextState: Record<string, any>, source?: any) {
  const changed: Record<string, any> = {};
  let changedFlag = false;
  for (const [k, v] of Object.entries(nextState)) {
    if (isPlaceholderValue(v)) continue;
    if (lastState[k] !== v) {
      changed[k] = v;
      lastState[k] = v;
      changedFlag = true;
    }
  }
  for (const k of Object.keys(lastState)) {
    if (!(k in nextState)) {
      changed[k] = undefined;
      delete lastState[k];
      changedFlag = true;
    }
  }
  if (changedFlag) {
    sseEvent(res, 'status.update', { at: Date.now(), state: { changed, full: { ...lastState } }, ...(source ? { source } : {}) });
  }
}

app.get('/agui/stream', async (req, res) => {
  const chatflowId = String(req.query.chatflowId || '');
  const question   = String(req.query.q || '');
  const runId      = 'run_' + Date.now();
  const messageId  = 'msg_' + Date.now();

  if (!chatflowId || !question) {
    res.status(400).json({ error: 'chatflowId y q son obligatorios' });
    return;
  }

  // SSE headers robustos
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders?.();

  // Heartbeat
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);

  sseEvent(res, 'run.input', { id: runId, messages: [{ id: 'user_' + Date.now(), role: 'user', content: question }] });
  sseEvent(res, 'status.update', { at: Date.now(), msg: 'Calling Flowise…' });

  const ac = new AbortController();
  req.on('close', () => { clearInterval(heartbeat); ac.abort(); try { res.end(); } catch {} });

  try {
    const url  = `${FLOWISE_BASE_URL}/api/v1/prediction/${encodeURIComponent(chatflowId)}`;
    const body = { question, stream: true, streaming: true };
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FLOWISE_API_KEY ? { Authorization: `Bearer ${FLOWISE_API_KEY}` } : {}),
        'Accept': 'text/event-stream, application/json'
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    const ct = resp.headers.get('content-type') || '';
    sseEvent(res, 'status.update', { at: Date.now(), msg: `Content-Type from Flowise: ${ct}` });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      sseEvent(res, 'run.error', { id: runId, error: `Prediction API ${resp.status}: ${text}` });
      sseEvent(res, 'run.completed', { id: runId });
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const lastState: Record<string, any> = {};
    const emittedContentKeys = new Set<string>();
    const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h.toString(36); };

    const handleExecutedNode = (node: any) => {
      const nodeId = node?.nodeId || node?.data?.id || '';
      const nodeLabel = node?.nodeLabel || node?.data?.name;
      if (node?.data?.state) emitStateDiff(res, lastState, node.data.state, { nodeId, nodeLabel });
      if (Array.isArray(node?.data?.input?.agentUpdateState)) {
        const next: any = {}; node.data.input.agentUpdateState.forEach((u: any) => { if (u.key) next[u.key] = u.value; });
        if (Object.keys(next).length) emitStateDiff(res, lastState, next, { nodeId, nodeLabel });
      }
      const content = node?.data?.output?.content;
      if (typeof content === 'string' && content.trim()) {
        const k = `${nodeId}:${hash(content)}`;
        if (!emittedContentKeys.has(k)) { emittedContentKeys.add(k); emitChunked(res, messageId, content); }
      }
    };

    const handleEnvelope = (obj: any): boolean => {
      const ev = obj?.event, data = obj?.data;
      if (ev === 'metadata' && data) { sseEvent(res, 'status.update', { at: Date.now(), metadata: data }); return true; }
      if (ev === 'nextAgentFlow' && data) {
        sseEvent(res, 'status.update', { at: Date.now(), node: { nodeId: data.nodeId, nodeLabel: data.nodeLabel, status: data.status } });
        return true;
      }
      if (ev === 'agentFlowExecutedData' && Array.isArray(data) && data.length) { handleExecutedNode(data[data.length - 1]); return true; }
      if (data?.state) { emitStateDiff(res, lastState, data.state); return true; }
      if (data?.output?.content) {
        const k = `__out:${hash(data.output.content)}`;
        if (!emittedContentKeys.has(k)) { emittedContentKeys.add(k); emitChunked(res, messageId, data.output.content); }
        return true;
      }
      return false;
    };

    const handleDataPayload = (raw: string) => {
      const s = raw.trim(); if (!s) return;
      if (s === '[DONE]') { sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' }); sseEvent(res, 'run.completed', { id: runId }); res.end(); return 'DONE'; }
      if (isControlToken(s)) return;
      try {
        const chunk = JSON.parse(s);
        if (chunk?.event || chunk?.data?.state || chunk?.data?.output?.content) { if (handleEnvelope(chunk)) return; }
        const token = chunk?.text || chunk?.delta?.content || chunk?.data?.content || chunk?.data;
        if (typeof token === 'string' && token.trim() && !isControlToken(token)) {
          const k = `__free:${hash(token)}`;
          if (!emittedContentKeys.has(k)) { emittedContentKeys.add(k); emitChunked(res, messageId, token); }
        }
      } catch {
        if (!isControlToken(s)) {
          const k = `__raw:${hash(s)}`;
          if (!emittedContentKeys.has(k)) { emittedContentKeys.add(k); emitChunked(res, messageId, s); }
        }
      }
    };

    const processLine = (line: string) => {
      let l = line.trim(); if (!l) return;
      if (l.startsWith('message:')) l = l.slice('message:'.length).trim();
      if (l.startsWith('data:')) { const raw = l.slice('data:'.length).trim(); return handleDataPayload(raw); }
    };

    const reader = (resp.body as any).getReader?.();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx; while ((idx = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1); if (processLine(line) === 'DONE') return; }
      }
    } else {
      for await (const chunk of resp.body as any) {
        buffer += chunk.toString();
        let idx; while ((idx = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1); if (processLine(line) === 'DONE') return; }
      }
    }

    sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
    sseEvent(res, 'run.completed', { id: runId });
    res.end();
  } catch (err: any) {
    sseEvent(res, 'run.error', { id: runId, error: String(err?.message || err) });
    sseEvent(res, 'run.completed', { id: runId });
    res.end();
  }
});

app.listen(PORT, () => console.log(`AG-UI adapter running on http://localhost:${PORT}`));
