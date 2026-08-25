import readFile from './read.js';
import writeFile from './write.js';
import editFile from './edit.js';
import multiEdit from './multi-edit.js';
import listDir from './ls.js';
import globTool from './glob.js';
import grepTool from './grep.js';
import runBash from './bash.js';
import todoWrite from './todo.js';

export const ALL_TOOLS = [
  readFile, listDir, globTool, grepTool, editFile, multiEdit, writeFile, runBash, todoWrite,
];

export function buildRegistry({ readOnly = false } = {}) {
  const tools = readOnly ? ALL_TOOLS.filter((t) => t.readOnly) : ALL_TOOLS;
  return new Map(tools.map((t) => [t.name, t]));
}

/** JSON-schema tool definitions in the shape both providers expect. */
export function toolSchemas(registry) {
  return [...registry.values()].map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
