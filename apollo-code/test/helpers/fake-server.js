import http from 'node:http';

/**
 * A scripted stand-in for a local model server. Each entry in `turns` is one
 * assistant reply: { text?: string, toolCalls?: [{name, args}] }. Handlers pop
 * turns in order so a test can drive a multi-step agent loop deterministically.
 */
export function startFakeOllama({ turns = [], capabilities = ['tools'], contextLength = null } = {}) {
  const requests = [];
  const queue = [...turns];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: parsed });

      if (req.url === '/api/version') return json(res, { version: '0.5.0-fake' });
      if (req.url === '/api/tags') {
        return json(res, { models: [{ name: 'fake-coder:7b', size: 1e9, details: { family: 'qwen2' } }] });
      }
      if (req.url === '/api/show') {
        return json(res, {
          capabilities,
          template: '{{ .Prompt }}',
          model_info: contextLength ? { 'qwen2.context_length': contextLength } : {},
        });
      }

      if (req.url === '/api/generate') return json(res, { model: parsed.model, done: true });

      if (req.url === '/api/chat') {
        const turn = queue.shift() || { text: 'done' };
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const chunk of chunkText(turn.text || '')) {
          res.write(JSON.stringify({ message: { role: 'assistant', content: chunk }, done: false }) + '\n');
        }
        if (turn.toolCalls?.length) {
          res.write(JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: turn.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } })),
            },
            done: false,
          }) + '\n');
        }
        res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 7 }) + '\n');
        return res.end();
      }
      res.writeHead(404).end();
    });
  });

  return listen(server, { requests, remaining: () => queue.length });
}

export function startFakeOpenAI({ turns = [] } = {}) {
  const requests = [];
  const queue = [...turns];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: parsed });

      if (req.url === '/v1/models') return json(res, { data: [{ id: 'fake-coder', owned_by: 'local' }] });

      if (req.url === '/v1/chat/completions') {
        const turn = queue.shift() || { text: 'done' };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

        for (const chunk of chunkText(turn.text || '')) {
          send({ choices: [{ index: 0, delta: { content: chunk } }] });
        }
        // Tool call arguments arrive split across frames, as real servers do.
        (turn.toolCalls || []).forEach((tc, index) => {
          const argText = JSON.stringify(tc.args);
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${index}`, function: { name: tc.name, arguments: '' } }] } }] });
          for (const piece of chunkText(argText, 5)) {
            send({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] } }] });
          }
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(404).end();
    });
  });

  return listen(server, { requests, remaining: () => queue.length });
}

function chunkText(text, size = 8) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function json(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function listen(server, extra) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        ...extra,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Collects UI output so assertions can look at what the user would have seen. */
export function captureStream() {
  const chunks = [];
  return {
    isTTY: false,
    write: (s) => { chunks.push(s); return true; },
    get text() { return chunks.join(''); },
  };
}
