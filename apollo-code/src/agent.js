import { toolSchemas } from './tools/index.js';
import { parseToolCalls, hasCompleteToolCall } from './protocol/text-tools.js';
import { needsCompaction, compact, usageReport } from './context.js';
import { summarizeArgs } from './ui.js';
import { ProviderError } from './providers/index.js';
import { CheckpointStore } from './checkpoints.js';

/**
 * Holds back the tail of a stream that might be the beginning of a tool block,
 * so the raw protocol never shows up in the user's terminal.
 */
export class StreamFilter {
  constructor(marker = '<apollo:tool') {
    this.marker = marker;
    this.buffer = '';
    this.suppressing = false;
  }

  feed(delta) {
    if (this.suppressing) return '';
    this.buffer += delta;

    let searchFrom = 0;
    for (;;) {
      const idx = this.buffer.indexOf(this.marker, searchFrom);
      if (idx === -1) break;

      const after = idx + this.marker.length;
      if (after >= this.buffer.length) {
        // Can't yet tell an opening tag from a word starting the same way;
        // hold everything from here until the next chunk settles it.
        const visible = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx);
        return visible;
      }
      if (/[\s>]/.test(this.buffer[after])) {
        const visible = this.buffer.slice(0, idx);
        this.suppressing = true;
        this.buffer = '';
        return visible;
      }
      // Something like "<apollo:toolbox" — prose, not a call. Keep looking.
      searchFrom = idx + 1;
    }

    // Hold back any trailing text that could still grow into the marker.
    const hold = longestSuffixPrefix(this.buffer, this.marker);
    const visible = this.buffer.slice(0, this.buffer.length - hold);
    this.buffer = this.buffer.slice(this.buffer.length - hold);
    return visible;
  }

  flush() {
    if (this.suppressing) return '';
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }
}

function longestSuffixPrefix(text, marker) {
  const max = Math.min(text.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (text.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

export class Agent {
  constructor({ config, provider, workspace, registry, permissions, ui, session, toolMode, rebuildSystem, checkpoints }) {
    this.config = config;
    this.provider = provider;
    this.workspace = workspace;
    this.registry = registry;
    this.permissions = permissions;
    this.ui = ui;
    this.session = session;
    this.toolMode = toolMode;
    this.rebuildSystem = rebuildSystem;
    this.state = { todos: session.todos || [], reads: new Map() };
    this.checkpoints = checkpoints ?? new CheckpointStore({ root: workspace.root });
    this.aborted = false;
  }

  get toolContext() {
    return {
      workspace: this.workspace,
      config: this.config,
      ui: this.ui,
      state: this.state,
    };
  }

  setSystemPrompt(text) {
    const system = { role: 'system', content: text };
    if (this.session.messages[0]?.role === 'system') this.session.messages[0] = system;
    else this.session.messages.unshift(system);
  }

  /** Run one user turn to completion (through however many tool steps it takes). */
  async run(userInput, { signal } = {}) {
    this.session.messages.push({ role: 'user', content: userInput });
    this.session.usage.turns++;

    let finalText = '';
    for (let step = 0; step < this.config.maxSteps; step++) {
      if (signal?.aborted) break;

      if (needsCompaction(this.session.messages, this.config)) {
        await this.#compact();
      }

      const turn = await this.#streamTurn({ signal });
      finalText = turn.text;

      if (turn.calls.length === 0) {
        if (turn.parseErrors.length) {
          // The model tried to call a tool and produced malformed JSON; tell it
          // so, rather than ending the turn on a broken block.
          this.session.messages.push({
            role: 'user',
            content:
              `Your tool block could not be parsed: ${turn.parseErrors.join('; ')}. ` +
              'Emit the block again with a single valid JSON object as the body.',
          });
          continue;
        }
        break;
      }

      const results = await this.#executeCalls(turn.calls, { signal });
      this.#recordToolResults(turn.calls, results);

      if (results.some((r) => r.interrupted)) break;

      if (step === this.config.maxSteps - 1) {
        this.ui.warn(`Stopped after ${this.config.maxSteps} steps. Ask me to continue if it needs more.`);
      }
    }

    this.session.todos = this.state.todos;
    return finalText;
  }

  async #compact() {
    this.ui.info('Context is getting full — compacting…');
    const result = await compact(this.session.messages, this.provider);
    if (result.compacted) {
      this.session.messages = result.messages;
      this.ui.info(`Compacted, freed ~${result.freed} tokens.`);
    }
  }

  /** One provider round-trip: stream text, collect tool calls. */
  async #streamTurn({ signal }) {
    const native = this.toolMode === 'native';
    const tools = native ? toolSchemas(this.registry) : null;
    const filter = new StreamFilter();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let raw = '';
    let visible = '';
    const calls = [];
    let started = false;

    this.ui.startSpinner('thinking');
    try {
      const stream = this.provider.chat({
        messages: this.session.messages,
        tools,
        signal: controller.signal,
      });

      for await (const event of stream) {
        if (event.type === 'text') {
          raw += event.delta;
          if (!started) { this.ui.stopSpinner(); started = true; }
          const shown = native ? event.delta : filter.feed(event.delta);
          if (shown) { this.ui.write(shown); visible += shown; }

          // In text mode the block is complete — no point generating further.
          if (!native && hasCompleteToolCall(raw)) {
            controller.abort();
            break;
          }
        } else if (event.type === 'thinking') {
          if (!started) { this.ui.stopSpinner(); started = true; }
          this.ui.write(this.ui.dim(event.delta));
        } else if (event.type === 'tool_call') {
          calls.push(event.call);
        } else if (event.type === 'usage') {
          this.session.usage.promptTokens += event.promptTokens || 0;
          this.session.usage.completionTokens += event.completionTokens || 0;
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        const recovered = await this.#maybeFallbackToText(err);
        if (recovered) return this.#streamTurn({ signal });
        throw err;
      }
    } finally {
      this.ui.stopSpinner();
      signal?.removeEventListener('abort', onAbort);
    }

    const tail = native ? '' : filter.flush();
    if (tail) { this.ui.write(tail); visible += tail; }
    this.ui.flushLine();

    let parseErrors = [];
    if (!native) {
      const parsed = parseToolCalls(raw);
      calls.push(...parsed.calls);
      parseErrors = parsed.errors;
    }

    // Record the assistant turn exactly as the model produced it, so it sees a
    // consistent history on the next round.
    const assistant = { role: 'assistant', content: raw };
    if (native && calls.length) {
      assistant.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
    }
    this.session.messages.push(assistant);

    return { text: (native ? raw : visible).trim(), calls, parseErrors };
  }

  /**
   * A server that rejects the request because of tools is recoverable: drop to
   * the text protocol, rebuild the system prompt, and try again once.
   */
  async #maybeFallbackToText(err) {
    const isToolProblem = err instanceof ProviderError
      && this.toolMode === 'native'
      && this.config.toolMode === 'auto'
      && /tool|function/i.test(String(err.message) + String(err.hint || ''));
    if (!isToolProblem) return false;

    this.ui.warn('This model rejected native tool calling — switching to the text protocol.');
    this.toolMode = 'text';
    this.setSystemPrompt(this.rebuildSystem('text'));
    // The failed request left no assistant turn behind, so history is intact.
    return true;
  }

  async #executeCalls(calls, { signal }) {
    const results = [];
    for (const call of calls) {
      if (signal?.aborted) {
        results.push({ call, content: 'Interrupted by the user.', interrupted: true });
        continue;
      }
      results.push(await this.#executeOne(call));
    }
    return results;
  }

  async #executeOne(call) {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const available = [...this.registry.keys()].join(', ');
      this.ui.toolCall(call.name, '');
      this.ui.toolResult(`no such tool`, { isError: true });
      return { call, content: `Error: no tool named "${call.name}". Available tools: ${available}.`, isError: true };
    }

    this.ui.toolCall(tool.name, summarizeArgs(tool.name, call.args));

    // Build the approval preview first: it also validates the arguments, so a
    // bad edit fails before the user is asked about it.
    let preview = null;
    if (!tool.readOnly && tool.preview) {
      try {
        preview = tool.preview(call.args, this.toolContext);
      } catch (err) {
        this.ui.toolResult(err.message, { isError: true });
        return { call, content: `Error: ${err.message}`, isError: true };
      }
    }

    const decision = await this.permissions.check(tool, call.args, preview);
    if (!decision.allow) {
      this.ui.toolResult(decision.reason, { isError: true });
      return { call, content: `Denied: ${decision.reason}`, isError: true, denied: true };
    }

    // Snapshot before the change, not after, so /undo can always get back.
    let snapshot = null;
    if (tool.affects) {
      try {
        snapshot = this.checkpoints.capture(tool.affects(call.args, this.toolContext));
      } catch { /* an unresolvable path fails in run() with a better message */ }
    }

    try {
      const content = await tool.run(call.args, this.toolContext);
      if (snapshot) {
        this.checkpoints.commit(`${tool.name} ${call.args.path ?? ''}`.trim(), snapshot);
      }
      this.ui.toolResult(summarizeResult(tool.name, content));
      return { call, content: String(content) };
    } catch (err) {
      this.ui.toolResult(err.message, { isError: true });
      return { call, content: `Error: ${err.message}`, isError: true };
    }
  }

  #recordToolResults(calls, results) {
    if (this.toolMode === 'native') {
      for (const result of results) {
        this.session.messages.push({
          role: 'tool',
          tool_call_id: result.call.id,
          name: result.call.name,
          content: result.content,
        });
      }
      return;
    }
    // Text protocol: results come back as a user turn the chat template can
    // always render, whatever the model's template supports.
    const body = results
      .map((r) => `<apollo:result name="${r.call.name}">\n${r.content}\n</apollo:result>`)
      .join('\n\n');
    this.session.messages.push({ role: 'user', content: body });
  }

  usage() {
    return usageReport(this.session.messages, this.config);
  }
}

function summarizeResult(name, content) {
  const text = String(content);
  const lines = text.split('\n');
  if (name === 'read_file') return `${lines.length} lines`;
  if (lines.length > 4) return `${lines.slice(0, 3).join('\n')}\n… ${lines.length - 3} more lines`;
  return text;
}
