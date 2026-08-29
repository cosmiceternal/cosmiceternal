# dealhunter

A scraper and alert service for **underpriced GovDeals and ITAD auction lots**.

It polls surplus auction sites, works out what each lot's contents are actually
worth, subtracts everything you'd really pay — buyer's premium, freight, refurb,
marketplace fees, outbound shipping — and tells you which lots clear your margin
and **how high you can bid** before they stop being deals.

Zero runtime dependencies. Node 18+, `node bin/dealhunter.js serve`, done.

```
 SCORE      PROFIT  MARGIN     ROI        BID    MAX BID  CONF    CLOSES  TITLE
  82.2      $5,593     56%    213%     $1,701     $3,604   69%   2d left  Lot of 30 Herman Miller Aeron Chairs Size B
  81.6      $6,264     57%    232%     $1,913     $4,106   65%   2d left  Lot of 15 Zebra ZT411 Industrial Label Printers
  71.9      $4,836     39%     91%     $3,483     $3,895   66%  44h left  Lot of 45 Lenovo ThinkPad T14 Gen 2, Ryzen 5, 16GB
  52.7        $688     34%     79%       $326       $311   71%  14h left  (12) HP EliteBook 840 G6 Notebooks i7-8665U 16GB
```

---

## Quick start

```bash
cd dealhunter
node bin/dealhunter.js demo     # scrape the bundled sample lots and print the board
node bin/dealhunter.js serve    # dashboard on http://localhost:3100
```

There is nothing to install. The first run creates `./var/` for the data store
and a starter alert rule.

`demo` runs the entire real pipeline — scrape, normalise, value, price, match
rules, deliver alerts — against 24 bundled fixture lots, so you can see what the
tool does before pointing it at a live site.

---

## What it actually does

```
  source recipe ─┐
  source recipe ─┼─► normalise ─► value ─► economics ─► store ─► rules ─► alerts
  sample lots  ──┘   (category,   (comps,   (landed      (NDJSON) (filters + (webhook,
                      qty, specs,  penalt-   cost, fees,           thresholds) Slack,
                      condition,   ies,      max bid,                          Discord,
                      location)    bulk)     score)                            file)
```

### 1. Scraping

Sources are **JSON recipes**, not hand-written adapters — because auction sites
change their markup constantly and there are dozens of ITAD houses each running
different software. A recipe says where to fetch and which field maps to which:

```json
{
  "id": "itad-example",
  "kind": "json",
  "url": "https://example.com/api/lots?page={page}&q={query}",
  "itemsPath": "data.items",
  "map": {
    "externalId": "lotId",
    "title": { "path": "name", "transform": "text" },
    "currentBid": { "path": "bid.amount", "transform": "money" },
    "closesAt": { "path": "closesAt", "transform": "date" },
    "url": { "template": "https://example.com/lot/{lotId}" }
  }
}
```

`kind: "html"` recipes either lift the state blob modern sites embed
(`__NEXT_DATA__`, `window.__INITIAL_STATE__`) or fall back to row regexes. A
field can be a **list of candidates** tried in order, which is how one recipe
reads both a site's JSON blob and its raw HTML.

The HTTP client is deliberately polite: **robots.txt is honoured** (including
`Crawl-delay`, wildcards and agent-specific groups), requests are rate-limited
per host (one every two seconds by default), and 429/5xx responses back off
exponentially and respect `Retry-After`.

> **The shipped live recipes are marked `"verified": false` and you should treat
> them that way.** Neither GovDeals nor the ITAD marketplaces publish a
> documented public API; the recipes target the endpoints their own storefronts
> call, which move without notice. They were written from the shape those APIs
> take, and **could not be tested against the live sites** — the environment this
> was built in has no egress to them. Before trusting alerts, open the site's
> search page with devtools on the Network tab, copy the request it makes, and
> fix `url` / `itemsPath` / `map` to match. That is a JSON edit, not a code
> change, and `dealhunter sources` tells you which recipes are unverified.

Shipped recipes: `govdeals`, `govdeals-html` (fallback), `allsurplus`
(GovDeals' commercial/ITAD sibling), `itad-hibid` (the platform most independent
ITAD houses run their timed auctions on), and `itad-generic` (a template).
Drop your own in `var/sources/*.json`; a local file wins over a shipped one with
the same id, so your repairs survive an update.

### 2. Valuation

Listings are written by whoever cleared the warehouse, so everything is parsed
out of free text: quantity (`LOT OF 25`, `(3)`, `Qty: 30`, `12x` — but never
`Latitude 5490` or `48 Port`), condition, CPU/RAM/storage/screen, location, and
a category from weighted keyword rules.

Value comes from a **comps table** (`seed/comps.json`, 64 seeded entries), then:

- **spec adjustments** — 32GB is worth more than the base comp, i7 more than i3
- **condition** — moved from the comp's quoted basis to this lot's condition
- **penalties** — the traps that make surplus lots worthless:
  iCloud-locked phones (×0.15), still-enrolled Chromebooks (×0.35),
  BIOS-locked laptops (×0.4), unlicensed Meraki (×0.3), untested, cracked,
  missing parts. A specific penalty *supersedes* the general one it already
  covers, so nothing is deducted twice.
- **bulk discount** — 200 identical laptops do not sell at single-unit prices

Every step is recorded, so the tool always shows its working:

```
  Valuation  $969 total · $6 per unit · confidence 61%
  Method     comp "Apple iPhone 11 64GB (unlocked)"
    comp             $180  Comp: Apple iPhone 11 64GB (unlocked)
    condition      × 0.22  Condition salvage (comp quoted used)
    penalty        × 0.15  iCloud activation lock — resale is parts value only
    bulk           × 0.82  Bulk discount on 200 units
```

> The seeded comp values are **starting estimates, not market data**. They exist
> so the pipeline produces numbers on day one. Calibrate them against your own
> sold comps before bidding real money — `dealhunter comps import mycomps.csv`
> merges yours over the seeds and re-prices everything. Every comp carries a
> `confidence`, and `MIN_CONFIDENCE` keeps values you haven't verified out of
> your alerts.

### 3. Economics

```
landed   = bid + buyer's premium + tax + freight in + refurb + listing prep
proceeds = value × sell-through − marketplace fees − outbound shipping
profit   = proceeds − landed
```

The number that matters at 11:58pm on a closing auction is **max bid** — the
highest bid at which the lot still clears your target margin. It is solved
directly from that equation (including a capped premium, which makes the
relationship piecewise), not guessed, and it is unit-tested by bidding exactly
that number and asserting the margin comes out where it should.

Lots are ranked 0–100 on margin, profit, confidence and time-to-close. **A lot
you lose money on scores zero**, and so does one that has already closed.

### 4. Alerting

Rules combine filters (source, category, condition, state, keywords, quantity,
max landed cost, closing window, bid count) with thresholds (margin, profit,
ROI, confidence, score). Percentages are accepted as `40` or `0.4`.

Auction lots stay matched for days, so notification is deduplicated separately
from matching: you get one alert when a lot first qualifies, another only if the
**bid moves materially** after a cooldown, and one **last call** if it is still
a deal two hours before it closes.

Channels: `webhook`, `slack`, `discord`, `file` (NDJSON), `console`. A dead
webhook is recorded as a failed delivery and never stops the rest of a scrape.

---

## CLI

```bash
dealhunter serve                      # dashboard + polling scheduler
dealhunter scrape --source govdeals --query "dell latitude"
dealhunter lots --min-margin 40 --category laptops --closing-within 24
dealhunter lot govdeals:GD-100902     # full valuation and cost breakdown
dealhunter sources                    # what's available, enabled, verified
dealhunter rules add --name "Cheap laptops near me" \
    --category laptops --state TX,OK --min-margin 45 --min-profit 300 \
    --slack https://hooks.slack.com/services/...
dealhunter alerts                     # what fired, and whether delivery worked
dealhunter comps import mycomps.csv   # merge your own comps and re-price
dealhunter test-notify default        # prove your webhook works
```

Add `--json` to anything for machine-readable output. Run from cron if you'd
rather not keep a process alive:

```cron
*/15 * * * * cd /srv/dealhunter && node bin/dealhunter.js scrape >> var/cron.log 2>&1
```

## HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, enabled sources, scheduler state |
| `GET` | `/api/stats` | board summary: deals, profit on the table, last run |
| `GET` | `/api/lots` | filter/sort/page the board (same params as the CLI) |
| `GET` | `/api/lots/:id` | one lot with its valuation and price history |
| `GET` | `/api/sources` | sources, with `verified` and repair notes |
| `GET` `POST` `PUT` `DELETE` | `/api/rules[/:id]` | manage alert rules |
| `GET` | `/api/alerts` | recently sent alerts and their delivery results |
| `POST` | `/api/scrape` | run a cycle now (`{"sources":[…],"dryRun":true}`) |
| `POST` | `/api/revalue` | re-price everything after a comps/cost change |

Set `API_TOKEN` and every `/api` route requires `Authorization: Bearer <token>`
(compared in constant time). **Set it before exposing this to anything wider
than localhost.**

## Configuration

`dealhunter.config.json` → environment variables → defaults, last wins. See
`.env.example` and `dealhunter.config.example.json`. The cost model has
per-category overrides (a server ships very differently from a phone), which is
why the file is easier than env vars for tuning.

The defaults are a conservative US reseller's: 10% buyer's premium, 13%
marketplace fee, $150 inbound freight, $15/unit refurb, $18/unit outbound, 90%
sell-through, and a 35% margin / $150 profit / 40% ROI bar. **They are a
starting point, not your business.**

## Storage

An append-only NDJSON log per collection under `var/`, replayed into memory on
start and compacted when it outgrows the live set. It holds thousands of rows,
not millions, and it means `npm install` does nothing at all — no native build,
no database to run. A torn final line from a crash mid-write is dropped and
everything before it survives. The files are greppable.

## Development

```bash
npm test        # 99 tests, no network, no fixtures downloaded
```

Everything network-facing is tested against a local recording server: robots
compliance, retry/backoff, both recipe kinds, webhook/Slack/Discord delivery,
auth, and path traversal. The margin solver is tested by round-tripping — bid
the number it gives you and assert the margin lands where it promised.

```
src/
  config.js          defaults → file → env
  normalize.js       free text → canonical Lot
  taxonomy.js        weighted keyword classification
  pipeline.js        scrape → value → store → alert
  scheduler.js       non-overlapping polling loop
  server.js          JSON API + static dashboard
  query.js           filtering/sorting shared by API and CLI
  sources/           http client, recipe engine, registry, sample source
  valuation/         comps, estimate, margin
  alerts/            rules, matching/dedupe, delivery channels
seed/                comps table + shipped source recipes
web/                 dashboard (no build step)
```

## Legal and etiquette

Scraping these sites is your call and your risk: check each site's terms, keep
the rate limits conservative, and leave `RESPECT_ROBOTS=1` on. This tool is for
finding lots worth a closer look — **it does not bid for you**, and no valuation
here is a substitute for reading the listing, the pickup terms and the seller's
condition notes before you commit money.
