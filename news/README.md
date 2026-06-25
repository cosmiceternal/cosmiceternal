# News Reader — Political, Financial & World

A live **News Wall** of political, financial, and international news that runs
entirely on your computer. There's also a terminal version.

- **No sign-up, no API keys, no accounts.**
- **No packages to install** — only what ships with Node.js.
- Open **RSS/Atom feeds**, plus free **translation** and **market quotes**
  (no key required).

## Requirements

- [Node.js](https://nodejs.org/) version 18 or newer
  (check with `node --version`).
- An internet connection.

## Easiest start (Windows)

Double-click **`start-windows.bat`** in this folder. It launches the server and
opens the News Wall in your browser automatically.

## Visual web app — the News Wall (recommended)

```bash
cd news
node server.js
```

Then open **http://localhost:8787** in your browser. You'll see a **grid wall of
live stations** — one tile per topic, color-coded **blue for Political**,
**green for Financial**, and **amber for World** — each cycling through its
latest headlines with a "LIVE" indicator and article images.

- **Hover** a station and it **magnifies**, lifting above the wall and revealing
  a peek list of its other current headlines.
- **Click** a station and it **stays open** in a full reader: every headline for
  that topic with thumbnails, summaries, source, and time. Close it with the
  **✕**, the **Esc** key, or by clicking outside it.
- **🔊 Read aloud** — every station tile and every article has a speaker button
  that reads the headline aloud using your browser's built-in voice.
- **Foreign-language stations show English subtitles** — international outlets
  (Le Monde, Der Spiegel, NHK, …) have their headlines auto-translated to
  English (shown as the main line, with the original beneath). Open one and the
  article summaries are translated too.
- **International markets rail** on the right shows live index quotes (S&P 500,
  Nasdaq, Dow, FTSE, DAX, CAC 40, Nikkei, Hang Seng), refreshed every minute.
- **Filter** the wall with **All / Political / Financial / World** at the top.
- **⟳ Refresh all** reloads every station; stations also auto-refresh in the
  background.

The layout adapts to wide/ultrawide monitors (the markets rail sits to the
right and tucks under the wall on narrow screens).

Use a different port with `PORT=9000 node server.js`.

### Free services it uses (no keys)

- **Translation:** a free public translation endpoint. It's unofficial, so it
  can be rate-limited; if a translation fails, the original headline is kept.
  Swap engines by editing `translate.js`.
- **Market quotes:** Stooq's free CSV quotes. The change shown is the latest
  session's move; edit `markets.js` to change the index list.

### Roadmap: AI dubbing

The 🔊 button is the first step toward a "dubbed AI voice." Today it uses the
browser's built-in speech voice (free, robotic). A nicer AI voice — or true
spoken dubbing of live video channels — would need a text-to-speech/voice
service (and, for video, speech-to-text for subtitles); that's a larger future
add-on.

## Terminal reader

## How to run

Open a terminal, go into this folder, and start it:

```bash
cd news
node news.js
```

You'll get a menu. Type a number and press **Enter** to go deeper:

```
1. Politics
2. Economics
[q] quit
```

- Pick **Politics** or **Economics**.
- Pick a sub-topic (e.g. *Elections & Campaigns*, *Federal Reserve & Inflation*).
- You'll see the latest headlines with how long ago they were published.
- Type a headline's number to read its summary and the link to the full story.
- Use **b** to go back, **r** to refresh, **q** to quit.

### Topics you can drill into

**Politics**
- Top Political News
- Elections & Campaigns
- Congress & Legislation
- White House & Executive
- Courts & Legal
- World Politics & Diplomacy

**Economics**
- Top Economic News
- Markets & Stocks
- Federal Reserve & Inflation
- Jobs & Labor
- Housing & Real Estate
- Crypto & Fintech
- Global Economy & Trade

## Quick (non-interactive) use

Print a topic straight to the screen without the menu:

```bash
node news.js politics                 # top political headlines
node news.js economics markets        # Markets & Stocks sub-topic
node news.js economics fed            # Federal Reserve & Inflation
node news.js --list                   # show every section/topic key
node news.js --help                   # all options
```

## How the pieces fit together

| File | What it does |
|------|--------------|
| `feeds.js`     | The topic tree: feeds, keywords, and language per station. |
| `feedlib.js`   | Shared feed fetching + RSS/Atom parsing (used by both apps). |
| `translate.js` | Free, no-key translation of foreign headlines to English. |
| `markets.js`   | Free, no-key international stock-index quotes. |
| `server.js`    | The local web server (serves `web/`, fetches feeds, translates, quotes). |
| `web/`         | The browser UI: the station wall, markets rail, modal reader. |
| `news.js`      | The terminal reader. |
| `start-windows.bat` | Double-click launcher for Windows. |

## Customizing the sources

All feeds and sub-topics live in **`feeds.js`**. Each sub-topic lists one or
more feed URLs and, optionally, a set of `keywords` used to filter a broad feed
down to that topic. To add a source, drop another RSS/Atom URL into the right
list. To add a whole new sub-topic, copy an existing block and give it a title,
feeds, and keywords.

## Troubleshooting

- **"Could not reach any news feed"** — usually means no internet connection,
  or a firewall/proxy is blocking outbound requests. The program waits up to
  9 seconds per feed before giving up.
- **A sub-topic shows "nothing matched"** — the feeds loaded fine, but no recent
  story matched that sub-topic's keywords right now. Try again later or pick the
  "Top …" topic for that section.
- **Colors look odd** — color is only used when running in a real terminal; it's
  switched off automatically when output is piped to a file.
