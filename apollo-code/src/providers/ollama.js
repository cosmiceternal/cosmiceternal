import { request, streamLines, ProviderError } from './http.js';

/**
 * Ollama's native API (http://127.0.0.1:11434). Handles tool calls when the
 * model supports them, and reports back when it doesn't so the agent can fall
 * back to the text protocol.
 */
export class OllamaProvider {
  constructor(config) {
    this.config = config;
    this.name = 'ollama';
  }

  get headers() {
    return this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {};
  }

  async health() {
    const res = await request(`${this.config.baseUrl}/api/version`, { headers: this.headers, timeoutMs: 5000 });
    const body = await res.json();
    return { ok: true, version: body.version };
  }

  async listModels() {
    const res = await request(`${this.config.baseUrl}/api/tags`, { headers: this.headers, timeoutMs: 15000 });
    const body = await res.json();
    return (body.models || []).map((m) => ({
      id: m.name,
      size: m.size,
      family: m.details?.family,
      parameters: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
    }));
  }

  /**
   * The model's real maximum context, from its GGUF metadata. Asking for a
   * larger num_ctx than the model was trained for either errors or silently
   * degrades, and getting this wrong is the most common local-setup mistake.
   */
  async contextLength(model = this.config.model) {
    try {
      const res = await request(`${this.config.baseUrl}/api/show`, {
        method: 'POST', body: { model }, headers: this.headers, timeoutMs: 15000,
      });
      const info = (await res.json()).model_info || {};
      // The key is architecture-prefixed: llama.context_length, qwen2.context_length…
      const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
      const value = key ? Number(info[key]) : NaN;
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** Ask Ollama for the model's declared capabilities; "tools" means native calling. */
  async supportsTools(model = this.config.model) {
    try {
      const res = await request(`${this.config.baseUrl}/api/show`, {
        method: 'POST', body: { model }, headers: this.headers, timeoutMs: 15000,
      });
      const body = await res.json();
      if (Array.isArray(body.capabilities)) return body.capabilities.includes('tools');
      // Older Ollama builds have no capabilities field; the template is the tell.
      return typeof body.template === 'string' && /tools?/i.test(body.template);
    } catch {
      return false;
    }
  }

  #toWire(messages) {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_name: m.name };
      }
      const out = { role: m.role, content: m.content || '' };
      if (m.tool_calls?.length) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          function: {
            name: tc.function.name,
            arguments: safeParse(tc.function.arguments),
          },
        }));
      }
      return out;
    });
  }

  /**
   * @returns {AsyncGenerator<{type:'text',delta:string}|{type:'tool_call',call:object}|{type:'usage',...}>}
   */
  async *chat({ messages, tools, signal }) {
    const body = {
      model: this.config.model,
      messages: this.#toWire(messages),
      stream: true,
      // Hold the model in VRAM between turns. Without this Ollama unloads it
      // after a few idle minutes and the next message pays the full reload.
      keep_alive: this.config.keepAlive,
      options: {
        temperature: this.config.temperature,
        top_p: this.config.topP,
        num_ctx: this.config.contextTokens,
        num_predict: this.config.maxTokens,
      },
    };
    if (tools?.length) body.tools = tools;

    const res = await request(`${this.config.baseUrl}/api/chat`, {
      method: 'POST', body, headers: this.headers, signal,
    });

    let seq = 0;
    for await (const line of streamLines(res)) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }

      if (frame.error) {
        throw new ProviderError(`ollama: ${frame.error}`, {
          hint: /tool/i.test(frame.error)
            ? 'This model does not support native tool calling — rerun with --tool-mode text.'
            : undefined,
        });
      }

      const message = frame.message;
      if (message?.content) yield { type: 'text', delta: message.content };
      if (message?.thinking && this.config.showThinking) {
        yield { type: 'thinking', delta: message.thinking };
      }

      for (const tc of message?.tool_calls || []) {
        yield {
          type: 'tool_call',
          call: {
            id: tc.id || `call_${++seq}_${tc.function?.name}`,
            name: tc.function?.name,
            args: typeof tc.function?.arguments === 'string'
              ? safeParse(tc.function.arguments)
              : (tc.function?.arguments || {}),
          },
        };
      }

      if (frame.done) {
        yield {
          type: 'usage',
          promptTokens: frame.prompt_eval_count || 0,
          completionTokens: frame.eval_count || 0,
          reason: frame.done_reason,
        };
      }
    }
  }
}

function safeParse(value) {
  if (typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch { return {}; }
}
