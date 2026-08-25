import { request, streamSse, ProviderError } from './http.js';

/**
 * OpenAI-compatible /v1/chat/completions. Covers llama.cpp's server, LM Studio,
 * vLLM, text-generation-webui, LocalAI — anything speaking that dialect,
 * including a remote endpoint if you point baseUrl at one.
 */
export class OpenAICompatProvider {
  constructor(config) {
    this.config = config;
    this.name = 'openai';
  }

  get headers() {
    return {
      authorization: `Bearer ${this.config.apiKey || 'local'}`,
    };
  }

  async health() {
    const res = await request(`${this.config.baseUrl}/v1/models`, { headers: this.headers, timeoutMs: 5000 });
    await res.json();
    return { ok: true };
  }

  async listModels() {
    const res = await request(`${this.config.baseUrl}/v1/models`, { headers: this.headers, timeoutMs: 15000 });
    const body = await res.json();
    return (body.data || []).map((m) => ({ id: m.id, family: m.owned_by }));
  }

  async supportsTools() {
    // No portable capability probe exists across these servers, so assume yes
    // and let toolMode 'auto' fall back if the first call errors on tools.
    return true;
  }

  #toWire(messages) {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id, name: m.name };
      }
      const out = { role: m.role, content: m.content || '' };
      if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
      return out;
    });
  }

  async *chat({ messages, tools, signal }) {
    const body = {
      model: this.config.model,
      messages: this.#toWire(messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: this.config.temperature,
      top_p: this.config.topP,
      max_tokens: this.config.maxTokens,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const res = await request(`${this.config.baseUrl}/v1/chat/completions`, {
      method: 'POST', body, headers: this.headers, signal,
    });

    // Tool calls arrive as deltas keyed by index and must be reassembled.
    const pending = new Map();
    let usage = null;

    for await (const frame of streamSse(res)) {
      if (frame.error) {
        const message = frame.error.message || String(frame.error);
        throw new ProviderError(`server: ${message}`, {
          hint: /tool|function/i.test(message)
            ? 'This server or model may not support tools — rerun with --tool-mode text.'
            : undefined,
        });
      }
      if (frame.usage) {
        usage = {
          promptTokens: frame.usage.prompt_tokens || 0,
          completionTokens: frame.usage.completion_tokens || 0,
        };
      }

      const choice = frame.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) yield { type: 'text', delta: delta.content };
      if (delta.reasoning_content && this.config.showThinking) {
        yield { type: 'thinking', delta: delta.reasoning_content };
      }

      for (const tc of delta.tool_calls || []) {
        const key = tc.index ?? pending.size;
        const entry = pending.get(key) || { id: '', name: '', argText: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.argText += tc.function.arguments;
        pending.set(key, entry);
      }

      if (choice.finish_reason) {
        for (const [key, entry] of pending) {
          if (!entry.name) continue;
          yield {
            type: 'tool_call',
            call: {
              id: entry.id || `call_${key}_${entry.name}`,
              name: entry.name,
              args: parseArgs(entry.argText),
            },
          };
        }
        pending.clear();
        yield {
          type: 'usage',
          promptTokens: usage?.promptTokens || 0,
          completionTokens: usage?.completionTokens || 0,
          reason: choice.finish_reason,
        };
      }
    }
  }
}

function parseArgs(text) {
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      throw new ProviderError(`model produced invalid tool arguments: ${text.slice(0, 200)}`);
    }
  }
}
