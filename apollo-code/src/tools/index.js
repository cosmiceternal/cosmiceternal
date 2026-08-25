import readFile from './read.js';
import writeFile from './write.js';
import editFile from './edit.js';
import multiEdit from './multi-edit.js';
import listDir from './ls.js';
import globTool from './glob.js';
import grepTool from './grep.js';
import runBash from './bash.js';
import todoWrite from './todo.js';
import taskTool from './task.js';

export const ALL_TOOLS = [
  readFile, listDir, globTool, grepTool, editFile, multiEdit, writeFile, runBash, todoWrite, taskTool,
];

/**
 * @param {object} options
 * @param {boolean} options.readOnly  drop every tool that can change something
 * @param {boolean} options.nested    drop `task`, so a sub-agent cannot spawn its own
 */
export function buildRegistry({ readOnly = false, nested = false } = {}) {
  let tools = readOnly ? ALL_TOOLS.filter((t) => t.readOnly) : ALL_TOOLS;
  if (nested) tools = tools.filter((t) => t.name !== 'task');
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
