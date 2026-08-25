const STATUSES = ['pending', 'in_progress', 'completed'];

export default {
  name: 'todo_write',
  readOnly: true, // only mutates in-memory session state
  description:
    'Record or update your task list for multi-step work. Call it when you start a ' +
    'task with several steps, and again each time a step changes status. Keep exactly ' +
    'one task in_progress at a time. Skip it for single-step requests.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete list, every time — it replaces the previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What to do, imperative ("Add the retry test").' },
            status: { type: 'string', enum: STATUSES },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run(args, ctx) {
    if (!Array.isArray(args.todos)) throw new Error('todos must be an array');
    const todos = args.todos.map((t, i) => {
      if (!t || typeof t.content !== 'string' || !t.content.trim()) {
        throw new Error(`todos[${i}].content must be a non-empty string`);
      }
      const status = STATUSES.includes(t.status) ? t.status : 'pending';
      return { content: t.content.trim(), status };
    });

    const active = todos.filter((t) => t.status === 'in_progress');
    ctx.state.todos = todos;

    const rendered = todos
      .map((t) => `${{ pending: '[ ]', in_progress: '[~]', completed: '[x]' }[t.status]} ${t.content}`)
      .join('\n');
    const warn = active.length > 1
      ? '\n\n(note: more than one task is in_progress — keep it to one)'
      : '';
    return `Task list updated:\n${rendered}${warn}`;
  },
};
