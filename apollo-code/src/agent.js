import { toolSchemas, buildRegistry } from './tools/index.js';
import { parseToolCalls, parseLooseToolCalls, hasCompleteToolCall } from './protocol/text-tools.js';
import { ReasoningFilter } from './protocol/reasoning.js';
import { needsCompaction, compact, usageReport, conversationTokens, TokenCalibration } from './context.js';
import { summarizeArgs, NestedUI } from './ui.js';
import { normalizeArgs } from './tools/normalize.js';
import { tracer } from './trace.js';
import { ProviderError } from './providers/index.js';
import { CheckpointStore } from './checkpoints.js';
import { MarkdownStream } from './markdown.js';

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
  constructor({ config, provider, workspace, registry, permissions, ui, session, toolMode, rebuildSystem, checkpoints, depth = 0 }) {
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
    this.depth = depth;
    this.calibration = new TokenCalibration();
    this.overflowRecovered = false;
    this.toolLog = [];
    this.aborted = false;
  }

  get toolContext() {
    return {
      workspace: this.workspace,
      config: this.config,
      ui: this.ui,
      state: this.state,
      runSubAgent: (prompt, options) => this.#runSubAgent(prompt, options),
    };
  }

  /**
   * Run a focused, read-only agent in its own context and return only its
   * answer. The point is context economy: twenty greps to locate something cost
   * the main conversation one paragraph instead of twenty tool results.
   */
  async #runSubAgent(prompt, { label = 'researching' } = {}) {
    if (this.depth >= 1) {
      throw new Error('a sub-agent cannot start another sub-agent — answer directly');
    }

    const ui = new NestedUI(this.ui);
    ui.toolCall('task', label);

    const sub = new Agent({
      config: { ...this.config, maxSteps: Math.max(4, Math.floor(this.config.maxSteps / 2)) },
      provider: this.provider,
      workspace: this.workspace,
      registry: buildRegistry({ readOnly: true, nested: true }),
      permissions: this.permissions,
      ui,
      session: { messages: [], usage: { promptTokens: 0, completionTokens: 0, turns: 0 }, todos: [] },
      toolMode: this.toolMode,
      rebuildSystem: () => SUB_AGENT_PROMPT,
      checkpoints: this.checkpoints,
      depth: this.depth + 1,
    });
    sub.setSystemPrompt(`${SUB_AGENT_PROMPT}\n\n# Environment\n\nWorking directory: ${this.workspace.root}`);

    const answer = await sub.run(prompt);

    // The sub-agent's token spend is still the user's token spend.
    this.session.usage.promptTokens += sub.session.usage.promptTokens;
    this.session.usage.completionTokens += sub.session.usage.completionTokens;
    return answer;
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
    this.overflowRecovered = false;
    // Group everything this turn changes, so /undo turn can revert it as one.
    this.checkpoints.beginTurn(this.session.usage.turns);

    let finalText = '';
    let parseFailures = 0;
    let repeats = 0;
    let lastSignature = null;

    for (let step = 0; step < this.config.maxSteps; step++) {
      if (signal?.aborted) break;

      if (needsCompaction(this.session.messages, this.config, this.calibration)) {
        await this.#compact();
      }

      const turn = await this.#streamTurn({ signal });
      // Keep the last turn that actually said something: if the model spends
      // its final steps on tool calls, an empty string is not the answer.
      if (turn.text) finalText = turn.text;

      if (turn.calls.length === 0) {
        if (turn.parseErrors.length && ++parseFailures <= MAX_PARSE_RETRIES) {
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
        if (turn.parseErrors.length) {
          // Repeatedly malformed: stop correcting and let the user see it.
          this.ui.warn('The model kept emitting malformed tool calls — stopping this turn.');
        }
        break;
      }
      parseFailures = 0;

      const results = await this.#executeCalls(turn.calls, { signal });
      this.#recordToolResults(turn.calls, results);

      if (results.some((r) => r.interrupted)) break;

      // A smaller model will sometimes loop on the same call forever. Say so
      // rather than silently burning the step budget.
      const signature = signatureOf(turn.calls);
      repeats = signature === lastSignature ? repeats + 1 : 0;
      lastSignature = signature;
      if (repeats + 1 >= MAX_IDENTICAL_CALLS) {
        this.session.messages.push({
          role: 'user',
          content:
            `You have now made the same tool call ${repeats + 1} times and received the same result. ` +
            'It will not change. Use what you already have to answer, or try a different approach.',
        });
        repeats = 0;
      }

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
    const reasoning = new ReasoningFilter({ show: this.config.showThinking });
    const markdown = new MarkdownStream(this.ui);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let raw = '';
    let visible = '';
    const calls = [];
    let started = false;

    // --no-stream keeps the wire protocol streaming (that is how these servers
    // work) but holds rendering until the reply is complete, which is what you
    // want when piping output or reading a finished answer rather than watching
    // it type.
    const live = this.config.stream;
    let held = '';
    const render = (text) => { if (live) markdown.write(text); else held += text; };

    this.ui.startSpinner('thinking');
    try {
      const stream = this.provider.chat({
        messages: this.session.messages,
        tools,
        signal: controller.signal,
      });

      for await (const event of stream) {
        if (event.type === 'text') {
          // Strip a reasoning model's scratchpad before anything else sees it:
          // it is neither prose for the user nor a tool call.
          const step = reasoning.feed(event.delta);
          if (step.thinking && live) this.ui.write(this.ui.dim(step.thinking));
          if (!step.visible) continue;

          raw += step.visible;
          if (!started && live) { this.ui.stopSpinner(); started = true; }
          const shown = native ? step.visible : filter.feed(step.visible);
          if (shown) { render(shown); visible += shown; }

          // In text mode the block is complete — no point generating further.
          if (!native && hasCompleteToolCall(raw)) {
            controller.abort();
            break;
          }
        } else if (event.type === 'thinking') {
          if (!started && live) { this.ui.stopSpinner(); started = true; }
          if (live) this.ui.write(this.ui.dim(event.delta));
        } else if (event.type === 'tool_call') {
          calls.push(event.call);
        } else if (event.type === 'usage') {
          this.session.usage.promptTokens += event.promptTokens || 0;
          this.session.usage.completionTokens += event.completionTokens || 0;
          // The request that was just answered is the message list as it stood
          // when this turn started — before the assistant reply is appended.
          this.calibration.observe(event.promptTokens, conversationTokens(this.session.messages));
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        if (await this.#maybeFallbackToText(err)) return this.#streamTurn({ signal });
        if (await this.#maybeRecoverFromOverflow(err)) return this.#streamTurn({ signal });
        throw err;
      }
    } finally {
      this.ui.stopSpinner();
      signal?.removeEventListener('abort', onAbort);
    }

    const leftover = reasoning.flush();
    if (leftover.thinking && live) this.ui.write(this.ui.dim(leftover.thinking));
    if (leftover.visible) {
      raw += leftover.visible;
      const shown = native ? leftover.visible : filter.feed(leftover.visible);
      if (shown) { render(shown); visible += shown; }
    }

    const tail = native ? '' : filter.flush();
    if (tail) { render(tail); visible += tail; }
    if (held) markdown.write(held);
    markdown.flush();
    this.ui.flushLine();

    if (tracer.enabled) tracer.event('turn', { native, rawLength: raw.length, raw });

    let parseErrors = [];
    if (!native) {
      const parsed = parseToolCalls(raw);
      calls.push(...parsed.calls);
      parseErrors = parsed.errors;

      // Some models ignore the tagged format and emit an OpenAI-style JSON call
      // instead. Accepting that costs nothing and saves a wasted turn.
      if (calls.length === 0 && parseErrors.length === 0) {
        const loose = parseLooseToolCalls(raw, new Set(this.registry.keys()));
        if (loose.calls.length) {
          calls.push(...loose.calls);
          visible = loose.text;
        }
      }
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

  /**
   * The server rejected the request as too long for the context window. That is
   * recoverable exactly once: compact the conversation and send it again.
   * Failing outright here would lose the session over an off-by-a-bit estimate.
   */
  async #maybeRecoverFromOverflow(err) {
    const message = String(err?.message || '') + String(err?.hint || '');
    const looksLikeOverflow = /context|too long|exceeds|n_ctx|token limit|prompt is too|maximum.*length/i.test(message);
    if (!looksLikeOverflow || this.overflowRecovered) return false;

    this.overflowRecovered = true;
    this.ui.warn('The server says the conversation is too long — compacting and retrying.');

    const result = await compact(this.session.messages, this.provider, { keepRecent: 4 });
    if (!result.compacted) {
      this.ui.warn('There was nothing left to compact.');
      return false;
    }
    this.session.messages = result.messages;
    // The estimate was wrong by at least this much; make it more pessimistic so
    // automatic compaction fires earlier from here on.
    this.calibration.observe(this.config.contextTokens, conversationTokens(result.messages));
    return true;
  }

  async #executeCalls(calls, { signal }) {
    const results = [];
    for (const call of calls) {
      if (signal?.aborted) {
        results.push({ call, content: 'Interrupted by the user.', interrupted: true });
        continue;
      }
      results.push(await this.#executeOne(call, signal));
    }
    return results;
  }

  async #executeOne(call, signal) {
    const startedAt = Date.now();
    const result = await this.#dispatch(call, signal);
    this.toolLog.push({
      name: call.name,
      args: call.args,
      ok: !result.isError,
      denied: Boolean(result.denied),
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  async #dispatch(call, signal) {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const available = [...this.registry.keys()].join(', ');
      this.ui.toolCall(call.name, '');
      this.ui.toolResult(`no such tool`, { isError: true });
      return { call, content: `Error: no tool named "${call.name}". Available tools: ${available}.`, isError: true };
    }

    // Small models get parameter names wrong constantly; rename what we can
    // recognise rather than spending a turn on the correction.
    const { args, renamed } = normalizeArgs(tool, call.args);
    call.args = args;

    if (tracer.enabled) tracer.event('tool_call', { name: tool.name, args: call.args, renamed });

    this.ui.toolCall(tool.name, summarizeArgs(tool.name, call.args));
    if (renamed.length) {
      this.ui.toolResult(
        `read ${renamed.map(([from, to]) => `${from} as ${to}`).join(', ')}`
      );
    }

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
      // The signal is per-call so Ctrl+C can kill a running command, not just
      // stop the loop after it finishes.
      const content = await tool.run(call.args, { ...this.toolContext, signal });
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
    return usageReport(this.session.messages, this.config, this.calibration);
  }
}

/** How many malformed tool blocks to correct before giving up on the turn. */
const MAX_PARSE_RETRIES = 3;

/** How many identical tool calls in a row before nudging the model. */
const MAX_IDENTICAL_CALLS = 3;

/** A stable fingerprint of one step's tool calls, for loop detection. */
function signatureOf(calls) {
  return calls.map((c) => `${c.name}:${stableStringify(c.args)}`).join('|');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const SUB_AGENT_PROMPT = `You are a research assistant working inside a codebase. You have read-only tools: read_file, list_dir, glob, grep.

You have been given one self-contained question. Nobody is watching you work — only your final message is returned to the agent that asked, so it has to stand alone.

- Search first, conclude second. Use grep and glob to find candidates, then read the files that matter.
- Answer only what was asked. Do not propose changes, and do not editorialize.
- Cite what you found as path:line so the caller can go straight there.
- If the answer genuinely is not in the codebase, say that plainly rather than guessing.
- Be brief. A few sentences, or a short list. No preamble.`;

function summarizeResult(name, content) {
  const text = String(content);
  const lines = text.split('\n');
  if (name === 'read_file') return `${lines.length} lines`;
  if (lines.length > 4) return `${lines.slice(0, 3).join('\n')}\n… ${lines.length - 3} more lines`;
  return text;
}
