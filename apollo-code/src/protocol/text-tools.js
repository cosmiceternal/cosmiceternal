/**
 * Text tool-calling protocol.
 *
 * Plenty of good local models (7B-14B coder models especially) either lack
 * native function calling or do it badly. Instead of losing tool use entirely,
 * Apollo can ask the model to emit tool calls as tagged blocks in its normal
 * output and parse them back out:
 *
 *   <apollo:tool name="read_file">
 *   {"path": "src/index.js"}
 *   </apollo:tool>
 *
 * The parser is deliberately forgiving — small models wrap these in markdown
 * fences, forget the closing tag at the end of a turn, and leave trailing
 * commas in JSON.
 */

const OPEN = /<apollo:tool\s+name\s*=\s*["']?([a-zA-Z0-9_]+)["']?\s*>/g;
const CLOSE = '</apollo:tool>';

export function renderToolInstructions(registry) {
  const specs = [...registry.values()].map((t) => {
    const props = Object.entries(t.parameters.properties || {}).map(([key, schema]) => {
      const required = (t.parameters.required || []).includes(key) ? 'required' : 'optional';
      return `    - ${key} (${schema.type}, ${required}): ${schema.description || ''}`.trimEnd();
    });
    return `- ${t.name}: ${t.description}\n${props.join('\n')}`;
  });

  return `# Tools

You have these tools. To use one, emit a block in exactly this format:

<apollo:tool name="TOOL_NAME">
{"arg": "value"}
</apollo:tool>

Rules for tool blocks:
- The body must be a single valid JSON object. No comments, no trailing commas.
- Put the block on its own lines. Never wrap it in a markdown code fence.
- You may emit several blocks in one reply; they run in order.
- After a tool block, stop and wait. The results come back in the next message.
- Never invent tool results, and never write a block for a tool not listed here.

Available tools:

${specs.join('\n\n')}`;
}

/** Escape-hatch for fenced blocks: strip a ``` fence wrapper around a tool block. */
function stripFences(text) {
  return text.replace(/```[a-zA-Z]*\s*\n(\s*<apollo:tool[\s\S]*?<\/apollo:tool>)\s*\n```/g, '$1');
}

export function parseJsonLoose(raw) {
  const text = raw.trim();
  if (!text) return {};
  const attempts = [
    text,
    // Trailing commas before a closing brace/bracket.
    text.replace(/,(\s*[}\]])/g, '$1'),
    // A JSON object embedded in prose or a fence.
    (text.match(/\{[\s\S]*\}/) || [null])[0],
  ];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next repair */ }
  }
  throw new Error(`tool arguments were not valid JSON: ${raw.slice(0, 200)}`);
}

/**
 * Split model output into prose and tool calls.
 * @returns {{text: string, calls: Array<{id: string, name: string, args: object}>, errors: string[]}}
 */
export function parseToolCalls(output) {
  const source = stripFences(String(output ?? ''));
  const calls = [];
  const errors = [];
  let text = '';
  let cursor = 0;
  let seq = 0;

  OPEN.lastIndex = 0;
  let match;
  while ((match = OPEN.exec(source)) !== null) {
    const name = match[1];
    const bodyStart = match.index + match[0].length;
    const closeIdx = source.indexOf(CLOSE, bodyStart);
    // An unterminated final block means the model ran out of turn mid-call;
    // take the rest of the output as the body rather than dropping the call.
    const bodyEnd = closeIdx === -1 ? source.length : closeIdx;

    text += source.slice(cursor, match.index);

    try {
      calls.push({
        id: `call_${++seq}_${name}`,
        name,
        args: parseJsonLoose(source.slice(bodyStart, bodyEnd)),
      });
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }

    cursor = closeIdx === -1 ? source.length : closeIdx + CLOSE.length;
    OPEN.lastIndex = cursor;
  }

  text += source.slice(cursor);
  return { text: text.trim(), calls, errors };
}

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function', 'action'];
const ARG_KEYS = ['arguments', 'parameters', 'args', 'params', 'input', 'tool_input'];

/**
 * Last-resort parser for models that ignore the tagged format and emit an
 * OpenAI-style call as JSON instead — either fenced or as the whole reply:
 *
 *   {"name": "read_file", "arguments": {"path": "src/index.js"}}
 *
 * Deliberately strict, because a model writing JSON in a genuine answer must
 * not be mistaken for a tool call: the object has to name a tool that actually
 * exists, carry nothing but a name and an arguments object, and be the entire
 * candidate rather than a fragment of prose.
 *
 * @param {string} output
 * @param {Set<string>|string[]} knownTools
 */
export function parseLooseToolCalls(output, knownTools) {
  const known = knownTools instanceof Set ? knownTools : new Set(knownTools);
  const calls = [];
  let seq = 0;

  for (const { body, start, end } of jsonCandidates(String(output ?? ''))) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      try {
        parsed = JSON.parse(body.replace(/,(\s*[}\]])/g, '$1'));
      } catch { continue; }
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const accepted = [];
    for (const entry of entries) {
      const call = asToolCall(entry, known);
      if (!call) { accepted.length = 0; break; }   // all or nothing per candidate
      accepted.push(call);
    }
    if (!accepted.length) continue;

    for (const call of accepted) {
      calls.push({ id: `loose_${++seq}_${call.name}`, ...call });
    }
    // Remove the consumed JSON from the prose.
    output = output.slice(0, start) + output.slice(end);
  }

  return { text: String(output).trim(), calls };
}

function asToolCall(entry, known) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const nameKey = NAME_KEYS.find((k) => typeof entry[k] === 'string');
  if (!nameKey) return null;
  const name = entry[nameKey];
  if (!known.has(name)) return null;

  const argKey = ARG_KEYS.find((k) => entry[k] && typeof entry[k] === 'object' && !Array.isArray(entry[k]));
  const args = argKey ? entry[argKey] : {};

  // Anything beyond the name and its arguments means this is data, not a call.
  const extra = Object.keys(entry).filter((k) => k !== nameKey && k !== argKey && k !== 'type');
  if (extra.length) return null;

  return { name, args };
}

/** Fenced JSON blocks first, then the whole message if it is one JSON value. */
function* jsonCandidates(text) {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let match;
  let sawFence = false;
  while ((match = fence.exec(text)) !== null) {
    sawFence = true;
    yield { body: match[1].trim(), start: match.index, end: match.index + match[0].length };
  }
  if (sawFence) return;

  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    yield { body: trimmed, start: 0, end: text.length };
  }
}

/** True once the buffer holds a complete tool block — lets streaming stop early. */
export function hasCompleteToolCall(buffer) {
  OPEN.lastIndex = 0;
  const open = OPEN.exec(buffer);
  if (!open) return false;
  return buffer.indexOf(CLOSE, open.index) !== -1;
}
