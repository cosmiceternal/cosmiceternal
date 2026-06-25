# News Reader — Political & Financial

Pulls **political news** and **financial/economic news** from public news
feeds and lets you drill down into specific sub-topics and individual
articles. It runs entirely on your computer. Two ways to use it:

- A **visual web app** — a split header banner (Political on one side,
  Financial on the other) with two side-by-side columns of headlines and
  article images. *(Recommended.)*
- A **terminal reader** — same news, menu-driven, in your console.

Both share the same sources and have:

- **No sign-up, no API keys, no accounts.**
- **No packages to install** — only what ships with Node.js.
- Open **RSS/Atom feeds** from outlets like NPR, BBC, The Hill, and
  MarketWatch.

## Requirements

- [Node.js](https://nodejs.org/) version 18 or newer
  (check with `node --version`).
- An internet connection.

## Visual web app — the News Wall (recommended)

```bash
cd news
node server.js
```

Then open **http://localhost:8787** in your browser. You'll see a **grid wall of
live stations** — one tile per topic, color-coded **blue for Political** and
**green for Financial**, each cycling through its latest headlines with a
"LIVE" indicator and article images.

- **Hover** a station and it **magnifies**, lifting above the wall and revealing
  a peek list of its other current headlines.
- **Click** a station and it **stays open** in a full reader: every headline for
  that topic with thumbnails, summaries, source, and time. Close it with the
  **✕**, the **Esc** key, or by clicking outside it.
- **Filter** the wall with **All / Political / Financial** at the top.
- **⟳ Refresh all** reloads every station; each station also auto-refreshes in
  the background so the wall stays current.

Use a different port with `PORT=9000 node server.js`.

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
| `feeds.js`   | The topic tree: which feeds and keywords belong to each sub-topic. |
| `feedlib.js` | Shared feed fetching + RSS/Atom parsing (used by both apps). |
| `server.js`  | The local web server for the visual app (serves `web/`, fetches feeds). |
| `web/`       | The browser UI: split header banner, two columns, styling. |
| `news.js`    | The terminal reader. |

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
