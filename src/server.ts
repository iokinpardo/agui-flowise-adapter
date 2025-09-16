import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const FLOWISE_BASE_URL = process.env.FLOWISE_BASE_URL || 'http://localhost:3000';
const FLOWISE_API_KEY  = process.env.FLOWISE_API_KEY  || '';
const PORT = Number(process.env.PORT || 8787);

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/agui/stream', async (req, res) => {
  const chatflowId = String(req.query.chatflowId || '');
  const question   = String(req.query.q || '');
  const runId      = 'run_' + Date.now();
  const messageId  = 'msg_' + Date.now();
  if (!chatflowId or not question) {
    res.status(400).json({ error: 'chatflowId y q son obligatorios' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  sendEvent('run.input', {
    id: runId,
    messages: [{ id: 'user_' + Date.now(), role: 'user', content: question }]
  });

  try {
    const url = `${FLOWISE_BASE_URL}/api/v1/prediction/${encodeURIComponent(chatflowId)}`;
    const body = { question, streaming: true };
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FLOWISE_API_KEY ? { 'Authorization': `Bearer ${FLOWISE_API_KEY}` } : {})
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text();
      sendEvent('run.error', { id: runId, error: `Prediction API ${resp.status}: ${text}` });
      sendEvent('message.error', { id: messageId, error: `Prediction API error` });
      sendEvent('run.completed', { id: runId });
      res.end();
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') {
          sendEvent('message.completed', { id: messageId, role: 'assistant' });
          sendEvent('run.completed', { id: runId });
          finished = true;
          res.end();
          break;
        }
        try {
          const chunk = JSON.parse(raw);
          const token = typeof chunk === 'string' ? chunk : (chunk.text ?? '');
          if (token) {
            sendEvent('message.delta', { id: messageId, delta: { content: token } });
          }
        } catch {
          sendEvent('message.delta', { id: messageId, delta: { content: raw } });
        }
      }
    }
  } catch (err) {
    sendEvent('run.error', { id: runId, error: String(err?.message || err) });
    sendEvent('message.error', { id: messageId, error: 'Unexpected streaming error' });
    sendEvent('run.completed', { id: runId });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`AG-UI adapter running on http://localhost:${PORT}`);
});
