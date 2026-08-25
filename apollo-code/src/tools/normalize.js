/**
 * Forgiving argument names.
 *
 * A 7B model that has understood the task perfectly will still call
 * `read_file({file_path: "x"})` because that is what it saw in training. The
 * schema says `path`, so the call fails, the model apologises, tries again, and
 * a local user has spent fifteen seconds on a typo.
 *
 * Renaming a known alias onto the parameter the tool actually declares costs
 * nothing and removes a whole category of wasted turns. Only ever applied when
 * the real parameter is absent, so a correct call is never touched.
 */
const ALIASES = {
  path: ['file_path', 'filepath', 'filename', 'file_name', 'file', 'target', 'dir', 'directory'],
  content: ['contents', 'text', 'body', 'data', 'file_content', 'file_contents', 'source'],
  pattern: ['query', 'regex', 'search', 'search_pattern', 'expression', 'glob_pattern'],
  command: ['cmd', 'shell_command', 'bash_command', 'script', 'run'],
  old_string: ['old', 'old_str', 'old_text', 'find', 'from', 'search_string'],
  new_string: ['new', 'new_str', 'new_text', 'replace', 'replacement', 'to'],
  replace_all: ['all', 'global', 'replace_all_occurrences'],
  prompt: ['question', 'task', 'instruction', 'request'],
  description: ['title', 'label', 'summary'],
  edits: ['changes', 'replacements'],
  todos: ['tasks', 'items', 'todo_list'],
  limit: ['max', 'max_results', 'count'],
  offset: ['start', 'start_line', 'from_line'],
};

/**
 * @param {object} tool  a registry entry with a `parameters` JSON schema
 * @param {object} args  what the model actually sent
 * @returns {{args: object, renamed: Array<[string, string]>}}
 */
export function normalizeArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { args: args ?? {}, renamed: [] };
  }

  const declared = Object.keys(tool.parameters?.properties || {});
  if (declared.length === 0) return { args, renamed: [] };

  const out = { ...args };
  const renamed = [];

  for (const param of declared) {
    if (out[param] !== undefined) continue;

    // Case and separator differences first: "filePath", "File_Path", "PATH".
    const loose = Object.keys(out).find((key) => normalizeKey(key) === normalizeKey(param));
    if (loose) {
      out[param] = out[loose];
      delete out[loose];
      renamed.push([loose, param]);
      continue;
    }

    const alias = (ALIASES[param] || []).find((candidate) =>
      Object.keys(out).some((key) => normalizeKey(key) === normalizeKey(candidate)));
    if (!alias) continue;

    const actualKey = Object.keys(out).find((key) => normalizeKey(key) === normalizeKey(alias));
    out[param] = out[actualKey];
    delete out[actualKey];
    renamed.push([actualKey, param]);
  }

  return { args: out, renamed };
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[_\-\s]/g, '');
}

export const ARG_ALIASES = ALIASES;
