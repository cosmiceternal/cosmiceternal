export default {
  name: 'task',
  readOnly: true,
  description:
    'Hand a self-contained research question to a second agent that can search ' +
    'and read the codebase, and get back just its answer. Use it when finding ' +
    'something will take many searches whose intermediate output you do not need ' +
    '— "where is authentication enforced?", "which callers rely on this flag?". ' +
    'The sub-agent cannot change files or run commands, and it cannot see this ' +
    'conversation, so give it every detail it needs in the prompt.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A 3-6 word label for what it is doing.' },
      prompt: {
        type: 'string',
        description: 'The full, self-contained question. State exactly what to report back.',
      },
    },
    required: ['description', 'prompt'],
  },
  async run(args, ctx) {
    if (!ctx.runSubAgent) throw new Error('sub-agents are not available in this context');
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
      throw new Error('prompt must be a non-empty, self-contained question');
    }
    const answer = await ctx.runSubAgent(args.prompt, { label: args.description });
    return answer.trim() || '(the sub-agent returned nothing)';
  },
};
