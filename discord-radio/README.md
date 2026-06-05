# 📻 Discord Genre Radio

A multi-station Discord radio that streams **long, uninterrupted music**, mixed by
**genre** and **production date**, and remote-controlled from **Telegram**.

Every major genre is its **own Discord bot** (its own token + voice channel), so they
can all play in the same server at once — a Rock station in one voice channel, Jazz in
another, Hip-Hop in a third. Each station auto-DJs forever: when a song ends it picks the
next one, avoiding recent repeats, so a channel never goes quiet.

Because each track carries a **year**, you can narrow any station to an era — "play only
1970s Rock", "give me 2010s Hip-Hop" — live, from Discord or Telegram.

> ⚠️ **Licensing note.** This streams audio via `yt-dlp` for personal/educational use.
> Publicly rebroadcasting copyrighted music can require licences. Run it for yourself /
> your own server, or point it at music you have the rights to. You are responsible for
> how you use it. See [Using your own music](#using-your-own-music).

---

## How the "genre + date" mix works

- **Genre** = which catalog a station plays (`data/catalog/<genre>.json`). One station per genre.
- **Date** = an optional year filter on top of that catalog. With no filter a station plays
  its whole era; set a range and it only spins songs produced in those years.
- The **Mixer** (`src/mixer.js`) picks the next track at random from the genre+era pool while
  skipping the last *N* tracks (configurable via `NO_REPEAT_WINDOW`) so long sessions stay fresh.

Catalogs ship for: **Rock, Pop, Hip-Hop, Electronic, R&B/Soul, Jazz, Metal, Country** —
each spanning several decades. Add or edit tracks freely; just keep the `year` field.

---

## Quick start

**1. Prerequisites**

- **Node 18+**
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** on your `PATH` (the audio engine):
  ```bash
  pipx install yt-dlp        # or: brew install yt-dlp / pip install -U yt-dlp
  ```
  (ffmpeg is bundled via `ffmpeg-static` — no system install needed.)

**2. Install**

```bash
cd discord-radio
npm install
```

**3. Create the Discord bot(s)** — one per genre you want to run:

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → copy the **token**.
2. Under **Bot**, no privileged intents are required (it uses slash commands + voice only).
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot permissions
   **Connect** and **Speak**. Open the URL and invite the bot to your server.
4. Grab your **server (guild) ID** and the target **voice channel ID**
   (enable *Developer Mode* in Discord → right-click → *Copy ID*).

**4. Configure**

```bash
cp .env.example .env
```

Fill in, for each station you want, `DISCORD_TOKEN_<GENRE>`, `DISCORD_GUILD_<GENRE>`,
and `DISCORD_VOICE_<GENRE>`. A station only boots if its token is set, so you can start
with just one.

**5. Run**

```bash
npm start
```

Each configured bot logs in, joins its voice channel, and starts playing. 🎶

---

## Controlling it

### From Discord (slash commands, per station)

| Command            | What it does                                   |
| ------------------ | ---------------------------------------------- |
| `/now`             | Show the current track                         |
| `/skip`            | Skip to the next song                          |
| `/station`         | Catalog size, year span, current filter        |
| `/era <from> <to>` | Only play songs produced in that year range    |
| `/allyears`        | Clear the year filter                          |

### From Telegram (one bot controls every station)

Create a bot with **[@BotFather](https://t.me/BotFather)**, put its token in
`TELEGRAM_BOT_TOKEN`, and (recommended) list your numeric Telegram user ID in
`TELEGRAM_ALLOWED_USERS`.

| Command                       | What it does                          |
| ----------------------------- | ------------------------------------- |
| `/stations`                   | List stations + now-playing           |
| `/now <id>`                   | What a station is playing             |
| `/skip <id>`                  | Next track                            |
| `/era <id> <from> <to>`       | e.g. `/era rock 1970 1979`            |
| `/allyears <id>`              | Clear that station's year filter      |
| `/stop <id>` / `/play <id>`   | Pause / resume a station              |

Station ids: `rock pop hiphop electronic rnb jazz metal country`.

---

## Using your own music

Prefer a fully owned library? The cleanest swap is the audio source:

- Catalogs already drive selection — edit `data/catalog/*.json` (keep `title`, `artist`,
  `year`).
- Replace `streamTrack()` in `src/sources/ytdlp.js` to resolve a track to a local file
  (e.g. map `artist/title` to a path and `createAudioResource(createReadStream(path))`).
  The Mixer, stations, and Telegram control all keep working unchanged.

---

## Project layout

```
discord-radio/
  config/stations.js        genre → station registry + env-key mapping
  data/catalog/*.json        per-genre, year-tagged track catalogs
  src/
    index.js                 boots stations (per token) + Telegram remote
    station.js               RadioStation: voice + continuous play + slash commands
    mixer.js                 genre+date selection with no-repeat window
    library.js               catalog loader
    sources/ytdlp.js         track query → streamed AudioResource
    telegram.js              Telegram control surface
    log.js                   tagged logger
```

---

## Notes & limits

- **One voice channel per bot.** Discord allows a bot in a single voice channel per server,
  which is exactly why each genre is its own bot — run as many as you like.
- **Year filter applies to the *next* song**, not the one currently playing (skip to apply now).
- If a track fails to resolve, the station logs it and moves on — playback won't stall.
