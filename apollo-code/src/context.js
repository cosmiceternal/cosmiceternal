/**
 * Context accounting. Local models have small, hard context windows and the
 * failure mode is ugly (silent truncation of the system prompt), so Apollo
 * tracks usage and compacts before it gets there rather than after.
 */

/** Rough token count. ~4 chars per token holds well enough for budgeting. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

export function messageTokens(message) {
  let total = estimateTokens(message.content) + 4; // role + framing overhead
  for (const tc of message.tool_calls || []) {
    total += estimateTokens(tc.function?.name) + estimateTokens(tc.function?.arguments) + 8;
  }
  return total;
}

export function conversationTokens(messages) {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

export function usageReport(messages, config) {
  const used = conversationTokens(messages);
  const budget = config.contextTokens - config.maxTokens;
  return {
    used,
    budget,
    fraction: budget > 0 ? used / budget : 1,
    remaining: Math.max(0, budget - used),
  };
}

export function needsCompaction(messages, config) {
  return usageReport(messages, config).fraction >= config.compactAt;
}

const SUMMARY_MARKER = '[conversation summary]';

/**
 * Replace the older half of the conversation with a model-written summary,
 * keeping the system prompt and the most recent exchanges verbatim.
 */
export async function compact(messages, provider, { keepRecent = 6 } = {}) {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length <= keepRecent + 2) return { messages, compacted: false };

  let splitAt = rest.length - keepRecent;
  // Never split a tool result away from the assistant turn that requested it.
  while (splitAt < rest.length && rest[splitAt].role === 'tool') splitAt++;

  const older = rest.slice(0, splitAt);
  const recent = rest.slice(splitAt);

  const transcript = older
    .map((m) => {
      if (m.role === 'tool') return `TOOL RESULT (${m.name}): ${truncate(m.content, 600)}`;
      const calls = (m.tool_calls || []).map((tc) => `${tc.function.name}(${truncate(tc.function.arguments, 200)})`).join(', ');
      return `${m.role.toUpperCase()}: ${truncate(m.content, 1200)}${calls ? `\n  called: ${calls}` : ''}`;
    })
    .join('\n\n');

  const summaryMessages = [
    {
      role: 'system',
      content:
        'Summarize this coding session transcript so work can continue without it. ' +
        'Keep: the user\'s goal and any explicit constraints, files read or changed and what ' +
        'is in them, decisions made and why, commands run and their results, and what is left ' +
        'to do. Drop pleasantries and dead ends. Write dense prose under 500 words. ' +
        'No preamble.',
    },
    { role: 'user', content: transcript },
  ];

  let summary = '';
  for await (const event of provider.chat({ messages: summaryMessages, tools: null })) {
    if (event.type === 'text') summary += event.delta;
  }
  summary = summary.trim();
  if (!summary) return { messages, compacted: false };

  const before = conversationTokens(messages);
  const next = [
    ...system,
    { role: 'user', content: `${SUMMARY_MARKER}\n\n${summary}` },
    { role: 'assistant', content: 'Understood — continuing from that summary.' },
    ...recent,
  ];
  return {
    messages: next,
    compacted: true,
    freed: before - conversationTokens(next),
    summary,
  };
}

function truncate(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(0, n) + '…';
}
