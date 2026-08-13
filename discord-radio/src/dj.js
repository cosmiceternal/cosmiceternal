// Optional AI DJ. When ANTHROPIC_API_KEY is set and DJ_AI is enabled, the host's
// between-song lines are generated fresh and in-character via Claude (the same
// idea as the casino's AI Dealer). Every call takes a scripted fallback and
// returns it on any error or timeout, so audio never stalls waiting on the API.
import { makeLog } from './log.js';

const log = makeLog('dj-ai');

export function createDJ() {
  const enabled =
    !!process.env.ANTHROPIC_API_KEY && /^(1|true|yes|on)$/i.test(process.env.DJ_AI || '');
  const model = process.env.DJ_MODEL || 'claude-haiku-4-5-20251001';
  let client = null;
  let warned = false;

  return {
    available: enabled,

    /**
     * @param {'intro'|'back'|'banter'} kind
     * @param {object} ctx       { callSign, dj, style, slogan, genre, artist, title, year }
     * @param {string} fallback  scripted line to use if generation fails
     */
    async line(kind, ctx, fallback) {
      if (!enabled) return fallback;
      try {
        if (!client) {
          const mod = await import('@anthropic-ai/sdk');
          const Anthropic = mod.default;
          client = new Anthropic();
        }

        const system =
          `You are ${ctx.dj}, the on-air DJ of ${ctx.callSign}, a ${ctx.genre} radio station. ` +
          `Personality: ${ctx.style}. Station slogan: "${ctx.slogan}". ` +
          `Say ONE short on-air line (max 2 sentences), fully in character. ` +
          `No stage directions, no quotation marks, no emojis, no hashtags — just what you say into the mic.`;

        const ask =
          kind === 'intro'
            ? `Introduce the next song going out now: ${ctx.artist} — ${ctx.title} (${ctx.year}). Build a little hype.`
            : kind === 'back'
              ? `Back-announce the song that just finished: ${ctx.artist} — ${ctx.title} (${ctx.year}).`
              : `Drop a quick bit of station banter to keep the vibe going.`;

        const req = client.messages.create({
          model,
          max_tokens: 90,
          system,
          messages: [{ role: 'user', content: ask }],
        });

        // Never let the DJ hold up the music.
        const res = await Promise.race([
          req,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
        ]);

        const text = (res.content || [])
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
          .trim();
        return text || fallback;
      } catch (err) {
        if (!warned) {
          log.warn(`AI DJ unavailable, using scripted lines: ${err.message}`);
          warned = true;
        }
        return fallback;
      }
    },
  };
}
