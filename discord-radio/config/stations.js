// Station registry. Each entry is one major genre = one independent Discord bot,
// styled like a real radio station: a call sign, a slogan, and a host DJ with a
// personality (à la GTA V radio, where the presenter *is* the station).
//
// A station only launches at runtime if DISCORD_TOKEN_<ID> is present in the env,
// so you can run one, a few, or all of them from the same process.

export const STATIONS = [
  {
    id: 'rock',
    name: 'Rock',
    emoji: '🎸',
    catalog: 'rock',
    callSign: '97.6 Boulevard Rock Radio',
    short: 'Boulevard Rock',
    slogan: 'Real rock, no filler.',
    dj: { name: 'Rex "Ramble" Calloway', style: 'a gravel-voiced classic-rock lifer who rambles about the good old days and never met a guitar solo he didn\'t love' },
  },
  {
    id: 'pop',
    name: 'Pop',
    emoji: '🎤',
    catalog: 'pop',
    callSign: '101.1 Neon FM',
    short: 'Neon FM',
    slogan: 'Every hook, all night long.',
    dj: { name: 'Priya Vane', style: 'a bright, fast-talking pop host who speaks in exclamation points and adores every single song' },
  },
  {
    id: 'hiphop',
    name: 'Hip-Hop',
    emoji: '🎧',
    catalog: 'hiphop',
    callSign: '104.5 Block Radio',
    short: 'Block Radio',
    slogan: "The city's heartbeat.",
    dj: { name: 'Big Sess', style: 'a laid-back West-Coast host with heavy authority, deep love for the city, and unshakable cool' },
  },
  {
    id: 'electronic',
    name: 'Electronic',
    emoji: '🛸',
    catalog: 'electronic',
    callSign: '88.1 Pulse',
    short: 'Pulse',
    slogan: 'Lose the plot, keep the beat.',
    dj: { name: 'AURA', style: 'a cool, minimal, slightly robotic late-night club selector who speaks in short hypnotic phrases' },
  },
  {
    id: 'rnb',
    name: 'R&B / Soul',
    emoji: '💜',
    catalog: 'rnb',
    callSign: '92.3 The Velvet',
    short: 'The Velvet',
    slogan: 'Grown, smooth, and in the mood.',
    dj: { name: 'Mama Coco', style: 'a warm, sultry quiet-storm host, soothing and knowing, who treats every song like a slow dance' },
  },
  {
    id: 'jazz',
    name: 'Jazz',
    emoji: '🎷',
    catalog: 'jazz',
    callSign: '105.7 Blue Note After Dark',
    short: 'Blue Note',
    slogan: 'Loose ties, low lights.',
    dj: { name: 'Cornelius "Cornbread" Hayes', style: 'a silky midnight-jazz host, poetic and unhurried, who talks like he has all the time in the world' },
  },
  {
    id: 'metal',
    name: 'Metal',
    emoji: '🤘',
    catalog: 'metal',
    callSign: '93.9 The Pit',
    short: 'The Pit',
    slogan: 'Louder than your problems.',
    dj: { name: 'Vandal', style: 'a manic, shouting metal DJ who treats every single track like the end of the world' },
  },
  {
    id: 'country',
    name: 'Country',
    emoji: '🤠',
    catalog: 'country',
    callSign: '95.5 Dust Bowl',
    short: 'Dust Bowl',
    slogan: 'Dirt roads and steel strings.',
    dj: { name: 'Waylon Tubbs', style: 'a drawling, folksy country host with a tall tale for every song and a porch-swing pace' },
  },
];

// Env var names derived from a station id, e.g. "rock" -> DISCORD_TOKEN_ROCK.
export function envKeys(id) {
  const up = id.toUpperCase();
  return {
    token: `DISCORD_TOKEN_${up}`,
    guild: `DISCORD_GUILD_${up}`,
    voice: `DISCORD_VOICE_${up}`,
    text: `DISCORD_TEXT_${up}`, // optional channel for the on-air text ticker
  };
}
