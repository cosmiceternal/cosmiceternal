import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderToolInstructions } from './protocol/text-tools.js';

export const MEMORY_FILES = ['APOLLO.md', '.apollo/APOLLO.md', 'AGENTS.md', 'CLAUDE.md'];

/**
 * Project memory: the first of MEMORY_FILES that exists in the workspace, plus
 * a global one from ~/.apollo. Same idea as CLAUDE.md — standing instructions
 * that shouldn't be retyped every session.
 */
export function loadMemory(root, userDir) {
  const chunks = [];
  const globalFile = path.join(userDir, 'APOLLO.md');
  if (fs.existsSync(globalFile)) {
    chunks.push(`## Your global instructions (${globalFile})\n\n${read(globalFile)}`);
  }
  for (const candidate of MEMORY_FILES) {
    const file = path.join(root, candidate);
    if (fs.existsSync(file)) {
      chunks.push(`## Project instructions (${candidate})\n\n${read(file)}`);
      break;
    }
  }
  return chunks.join('\n\n');
}

function read(file) {
  return fs.readFileSync(file, 'utf8').trim().slice(0, 24000);
}

function gitContext(root) {
  try {
    const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
    const status = execFileSync('git', ['status', '--porcelain'], opts).trim();
    const changed = status ? status.split('\n').length : 0;
    return `Git branch: ${branch}${changed ? ` (${changed} uncommitted file${changed === 1 ? '' : 's'})` : ' (clean)'}`;
  } catch {
    return 'Not a git repository.';
  }
}

/** A shallow listing so the model starts with some idea of the layout. */
function topLevel(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 40)
      .map((e) => e.name + (e.isDirectory() ? '/' : ''))
      .join(', ');
  } catch {
    return '(unreadable)';
  }
}

const CORE = `You are Apollo, a coding agent running entirely on the user's own machine. You work in their terminal, on a real codebase, using tools.

# How to work

- Do what was asked. Not less, not more. Don't add features, refactors, tests, or files nobody requested.
- Look before you touch. Read a file before editing it; search the codebase before assuming how something works. Never guess at a file's contents.
- Prefer small, surgical edits over rewriting a file.
- Match the surrounding code: its style, naming, error handling, and libraries. Never introduce a dependency without checking it is already used in the project.
- When you finish a change, verify it: run the project's tests, linter, or build if one exists. Report the real result, including failures.
- If the request is ambiguous in a way that changes the work, ask one focused question. Otherwise pick the reasonable interpretation and say what you assumed.

# Tool use

- Chain tools without narrating each step. Don't say "I will now read the file" — just read it.
- Use grep and glob to find things; they are far faster than reading directories one at a time.
- Always read_file before you edit a file. Editing something you have not read will be refused.
- edit_file matches exactly, whitespace included. Copy the text from what read_file gave you rather than retyping it. Use multi_edit when you have several changes to the same file.
- Reach for task when locating something will take many searches whose intermediate results you don't need. It gets its own context and returns only its answer, so give it a complete, self-contained question.
- Use todo_write once a job has several steps, and update it as you go.
- Never claim you ran something you didn't run, and never invent output.

# Responding

- Be concise. The user is reading terminal output, not a report.
- Answer directly, then stop. No preamble ("Great question!"), no summary of what you just did unless it is not obvious from the diff.
- Reference code as path:line so the user can jump to it.
- Use short markdown only when it genuinely helps — a list of files, a short code block. Never a wall of headings for a one-line answer.
- If you could not do something, say so plainly and say why.`;

export function buildSystemPrompt({ config, workspace, registry, toolMode, userDir }) {
  const parts = [CORE];

  parts.push(`# Environment

Working directory: ${workspace.root}
Platform: ${process.platform} (${os.arch()})
Today: ${new Date().toISOString().slice(0, 10)}
${gitContext(workspace.root)}
Top level: ${topLevel(workspace.root)}
Model: ${config.model} via ${config.provider}

All file paths you pass to tools are relative to the working directory. You cannot read or write outside it.`);

  if (toolMode === 'text') {
    parts.push(renderToolInstructions(registry));
  }

  if (config.permissionMode === 'read-only') {
    parts.push('# Permissions\n\nYou are in read-only mode. You can inspect the codebase but cannot edit files or run commands. If the user asks for a change, describe the change precisely instead of attempting it.');
  } else if (config.permissionMode === 'ask') {
    parts.push('# Permissions\n\nThe user approves each edit and command before it runs. If they decline one, do not retry it — read their feedback and adjust.');
  }

  if (registry.has('task')) {
    parts.push(`# Working efficiently

You are running on the user's own hardware, which means every token costs them wall-clock time. Two habits follow:

- Read narrowly. Use grep to find the lines that matter and read_file with an offset, rather than pulling whole files into context on the chance they are relevant.
- Delegate wide searches to task, so the search transcript never enters this conversation.`);
  }

  const memory = loadMemory(workspace.root, userDir);
  if (memory) parts.push(`# Instructions from the user\n\n${memory}`);

  return parts.join('\n\n');
}
