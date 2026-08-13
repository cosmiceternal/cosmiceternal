// Station "imaging": the liners, idents and DJ scripts that air between songs and
// turn a playlist into a radio station. Templates use {placeholders} filled in by
// the broadcast director:
//   {callSign} {short} {slogan} {dj} {genre} {decade}
//   {artist} {title} {year}

// Station idents / liners (station-identification stings).
export const IDENTS = [
  "You're locked into {callSign}.",
  '{callSign}. {slogan}',
  'This is {short} — {slogan}',
  '{dj} on the air. You are listening to {callSign}.',
  'Nothing but {genre}, all day long. {callSign}.',
  'Stick around — {short}, {slogan}',
  'If it matters in {genre}, you heard it first on {callSign}.',
];

// Time-of-day idents (Rockstar varied these by in-game time; we use the wall clock).
export const TIME_IDENTS = {
  morning: [
    'Good morning, Los Santos. {dj}, easing you into the day on {callSign}.',
    'Rise and grind. {short}, {slogan}',
  ],
  afternoon: [
    'The afternoon drive rolls on, right here on {callSign}.',
    'Keeping you company all afternoon — {short}.',
  ],
  evening: [
    'Sun is going down and {short} is just heating up.',
    'Evening sessions on {callSign} — {slogan}',
  ],
  night: [
    'Late night on {callSign}. {dj}, keeping the lights low.',
    "It's after hours. {short}, {slogan}",
  ],
};

// DJ intro before a song.
export const DJ_INTROS = [
  'Coming up: {artist} — {title}. A {year} cut, right here on {callSign}.',
  'Here is a little something out of the {decade}. {artist}, {title}.',
  '{dj} lining one up for you now — {artist}, {title}.',
  'You know this one. {artist} with {title}, {year}.',
  'Straight out of the {decade}, this is {artist} — {title}.',
  'Turn it up. {artist}, {title}, on {short}.',
];

// DJ back-announce after a song.
export const DJ_BACK = [
  'That was {artist} — {title}. {slogan}',
  '{artist}, {title}, {year}. Timeless. You are on {callSign}.',
  "Can't beat {artist}. That was {title}, right here on {short}.",
  '{title} by {artist}. {dj} with you all the way.',
];

// Generic station banter (no track attached).
export const DJ_BANTER = [
  "You are spending your time with {dj}, and I would not have it any other way. {callSign}.",
  'No talk radio, no traffic reports, just {genre}. That is the promise on {short}.',
  "If the neighbours can't hear it, it is not loud enough. {callSign}.",
  'Stay right where you are. {slogan}',
];

// A few genre-flavoured banter lines for extra personality.
export const GENRE_BANTER = {
  rock: ['Somewhere out there a solo is being played too quietly. Not on {short}.'],
  metal: ["If the walls aren't shaking, {dj} is not doing the job. {callSign}."],
  jazz: ['Pour something brown, dim the lights, and let {dj} take it from here.'],
  country: ['Pull up a stool — this next stretch is for the long drive home. {short}.'],
  rnb: ['Whoever you are thinking about right now... this one is for them. {slogan}'],
  hiphop: ['Straight from the block to your block. {callSign}, no static.'],
  electronic: ['Do not think. Just move. {short}.'],
  pop: ['If you are not singing along yet, give it four seconds! {callSign}!'],
};

export function decadeOf(year) {
  return `${Math.floor(year / 10) * 10}s`;
}

export function partOfDay(hour) {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
