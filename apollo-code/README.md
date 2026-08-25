# Apollo

A coding agent that runs entirely on your own machine.

Apollo is a terminal coding assistant in the shape of Claude Code — it reads your
files, greps your codebase, edits code, runs your tests, and iterates — except the
model is one you run locally. No API key, no account, no network. Your code never
leaves the machine.

```
› the crash handler swallows errors — find it and fix it

● grep(catch \(.*\) \{\s*\}  in src)
  ⎿ src/runtime/crash.js:88: } catch (err) {}
● read_file(src/runtime/crash.js)
  ⎿ 142 lines
● edit_file(src/runtime/crash.js)
    - } catch (err) {}
    + } catch (err) {
    +   logger.error('crash handler failed', err);
    + }
  Allow? [y] yes  [a] yes, don't ask again for edit_file  [n] no
  > y
  ⎿ Edited src/runtime/crash.js (1 replacement)
● run_bash(npm test -- crash)
  ⎿ 14 passing

Fixed at src/runtime/crash.js:88 — the empty catch now logs. Tests pass.
  8.4s · 412 tokens · 49.1 tok/s
```

## Why

Cloud coding agents are excellent and also: metered, online, and reading your
source. Apollo trades some model capability for three things you can't buy back —
it works on a plane, it costs nothing per token, and nothing you type is
transmitted anywhere.

## Requirements

- **Node 18.17+** — that's the entire install. Apollo has zero runtime dependencies.
- **A local model server.** Any one of:
  - [Ollama](https://ollama.com) (easiest)
  - [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`
  - LM Studio, vLLM, text-generation-webui, or anything else speaking the
    OpenAI `/v1/chat/completions` dialect

## Install

```bash
git clone <your-repo-url> apollo && cd apollo
npm link          # puts `apollo` on your PATH
```

Or skip the link and run `node /path/to/apollo/bin/apollo.js` directly.

Then get a model and start a server:

```bash
ollama pull qwen2.5-coder:7b
ollama serve
```

And point Apollo at it:

```bash
apollo setup      # finds your backends, lists their models, saves your choice
apollo doctor     # or just check what's reachable and which models support tools
apollo selftest   # and check the model can actually drive an agent
```

## Use

```bash
cd ~/code/my-project
apollo                                  # interactive session
apollo "why does the build fail?"       # one-shot, prints and exits
apollo -p "add a test for parseArgs" --auto-edit
git diff | apollo -p "review this"      # reads a piped prompt
apollo -p "list the dead exports" --json | jq -r .answer
```

### In a session

Type a question. Or:

- **`@path`** attaches a file (or a directory listing) to your message, so the
  model doesn't spend a turn discovering it: `why does @src/auth.js reject this?`
- **`!command`** runs a shell command yourself; the output stays in the
  conversation, so "why did that fail?" has something to refer to.
- **`\`** at the end of a line continues onto the next.
- **Tab** completes slash commands and `@paths`; **↑** walks your history across
  sessions.
- **Ctrl+C** cancels the current turn, twice exits.

### Commands

| | |
|---|---|
| `/help` | list commands, including this project's own |
| `/resume` | switch to another saved session |
| `/model`, `/models` | show or switch the active model |
| `/mode ask\|auto-edit\|yolo\|read-only` | change how much Apollo asks |
| `/undo`, `/checkpoints` | revert a change — `/undo turn` for the whole last turn, `/undo all` for everything |
| `/retry` | send your last message again, dropping the reply you didn't like |
| `/context` | context-window usage for this session |
| `/compact` | summarize the conversation to free up context |
| `/clear` | start over, keeping settings |
| `/init` | have Apollo write an `APOLLO.md` for the project |
| `/diff` | show the working-tree diff |
| `/tools`, `/todos`, `/config`, `/sessions`, `/save`, `/memory`, `/exit` | |

## Is my model good enough?

Local models vary enormously at *tool use* — far more than at writing code — and
the only way to know is to try. `apollo selftest` runs six small tasks in a
throwaway workspace and checks the **files afterwards**, not what the model
claimed:

```
  Apollo self-test · qwen2.5-coder:7b · native tool calling

  ✓ Read a file and answer from it          4.1s · 1 tool call
  ✓ Find which file defines a symbol        3.8s · 1 tool call
  ✓ Make a precise edit to an existing file 9.2s · 2 tool calls
  ✓ Create a new file                       6.0s · 1 tool call
  ✓ Run a command and use its output        5.4s · 1 tool call
  ✗ Two related changes in one turn        14.7s · 2 tool calls
      README.md was not updated

  5/6 passed in 43s
  Usable, with supervision. Keep permission mode at "ask" and give it narrower instructions.
```

A model that says it made an edit and didn't fails here, which is exactly the
failure you want to find before you trust it with your repository. `--only <id>`
reruns one scenario; `--json` gives the results as data.

## Permission modes

Apollo can read anything in the working directory without asking. Everything that
changes something is gated:

| Mode | File edits | Shell commands |
|---|---|---|
| `ask` *(default)* | prompts | prompts |
| `auto-edit` | applied | prompts |
| `yolo` | applied | run |
| `read-only` | refused | refused |

At an approval prompt: `y` allows once, `a` allows that tool for the rest of the
session, `n` declines — and anything else you type is sent back to the model as
the reason, so "n, use the existing helper instead" both declines and redirects.

Three things hold in every mode, including `yolo`:

- **The workspace is a jail.** Every path a tool touches is resolved against the
  working directory and rejected if it lands outside — including via `..`, an
  absolute path, or a symlink pointing out of the tree.
- **Nothing is overwritten blind.** Editing or replacing a file the session
  hasn't read is refused, and so is editing one that changed on disk since it was
  read. A background formatter or your own edits can't be silently reverted.
- **A short list of unrecoverable commands is always refused** (`rm -rf /`,
  `mkfs`, `dd of=/dev/…`, fork bombs, piping a download into a shell). This is a
  guardrail, not a sandbox: a shell is a shell. Run `yolo` in a container or a
  throwaway checkout.

And if something does go wrong, `/undo` puts it back — every file a tool changes
is snapshotted first. Changes are grouped by turn, so when a model makes a mess
across five files, `/undo turn` reverts all of it at once, restoring each file to
what it held *before* the turn began.

## Tools

| | |
|---|---|
| `read_file` `list_dir` `glob` `grep` | look around; `.gitignore` is respected |
| `edit_file` `multi_edit` `write_file` | change code; exact-match, all-or-nothing |
| `run_bash` | build, test, lint, git |
| `todo_write` | track multi-step work |
| `task` | hand a research question to a read-only sub-agent |

`task` is the one worth explaining: it runs a second agent with its own context
and returns only its answer. Twenty greps to find where something lives cost the
main conversation one paragraph instead of twenty tool results — which matters
most exactly when context is scarce.

## Tool calling on small models

Many good local coding models have no native function calling, or do it badly.
Apollo handles both cases:

- **`native`** — real `tools` in the API request. Used when the model supports it.
- **`text`** — the model emits a tagged block that Apollo parses out of the stream:

  ```
  <apollo:tool name="read_file">
  {"path": "src/index.js"}
  </apollo:tool>
  ```

  The block never reaches your terminal, tool results are fed back as an ordinary
  user turn (so it works with any chat template), and the parser tolerates what
  small models actually do — markdown fences around the block, trailing commas,
  a missing closing tag at the end of a turn.

`--tool-mode auto` (the default) asks the backend which the model supports, and
falls back from `native` to `text` if a request is rejected over tools.

Models that ignore the tagged format entirely and emit an OpenAI-style
`{"name": …, "arguments": …}` JSON call are also accepted — strictly, so a
`package.json` example in a fenced block is never mistaken for a tool call.

### Forgiving parameter names

A small model that has understood the task perfectly will still call
`read_file({file_path: …})` because that is what it saw in training — and then
spend a turn apologising for the schema error. Apollo renames what it
recognises (`file_path`, `filePath`, `cmd`, `query`, `old`/`new`, and a few
dozen more) onto the parameter the tool actually declares, but only when the
real one is absent, so a correct call is never touched.

### Reasoning models

`deepseek-r1`, `qwen3` and similar emit their scratchpad inline as
`<think>…</think>`. Apollo strips it from the terminal *and* from the
conversation history, so it doesn't consume context on later turns. Tool calls
inside such a reply still work. `--show-thinking` renders it dimmed instead.

## Configuration

Lowest precedence to highest: built-in defaults → `~/.apollo/config.json` →
`.apollo/config.json` in the project → `.apollo/config.local.json` (gitignored) →
`APOLLO_*` environment variables → command-line flags.

```json
{
  "provider": "ollama",
  "baseUrl": "http://127.0.0.1:11434",
  "model": "qwen2.5-coder:14b",
  "contextTokens": 32768,
  "permissionMode": "auto-edit",
  "allowedCommands": ["^npm (test|run lint)$", "^git (status|diff|log)"]
}
```

`allowedCommands` are regexes that skip the approval prompt in `ask` mode — a
practical middle ground: let it run your test suite unattended, ask about
everything else. `/config save` writes your current session settings to the global
file.

Run `apollo --help` for every flag.

### Picking a model

Tool use, not raw code quality, is what separates a usable agent from a
frustrating one. Roughly:

| VRAM | Model | Notes |
|---|---|---|
| 8 GB | `qwen2.5-coder:7b` | the sane default; native tools |
| 16 GB | `qwen2.5-coder:14b` | noticeably better at multi-step work |
| 24 GB+ | `qwen2.5-coder:32b`, `devstral` | strongest local option |
| any | `llama3.1:8b` | fine generalist, weaker at code |

You don't have to get `contextTokens` right: Apollo asks the backend what the
model actually supports and clamps down to it, tracks usage against that window
with an estimator that calibrates itself against the token counts the server
reports, and compacts the conversation before it runs out. If the server rejects
a request as too long anyway, Apollo compacts and retries rather than losing the
session.

## APOLLO.md

If the project root has an `APOLLO.md` (or `AGENTS.md`, or `CLAUDE.md`), it's
loaded into the system prompt every session. Put the things you'd otherwise repeat
in it — how to run one test, which directories are generated, conventions the
codebase actually follows. `/init` writes a first draft by exploring the repo.

## Project commands

A markdown file in `.apollo/commands/` becomes a slash command:

```markdown
---
description: Review the working tree the way we review PRs
---
Review the current `git diff` against our conventions in APOLLO.md.
Focus on $ARGUMENTS. Report findings as path:line with a one-line fix each.
```

Saved as `.apollo/commands/review.md`, that's `/review error handling`.
`$ARGUMENTS` is everything after the command name; `$1`–`$9` are individual words.
Files in `~/.apollo/commands/` are available in every project; a project file of
the same name wins.

Because they live in the repo, everyone who clones it gets them.

## Sessions

Every session is saved to `.apollo/sessions/` in the project, as plain JSON on
your disk.

```bash
apollo --continue          # resume the most recent
apollo --resume <id>       # resume a specific one
```

## Scripting

`--json` with `-p` puts exactly one object on stdout — nothing else, including
when the backend was unreachable (diagnostics go to stderr, and the exit code
tells you what happened).

```bash
apollo -p "which exports are unused?" --json --read-only
```

```json
{
  "ok": true,
  "answer": "Three exports are unused: …",
  "model": "qwen2.5-coder:7b",
  "toolMode": "native",
  "toolCalls": [{ "name": "grep", "ok": true, "durationMs": 34 }],
  "changedFiles": [],
  "usage": { "promptTokens": 4210, "completionTokens": 380, "durationMs": 9120 }
}
```

## When something goes wrong

`--trace <file>` (or `APOLLO_TRACE=<file>`) writes every request, every raw
stream frame and every parsed tool call to a JSONL log. When a local model does
something inexplicable — a tool call that never fires, a reply that stops
mid-sentence, an edit aimed at text that isn't there — this is what tells you
what the model actually saw and actually sent.

```bash
apollo --trace /tmp/apollo.jsonl -p "fix the failing test"
jq -r 'select(.kind=="event" and .type=="tool_call") | .name' /tmp/apollo.jsonl
```

## Shell completion

```bash
source completions/apollo.bash                    # bash
cp completions/_apollo ~/.zsh/completions/        # zsh (then compinit)
```

Completing `--model` asks your running backend what it actually has installed.

## How it works

```
bin/apollo.js         entry point
src/cli.js            flags, subcommands, the REPL
src/agent.js          the loop: stream → tool calls → execute → feed back → repeat
src/providers/        ollama (native API) and openai-compatible dialects
src/tools/            read, write, edit, multi-edit, list, glob, grep, bash, todo, task
src/protocol/         text tool-calling for models without native tools; reasoning-block stripping
src/permissions.js    what needs approval, and what is never allowed
src/workspace.js      the path jail — every filesystem access goes through it
src/checkpoints.js    snapshots behind /undo
src/context.js        token budgeting and conversation compaction
src/markdown.js       streaming markdown rendering
src/input.js          @references, tab completion, history
src/ignore.js         .gitignore matching for the search tools
src/session.js        save and resume
src/selftest.js       the scenarios behind `apollo selftest`
src/trace.js          the wire log behind --trace
```

The agent loop is the whole idea and it is about 200 lines: send the conversation,
stream the reply, run whatever tools it asked for, append the results, go again —
until it stops asking for tools or hits `maxSteps`.

## Development

```bash
npm test           # 317 tests, no network, no model required
npm run smoke      # drives the real REPL through a pty (needs util-linux `script`)
```

The suite runs the real agent against a scripted fake model server, so tool
calling, both wire formats, permissions, the text protocol, compaction, undo and
the CLI are all covered end to end.

## License

MIT
