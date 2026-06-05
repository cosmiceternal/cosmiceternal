// Station registry. Each entry is one major genre = one independent Discord bot.
// A station only launches at runtime if DISCORD_TOKEN_<ID> is present in the env,
// so you can run one, a few, or all of them from the same process.

export const STATIONS = [
  { id: 'rock',       name: 'Rock',       emoji: '🎸', catalog: 'rock' },
  { id: 'pop',        name: 'Pop',        emoji: '🎤', catalog: 'pop' },
  { id: 'hiphop',     name: 'Hip-Hop',    emoji: '🎧', catalog: 'hiphop' },
  { id: 'electronic', name: 'Electronic', emoji: '🛸', catalog: 'electronic' },
  { id: 'rnb',        name: 'R&B / Soul', emoji: '💜', catalog: 'rnb' },
  { id: 'jazz',       name: 'Jazz',       emoji: '🎷', catalog: 'jazz' },
  { id: 'metal',      name: 'Metal',      emoji: '🤘', catalog: 'metal' },
  { id: 'country',    name: 'Country',    emoji: '🤠', catalog: 'country' },
];

// Env var names derived from a station id, e.g. "rock" -> DISCORD_TOKEN_ROCK.
export function envKeys(id) {
  const up = id.toUpperCase();
  return {
    token: `DISCORD_TOKEN_${up}`,
    guild: `DISCORD_GUILD_${up}`,
    voice: `DISCORD_VOICE_${up}`,
  };
}
