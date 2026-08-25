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

Check that Apollo can see it:

```bash
apollo doctor
```

`doctor` probes every port a local model server usually listens on, lists the
models each one has, and tells you which of them support native tool calling.

## Use

```bash
cd ~/code/my-project
apollo                                  # interactive session
apollo "why does the build fail?"       # one-shot, prints and exits
apollo -p "add a test for parseArgs" --auto-edit
git diff | apollo -p "review this"      # reads a piped prompt
```

Inside a session, anything starting with `/` is a command:

| | |
|---|---|
| `/help` | list commands |
| `/model`, `/models` | show or switch the active model |
| `/mode ask\|auto-edit\|yolo\|read-only` | change how much Apollo asks |
| `/context` | context-window usage for this session |
| `/compact` | summarize the conversation to free up context |
| `/clear` | start over, keeping settings |
| `/init` | have Apollo write an `APOLLO.md` for the project |
| `/diff` | show the working-tree diff |
| `/tools`, `/todos`, `/config`, `/sessions`, `/save`, `/exit` | |

Ctrl+C cancels the current turn; twice exits.

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

Two boundaries hold in every mode, including `yolo`:

- **The workspace is a jail.** Every path a tool touches is resolved against the
  working directory and rejected if it lands outside — including via `..`, an
  absolute path, or a symlink pointing out of the tree.
- **A short list of unrecoverable commands is always refused** (`rm -rf /`,
  `mkfs`, `dd of=/dev/…`, fork bombs, piping a download into a shell). This is
  guardrail, not sandbox: a shell is a shell. Run `yolo` in a container or a
  throwaway checkout.

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

Set `contextTokens` to match what you actually launched the server with. Apollo
budgets against that number and compacts the conversation before it overflows —
if it's wrong, you get silent truncation instead.

## APOLLO.md

If the project root has an `APOLLO.md` (or `AGENTS.md`, or `CLAUDE.md`), it's
loaded into the system prompt every session. Put the things you'd otherwise repeat
in it — how to run one test, which directories are generated, conventions the
codebase actually follows. `/init` writes a first draft by exploring the repo.

## Sessions

Every session is saved to `.apollo/sessions/` in the project, as plain JSON on
your disk.

```bash
apollo --continue          # resume the most recent
apollo --resume <id>       # resume a specific one
```

## How it works

```
bin/apollo.js      entry point
src/cli.js         flags, subcommands, the REPL
src/agent.js       the loop: stream → tool calls → execute → feed back → repeat
src/providers/     ollama (native API) and openai-compatible dialects
src/tools/         read, write, edit, list, glob, grep, bash, todo
src/protocol/      the text tool-calling protocol for models without native tools
src/permissions.js what needs approval, and what is never allowed
src/workspace.js   the path jail — every filesystem access goes through it
src/context.js     token budgeting and conversation compaction
src/session.js     save and resume
```

The agent loop is the whole idea and it is about 200 lines: send the conversation,
stream the reply, run whatever tools it asked for, append the results, go again —
until it stops asking for tools or hits `maxSteps`.

## Development

```bash
npm test           # 105 tests, no network, no model required
```

The suite runs the real agent against a scripted fake model server, so tool
calling, permissions, the text protocol, compaction and the CLI are all covered
end to end.

## License

MIT
