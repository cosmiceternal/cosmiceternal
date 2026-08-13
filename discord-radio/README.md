# 📻 Discord Genre Radio — GTA-style stations

A multi-station Discord radio that runs like the radio in **GTA V**: not a playlist, but
a set of **stations** with personality. Each one streams **long, uninterrupted music**
mixed by **genre** and **production date**, with a **host DJ who talks between songs**,
**station idents**, and **commercial breaks** — all controllable from **Telegram**.

Every major genre is its **own Discord bot** (its own token + voice channel), so they can
all broadcast in the same server at once — *97.6 Boulevard Rock Radio* in one voice
channel, *105.7 Blue Note After Dark* in another, *104.5 Block Radio* in a third. Each
station is on the air forever.

> ⚠️ **Licensing note.** Music streams via `yt-dlp` for personal/educational use.
> Publicly rebroadcasting copyrighted music can require licences. Run it for yourself /
> your own server, or point it at music you have the rights to.
> See [Using your own music](#using-your-own-music).

---

## What makes it a *station*, not a playlist

Like GTA radio, the magic is everything **between** the songs. A broadcast "director"
(`src/broadcast.js`) runs each station on a **hot clock** that interleaves:

- 🎵 **Songs** — the backbone, mixed by genre + era (see below).
- 🎙️ **DJ talk** — the host intros the next track, back-announces the last one, and drops
  banter, all in character.
- 📻 **Station idents** — "You're locked into 97.6 Boulevard Rock Radio" liners, including
  **time-of-day** variants (morning / afternoon / evening / late-night).
- 📢 **Commercials** — absurd parody ads in ad breaks every few songs.

A typical stretch sounds like:

```
📻 Nothing but Rock, all day long. 97.6 Boulevard Rock Radio.
🎙️ Coming up: The Rolling Stones — Gimme Shelter. A 1969 cut, right here on 97.6.
🎵 The Rolling Stones — Gimme Shelter (1969)
🎙️ That was the Stones. Real rock, no filler.
🎵 Led Zeppelin — Stairway to Heaven (1971)
📻 Don't touch that dial — back after these on 97.6 Boulevard Rock Radio.
📢 First Interchangeable Bank took your money and turned it into a slightly taller building…
🎵 Chuck Berry — Johnny B. Goode (1958)
```

### The stations

| id           | Call sign                     | Host DJ                     |
| ------------ | ----------------------------- | --------------------------- |
| `rock`       | 97.6 Boulevard Rock Radio     | Rex "Ramble" Calloway       |
| `pop`        | 101.1 Neon FM                 | Priya Vane                  |
| `hiphop`     | 104.5 Block Radio             | Big Sess                    |
| `electronic` | 88.1 Pulse                    | AURA                        |
| `rnb`        | 92.3 The Velvet               | Mama Coco                   |
| `jazz`       | 105.7 Blue Note After Dark    | Cornelius "Cornbread" Hayes |
| `metal`      | 93.9 The Pit                  | Vandal                      |
| `country`    | 95.5 Dust Bowl                | Waylon Tubbs                |

Branding lives in `config/stations.js`; the DJ scripts/idents in `config/imaging.js`; the
ads in `config/ads.js`. All easy to edit.

### Hearing the DJ (voice vs. text)

- **Spoken (full GTA feel):** set `TTS_CMD` to a text-to-speech command and the DJ, idents,
  and ads are **actually voiced** in the channel between songs. The command just has to read
  the line on **stdin** and write audio to **stdout** — e.g. `TTS_CMD="espeak-ng --stdout"`
  or a [piper](https://github.com/rhasspy/piper) voice for something far nicer.
- **No TTS:** idents still play a short synthesized **station stinger**, and DJ/ad lines post
  as **on-air text** (see `DISCORD_TEXT_<GENRE>`) while the music keeps flowing.
- **AI DJ (optional):** set `ANTHROPIC_API_KEY` + `DJ_AI=1` and the host's lines are generated
  fresh and in-character by Claude (scripted lines are always the fallback, so audio never
  stalls). Combine with `TTS_CMD` for a DJ that both improvises *and* speaks.

---

## How the "genre + date" mix works

- **Genre** = which catalog a station plays (`data/catalog/<genre>.json`). One station per genre.
- **Date** = an optional year filter. With no filter a station plays its whole era; set a
  range and it only spins songs produced in those years.
- The **Mixer** (`src/mixer.js`) picks the next track at random from the genre+era pool while
  skipping the last *N* tracks (`NO_REPEAT_WINDOW`) so long sessions stay fresh.

Catalogs ship for all eight genres above, each spanning several decades. Add or edit tracks
freely; just keep the `year` field.

---

## Quick start

**1. Prerequisites**

- **Node 18+**
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** on your `PATH` (the audio engine):
  ```bash
  pipx install yt-dlp        # or: brew install yt-dlp / pip install -U yt-dlp
  ```
  (ffmpeg is bundled via `ffmpeg-static` — no system install needed.)
- *(optional)* a TTS command for a talking DJ, e.g. `espeak-ng` or `piper`.

**2. Install**

```bash
cd discord-radio
npm install
```

**3. Create the Discord bot(s)** — one per genre you want to run:

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → copy the **token**.
2. No privileged intents required (slash commands + voice only).
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions
   **Connect** + **Speak** (add **Send Messages** if you use the text ticker). Invite the bot.
4. Grab your **server (guild) ID**, target **voice channel ID**, and optionally a **text
   channel ID** (enable *Developer Mode* → right-click → *Copy ID*).

**4. Configure**

```bash
cp .env.example .env
```

Per station, set `DISCORD_TOKEN_<GENRE>`, `DISCORD_GUILD_<GENRE>`, `DISCORD_VOICE_<GENRE>`
(and optional `DISCORD_TEXT_<GENRE>`). A station only boots if its token is set — start with
one. Optionally set `TTS_CMD` and/or the AI DJ vars.

**5. Run**

```bash
npm start
```

Each configured bot logs in, joins its voice channel, and goes on the air. 🎶

---

## Controlling it

### From Discord (slash commands, per station)

| Command            | What it does                                       |
| ------------------ | -------------------------------------------------- |
| `/now`             | What's on the air right now (song, DJ, ad or ident) |
| `/skip`            | Skip the current segment                           |
| `/station`         | Call sign, host, catalog size, year span, filter   |
| `/era <from> <to>` | Only play songs produced in that year range        |
| `/allyears`        | Clear the year filter                              |

### From Telegram (one bot controls every station)

Create a bot with **[@BotFather](https://t.me/BotFather)**, put its token in
`TELEGRAM_BOT_TOKEN`, and (recommended) list your numeric Telegram user ID in
`TELEGRAM_ALLOWED_USERS`.

| Command                       | What it does                          |
| ----------------------------- | ------------------------------------- |
| `/stations`                   | List stations + what's on air         |
| `/now <id>`                   | What a station is airing              |
| `/skip <id>`                  | Skip the current segment              |
| `/era <id> <from> <to>`       | e.g. `/era rock 1970 1979`            |
| `/allyears <id>`              | Clear that station's year filter      |
| `/stop <id>` / `/play <id>`   | Take a station off / back on air      |

Station ids: `rock pop hiphop electronic rnb jazz metal country`.

---

## Using your own music

Prefer a fully owned library? The cleanest swap is the audio source:

- Catalogs already drive selection — edit `data/catalog/*.json` (keep `title`, `artist`, `year`).
- Replace `streamTrack()` in `src/sources/ytdlp.js` to resolve a track to a local file
  (map `artist/title` to a path and `createAudioResource(createReadStream(path))`).
  The mixer, director, DJ, stations, and Telegram control all keep working unchanged.

---

## Project layout

```
discord-radio/
  config/
    stations.js       station registry: call signs, slogans, host DJs + env keys
    imaging.js        idents, DJ intro/back/banter scripts, time-of-day liners
    ads.js            commercial pool
  data/catalog/*.json  per-genre, year-tagged track catalogs
  src/
    index.js          boots stations (per token) + shared voice/AI DJ + Telegram
    station.js        RadioStation: voice + broadcast loop + slash commands + ticker
    broadcast.js      the Director / hot clock: sequences songs, idents, DJ, ads
    mixer.js          genre+date selection with no-repeat window
    library.js        catalog loader
    dj.js             optional AI DJ (Claude), scripted fallback
    sources/
      ytdlp.js        song query → streamed AudioResource
      voiceover.js    spoken segment (TTS) / station stinger
    telegram.js       Telegram control surface
    log.js            tagged logger
```

---

## Notes & limits

- **One voice channel per bot.** Discord allows a bot in a single voice channel per server —
  which is exactly why each genre is its own bot. Run as many as you like.
- **Year filter applies to the *next* song** (skip to apply immediately).
- If a track or a spoken line fails, the station logs it and moves on — the broadcast never stalls.
- The AI DJ has a hard 4s timeout per line and always falls back to scripted copy.
