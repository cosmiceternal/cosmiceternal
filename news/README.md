# News Reader — Politics & Economics

A small terminal program that pulls **political news** and **economic news**
from public news feeds and lets you drill down into specific sub-topics and
individual articles. It runs entirely on your computer.

- **No sign-up, no API keys, no accounts.**
- **No packages to install** — it uses only what ships with Node.js.
- Reads open **RSS/Atom feeds** from outlets like NPR, BBC, The Hill, and
  MarketWatch.

## Requirements

- [Node.js](https://nodejs.org/) version 18 or newer
  (check with `node --version`).
- An internet connection.

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
