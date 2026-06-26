# Godel Terminal

A Bloomberg Terminal-style financial dashboard with **real-time market data**.
Six-panel layout: a multi-asset watchlist, market news, a sector treemap
heatmap, candlestick/line charts with an SMA-20 overlay, a company detail
panel, and live market indices.

![panels](https://img.shields.io/badge/panels-6-00c853) ![data](https://img.shields.io/badge/data-real--time-42a5f5)

## Quick start

```bash
npm install
npm start
# open http://localhost:3001
```

Run locally it pulls **real data from Yahoo Finance with no API key**. The
header shows the active data source (e.g. `Yahoo` in green). If no live
provider can be reached it falls back to a built-in market **simulation**
(amber `Simulated` badge) so the UI always works.

## Getting real data

The app pulls live data from the first provider that responds, in this order:

| Provider | Needs key? | Quotes | Charts | News | Notes |
|----------|:---:|:---:|:---:|:---:|-------|
| **Yahoo Finance** | no | ✅ | ✅ | ✅ | Default. Works great locally; can be blocked from cloud/datacenter IPs. |
| **Twelve Data** | yes (free) | ✅ | ✅ | – | Reliable from hosted environments. 800 req/day free. |
| **Finnhub** | yes (free) | ✅ | – | ✅ | Real-time quotes + general market news. 60 req/min free. |
| **Simulation** | no | ✅ | ✅ | ✅ | Realistic fallback when nothing else is reachable. |

### Local

Nothing to configure — Yahoo Finance works out of the box. Just `npm start`.

### Hosted / cloud (Render, Railway, Fly, a VPS, etc.)

Yahoo frequently blocks datacenter IP ranges, so add a free API key for a
reliable feed:

1. Copy the env template: `cp .env.example .env`
2. Get a free key from **[Twelve Data](https://twelvedata.com/pricing)** and/or
   **[Finnhub](https://finnhub.io/register)**.
3. Put it in `.env` (or your host's environment variables):
   ```
   TWELVEDATA_API_KEY=your_key_here
   FINNHUB_API_KEY=your_key_here
   ```
4. Restart. The startup log prints the live source, e.g. `Live market data: twelvedata`.

### Configuration

All optional — see `.env.example` for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Port to listen on. |
| `DATA_PROVIDER` | `auto` | `auto`, `yahoo`, `twelvedata`, `finnhub`, or `simulation`. |
| `TWELVEDATA_API_KEY` | – | Free Twelve Data key. |
| `FINNHUB_API_KEY` | – | Free Finnhub key. |
| `ALLOW_SIMULATION` | `true` | Set `false` to 503 instead of simulating when no provider is reachable. |

Check what's live at any time:

```bash
curl localhost:3001/api/status
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/quotes?symbols=AAPL,MSFT` | Batch quotes. |
| `GET /api/chart?symbol=AAPL&range=1d` | OHLCV chart data. Ranges: `1d 5d 1mo 3mo 1y 5y`. |
| `GET /api/search?q=apple` | Ticker / company search. |
| `GET /api/profile?symbol=AAPL` | Company description. |
| `GET /api/news` | Market headlines. |
| `GET /api/status` | Active provider, configured keys, provider health. |

## How it works

- `server.js` — Express server. A provider chain (`resolve()`) tries each
  real source in priority order, normalizes every response into a common
  shape, caches briefly in-memory, and falls back to the simulation engine.
- `public/js/terminal.js` — vanilla JS front end. Canvas-rendered candlestick
  and line charts (no chart library), a squarified treemap for the sector
  heatmap, and auto-refresh (quotes 15s, charts 60s, news 3m).
- No build step, no front-end framework. Only runtime dependency is `express`.
