export class ProviderError extends Error {
  constructor(message, { status, cause, hint } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.cause = cause;
    this.hint = hint;
  }
}

/** fetch with a timeout and error messages that say what to do next. */
export async function request(url, { method = 'GET', body, headers = {}, signal, timeoutMs = 600000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `${method} ${url} failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 400)}` : ''}`,
        { status: res.status, hint: hintForStatus(res.status) }
      );
    }
    return res;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`could not reach ${url}: ${err.message}`, {
      cause: err,
      hint: 'Is your local model server running? Try `apollo doctor`.',
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function hintForStatus(status) {
  if (status === 404) return 'The model or endpoint was not found. Check `apollo models` for what is installed.';
  if (status === 401 || status === 403) return 'The server wants an API key — set apiKey in config or APOLLO_API_KEY.';
  if (status === 400) return 'The server rejected the request. If your model lacks native tool support, try --tool-mode text.';
  return undefined;
}

/** Yield complete lines from a streaming response body. */
export async function* streamLines(res) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer.trim();
}

/** Yield parsed JSON payloads from a Server-Sent Events stream. */
export async function* streamSse(res) {
  for await (const line of streamLines(res)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    try {
      yield JSON.parse(payload);
    } catch { /* keep-alive or partial frame — ignore */ }
  }
}
