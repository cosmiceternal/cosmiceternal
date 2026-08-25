/**
 * Reasoning-model output.
 *
 * deepseek-r1, qwen3 and their kin emit their scratchpad inline, wrapped in
 * <think>…</think>, and they are among the most popular models to run locally.
 * Ollama's newer API separates that into `message.thinking`, but llama.cpp and
 * anything OpenAI-compatible hand it back in the content stream — where, left
 * alone, it lands in the user's terminal and in the conversation history.
 *
 * This strips it from the visible stream (or dims it, with --show-thinking),
 * character by character, so a tag split across chunks still works.
 */

const OPEN_TAGS = ['<think>', '<thinking>', '<reasoning>'];
const CLOSE_TAGS = ['</think>', '</thinking>', '</reasoning>'];

export class ReasoningFilter {
  constructor({ show = false } = {}) {
    this.show = show;
    this.buffer = '';
    this.inside = false;
    this.closeTag = null;
    this.captured = '';
  }

  /**
   * @returns {{visible: string, thinking: string}} text to print, and any
   * reasoning seen in this chunk (empty unless `show`).
   */
  feed(delta) {
    this.buffer += delta;
    let visible = '';
    let thinking = '';

    for (;;) {
      if (this.inside) {
        const end = this.buffer.indexOf(this.closeTag);
        if (end === -1) {
          // Hold back only what could be a partial closing tag.
          const hold = longestSuffixPrefix(this.buffer, this.closeTag);
          const body = this.buffer.slice(0, this.buffer.length - hold);
          this.buffer = this.buffer.slice(this.buffer.length - hold);
          this.captured += body;
          if (this.show) thinking += body;
          return { visible, thinking };
        }
        const body = this.buffer.slice(0, end);
        this.captured += body;
        if (this.show) thinking += body;
        this.buffer = this.buffer.slice(end + this.closeTag.length);
        this.inside = false;
        this.closeTag = null;
        continue;
      }

      const open = findEarliest(this.buffer, OPEN_TAGS);
      if (open) {
        visible += this.buffer.slice(0, open.index);
        this.buffer = this.buffer.slice(open.index + open.tag.length);
        this.inside = true;
        this.closeTag = CLOSE_TAGS[OPEN_TAGS.indexOf(open.tag)];
        continue;
      }

      // No tag yet — emit everything except a possible partial opening tag.
      const hold = Math.max(...OPEN_TAGS.map((tag) => longestSuffixPrefix(this.buffer, tag)));
      visible += this.buffer.slice(0, this.buffer.length - hold);
      this.buffer = this.buffer.slice(this.buffer.length - hold);
      return { visible, thinking };
    }
  }

  /** Anything still held back at the end of a turn. */
  flush() {
    if (this.inside) {
      // Unterminated block: it was all reasoning, so none of it is the answer.
      const body = this.buffer;
      this.captured += body;
      this.buffer = '';
      return { visible: '', thinking: this.show ? body : '' };
    }
    const visible = this.buffer;
    this.buffer = '';
    return { visible, thinking: '' };
  }

  get sawReasoning() {
    return this.captured.length > 0;
  }
}

function findEarliest(text, tags) {
  let best = null;
  for (const tag of tags) {
    const index = text.indexOf(tag);
    if (index !== -1 && (!best || index < best.index)) best = { index, tag };
  }
  return best;
}

function longestSuffixPrefix(text, marker) {
  const max = Math.min(text.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (text.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}
