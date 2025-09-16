import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const FLOWISE_BASE_URL = process.env.FLOWISE_BASE_URL || 'http://localhost:3000';
const FLOWISE_API_KEY  = process.env.FLOWISE_API_KEY  || '';
const PORT = Number(process.env.PORT || 8787);

// ------------------- Utils -------------------

function sseEvent(res: any, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function extractFinalText(payload: any): string {
  if (Array.isArray(payload)) {
    if (payload[0]?.text) return String(payload[0].text);
    const exec = payload[0]?.agentFlowExecutedData;
    if (Array.isArray(exec)) {
      const directReply = exec.find((n: any) =>
        n?.data?.name === 'directReplyAgentflow' && n?.data?.output?.content
      );
      if (directReply) return String(directReply.data.output.content);
    }
    return JSON.stringify(payload);
  }
  if (typeof payload === 'object' && payload) {
    if (payload.text) return String(payload.text);
    if (payload.data?.output?.content) return String(payload.data.output.content);
  }
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

// ------------------- Endpoint -------------------

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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });

  // Emit run.input
  sseEvent(res, 'run.input', {
    id: runId,
    messages: [{ id: 'user_' + Date.now(), role: 'user', content: question }]
  });

  try {
    const url = `${FLOWISE_BASE_URL}/api/v1/prediction/${encodeURIComponent(chatflowId)}`;
    const body: Record<string, any> = { question, stream: true, streaming: true };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FLOWISE_API_KEY ? { 'Authorization': `Bearer ${FLOWISE_API_KEY}` } : {}),
        'Accept': 'text/event-stream, application/json;q=0.9, */*;q=0.1'
      },
      body: JSON.stringify(body),
    });

    const ct = resp.headers.get('content-type') || '';
    const isSSE = ct.includes('text/event-stream');

    // --- Caso SSE real ---
    if (isSSE && resp.body && typeof (resp.body as any).getReader === 'function') {
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
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') {
            sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
            sseEvent(res, 'run.completed', { id: runId });
            res.end();
            return;
          }
          try {
            const chunk = JSON.parse(raw);
            const token = chunk.text ?? '';
            if (token) {
              sseEvent(res, 'message.delta', { id: messageId, delta: { content: token } });
            }
          } catch {
            sseEvent(res, 'message.delta', { id: messageId, delta: { content: raw } });
          }
        }
      }
      return;
    }

    // --- Caso JSON no-SSE ---
    const rawText = await resp.text();
    const json = JSON.parse(rawText);

    // 1) Extraer herramientas
    const exec = Array.isArray(json) ? json[0]?.agentFlowExecutedData : json.agentFlowExecutedData;
    if (Array.isArray(exec)) {
      for (const node of exec) {
        const id = node.nodeId;
        const label = node.nodeLabel || node.data?.name;

        // Emitir tool.call / tool.result
        if (node.data?.name?.includes('toolAgentflow')) {
          if (node.data?.input?.toolInputArgs) {
            const params: Record<string, any> = {};
            for (const arg of node.data.input.toolInputArgs) {
              params[arg.inputArgName] = arg.inputArgValue;
            }
            sseEvent(res, 'tool.call', { id, name: label, parameters: params });
          }
          if (node.data?.output?.content) {
            sseEvent(res, 'tool.result', { id, result: node.data.output.content });
          }
        }

        // Emitir state.patch (flow.state)
        if (node.data?.state) {
          sseEvent(res, 'state.patch', { patch: node.data.state });
        }
      }
    }

    // 2) Extraer mensaje final
    const final = extractFinalText(json);
    if (final) {
      sseEvent(res, 'message.delta', { id: messageId, delta: { content: final } });
    }

    sseEvent(res, 'message.completed', { id: messageId, role: 'assistant' });
    sseEvent(res, 'run.completed', { id: runId });
    res.end();

  } catch (err: any) {
    sseEvent(res, 'run.error', { id: runId, error: String(err?.message || err) });
    sseEvent(res, 'message.error', { id: messageId, error: 'Unexpected streaming error' });
    sseEvent(res, 'run.completed', { id: runId });
    res.end();
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`AG-UI adapter running on http://localhost:${PORT}`);
});
