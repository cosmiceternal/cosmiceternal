# Apollo — project instructions

Apollo is an offline coding-agent CLI: a Claude Code-style agent loop driven by a
local LLM (Ollama or any OpenAI-compatible server). Node 18.17+, ESM, **zero
runtime dependencies** — that constraint is deliberate, don't add a package.

## Commands

```bash
npm test                          # full suite (node:test), no network needed
node --test test/agent.test.js    # one file
node --test --test-name-pattern="text mode" test/*.test.js   # one test
node bin/apollo.js doctor         # probe for local model servers
node bin/apollo.js --help
```

There is no build step and no linter config — match the existing style by hand.

## Layout

- `src/cli.js` — flag parsing, subcommands, the REPL. `main()` returns an exit code.
- `src/agent.js` — the loop. `#streamTurn` does one provider round-trip;
  `#executeOne` logs and dispatches a tool; `#recordToolResults` writes history
  back in the shape the current tool mode needs; `#runSubAgent` backs the `task`
  tool.
- `src/providers/` — `ollama.js` (native `/api/chat`) and `openai.js`
  (`/v1/chat/completions`). Both normalize to the same event stream:
  `{type:'text'|'tool_call'|'usage'|'thinking'}`. Add a backend here and nothing
  else changes.
- `src/tools/` — one file per tool, each exporting
  `{name, description, parameters, readOnly, affects?, preview?, run}`.
  Register in `index.js`.
- `src/protocol/text-tools.js` — the `<apollo:tool>` fallback protocol.
- `src/workspace.js` — the path jail; also owns the parsed `.gitignore` matcher.
- `src/checkpoints.js` — snapshots behind `/undo`.
- `src/input.js` — `@references`, tab completion, history, line classification.
- `src/markdown.js` — streaming markdown rendering.
- `src/custom-commands.js` — `.apollo/commands/*.md` slash commands.
- `src/permissions.js`, `src/context.js`, `src/session.js`, `src/config.js`,
  `src/ignore.js`, `src/ui.js`.

## Rules that matter

- **Every filesystem path goes through `Workspace.resolve()`.** Never call
  `path.resolve` against the root in a tool. That method is the only thing
  standing between a confused model and the user's home directory.
- **Tools return strings and throw Errors.** The agent turns a thrown message
  into a `Error: …` tool result the model can recover from — so error text is
  written for the model, not the user: say what was wrong and what to do instead.
- **`readOnly: true` means it cannot change anything.** It also decides what
  survives `--read-only` mode and what skips the approval prompt.
- **`preview()` must not mutate.** It runs before the user approves, and its
  output is what they're approving.
- **Two tool modes, one loop.** Anything touching message history has to work in
  both: native mode uses `role: 'tool'` messages, text mode feeds results back as
  a user turn. `test/agent.test.js` covers both — keep it that way.
- **A mutating tool declares `affects()`.** That is what gets snapshotted for
  `/undo`. A tool that changes files without it is a tool the user cannot undo.
- **Freshness before writing.** Call `assertFresh` in both `run()` and
  `preview()`, and `recordWrite` after: the preview check is what stops the user
  approving an edit that is about to fail.
- **Nothing new on the wire without a fake-server test.** Provider changes are
  where wire-format bugs hide, and the fakes are cheap.

## Testing

`test/helpers/fake-server.js` scripts a fake Ollama and a fake OpenAI-compatible
server; each entry in `turns` is one assistant reply. Use it for anything touching
the agent loop rather than mocking the provider class — it catches wire-format
bugs (split tool-call frames, NDJSON vs SSE) that a mock never would.

Tests must not need a real model, a network, or a TTY. `scripts/repl-smoke.mjs`
is the exception — it drives the real REPL through a pty and is run by hand
(`npm run smoke`), not by `npm test`.

## Debugging a model, not the code

`node bin/apollo.js --trace /tmp/t.jsonl -p "…"` logs every request, stream
frame and parsed tool call. When behaviour looks wrong, read the trace before
reading the code — it is usually the model, and the trace says so immediately.

## Commands this project defines

`.apollo/commands/` holds `/review` and `/test-one`. They are Apollo's own
dogfood — if the command format changes, update them.
