import express from 'express';
import cors from 'cors';

// ⚠️ IMPORTANTE: no uses `node-fetch`, ya que Node 18+ trae `fetch` nativo (Undici).
// Si lo tenías instalado, puedes desinstalarlo con: npm uninstall node-fetch

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const FLOWISE_BASE_URL = process.env.FLOWISE_BASE_URL || 'http://localhost:3000';
const FLOWISE_API_KEY  = process.env.FLOWISE_API_KEY  || '';
const PORT = Number(process.env.PORT || 8787);

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * SSE endpoint: traduce el stream SSE de Flowise a eventos AG-UI.
 * GET /agui/stream?chatflowId=...&q=...
 */
app.get('/agui/stream', async (req, res) => {
  const chatflowId = String(req.query.chatflowId || '');
  const question   = String(req.query.q || '');
  const runId      = 'run_' + Date.now();
  const messageId  = 'msg_' + Date.now();

  if (!chatflowId || !question) {
    res.status(400).json({ error: 'chatflowId y q son obligatorios' });
    return;
  }

  // Configuración de SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Emitimos run.input
  sendEvent('run.input', {
    id: runId,
    messages: [{ id: 'user_' + Date.now(), role: 'user', content: question }]
  });

  try {
    const url = `${FLOWISE_BASE_URL}/api/v1/prediction/${encodeURIComponent(chatflowId)}`;
    // En algunos despliegues se usa "stream: true" en lugar de "streaming: true".
    const body: Record<string, any> = { question, stream: true };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FLOWISE_API_KEY ? { 'Authorization': `Bearer ${FLOWISE_API_KEY}` } : {}),
        'Accept': 'text/event-stream'
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

    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') {
        sendEvent('message.completed', { id: messageId, role: 'assistant' });
        sendEvent('run.completed', { id: runId });
        res.end();
        return 'DONE';
      }
      try {
        const chunk = JSON.parse(raw);
        const token = typeof chunk === 'string' ? chunk : (chunk.text ?? '');
        if (token) sendEvent('message.delta', { id: messageId, delta: { content: token } });
      } catch {
        sendEvent('message.delta', { id: messageId, delta: { content: raw } });
      }
    };

    // --- Caso 1: Web Streams (Undici en Node 18/20) ---
    if (typeof (resp.body as any).getReader === 'function') {
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
    } else {
      // --- Caso 2: Node Readable Stream clásico ---
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
    }

  } catch (err: any) {
    sendEvent('run.error', { id: runId, error: String(err?.message || err) });
    sendEvent('message.error', { id: messageId, error: 'Unexpected streaming error' });
    sendEvent('run.completed', { id: runId });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`AG-UI adapter running on http://localhost:${PORT}`);
});
