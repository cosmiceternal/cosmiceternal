# Crypt Casino

A **play-money**, provably-fair casino with **25 games** — including an **AI Dealer**
(personable AI croupiers hosting real provably-fair Blackjack, with switchable
personalities and reactive banter) — real user accounts, and a server-authoritative
backend. Built with vanilla JS on the front end and Node + Express
on the back end (Postgres in production, SQLite for local dev), so it deploys as a single
service to any Node host.

Games: Crash, AI Dealer, Mines, Towers, Pump, Penalty Shootout, Cascade, Limbo, Plinko,
Dice, Hi-Lo, Blackjack, Video Poker, Baccarat, Dragon Tiger, Andar Bahar, Wheel, Roulette,
Keno, Sic Bo, Diamonds, Slots, Coin Flip, Scratch and Color.

> ⚠️ **Play money only.** Balances are fun credits with no cash value. This is a hobby /
> learning project, not a real gambling service. Operating a real-money casino is
> regulated and illegal without a licence in most jurisdictions — don't.

---

## Features

- **Accounts** — register / sign in, sessions via signed `HttpOnly` cookies, scrypt-hashed
  passwords. Balance persists server-side and follows you across devices and browsers.
- **Server-authoritative play** — every wager is validated and settled on the server.
  The client only renders results; it can't change outcomes or balances.
- **True provably-fair** — the server seed lives on the server; you only get its SHA-256
  hash (a commitment) up front. Rotate the seed any time to reveal the original and
  recompute every past roll yourself (see [Verifying fairness](#verifying-fairness)).
- **19 games**, all provably fair and server-settled:
  - *Multiplier & climb:* Crash, Limbo, Towers, Pump (escalating-risk meter), Plinko.
  - *Cards:* Blackjack (3:2, double), Video Poker (Jacks or Better), Hi-Lo.
  - *Wheels & tables:* Wheel (low/mid/high risk), Roulette (European), Sic Bo.
  - *Picks & instants:* Mines, Keno, Dice, Diamonds, Slots, Coin Flip (streak), Scratch, Color.
- **Stats & history** — per-account bet history feed and a stats panel (wagered, net
  profit, win rate, biggest win).
- Sleek dark UI, green accents, canvas animations, toasts.

---

## Quick start (local)

Requires **Node 18+**.

```bash
npm install
npm start
# open http://localhost:3000
```

For auto-reload during development:

```bash
npm run dev
```

The SQLite database is created automatically at `./data/neonstake.db` on first run.

---

## Storage

The data layer is dual-mode and picks itself automatically:

- **Local dev:** no setup — it uses **SQLite** (`./data/neonstake.db`).
- **Production:** set **`DATABASE_URL`** and it uses **PostgreSQL** instead, so accounts
  and balances persist across restarts. Works out of the box with free tiers like
  [Neon](https://neon.tech) or Render Postgres. Schema is created automatically on boot.

## Configuration

All optional — see `.env.example`. Copy it to `.env` and edit, or set real environment
variables on your host.

| Variable                  | Default               | Purpose                                                                  |
| ------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`            | _(unset)_             | Postgres connection string. If set, Postgres is used (else SQLite).      |
| `PORT`                    | `3000`                | Port to listen on.                                                       |
| `DB_PATH`                 | `./data/neonstake.db` | SQLite file path (only when `DATABASE_URL` is unset).                    |
| `SESSION_SECRET`          | generated & stored    | Cookie-signing secret. **Set this explicitly in production.**            |
| `STARTING_BALANCE`        | `1000`                | Starting play-money balance for new accounts.                            |
| `SECURE_COOKIES`          | `0`                   | Set to `1` to require HTTPS-only cookies (enable in prod).               |
| `LOCKOUT_THRESHOLD`       | `5`                   | Failed logins before per-username lockout fires.                         |
| `LOCKOUT_WINDOW_MS`       | `900000` (15 min)     | Lockout window length.                                                   |
| `RATE_API_MAX`            | `300`                 | Per-IP API requests per minute.                                          |
| `RATE_AUTH_MAX`           | `40`                  | Per-IP login/register attempts per 15 min.                               |
| `RATE_DEALER_MAX`         | `30`                  | Per-IP AI-dealer line requests per minute.                               |
| `ANTHROPIC_API_KEY`       | _(unset)_             | If set, AI Dealer generates live banter via Claude (falls back when unset).|
| `DEALER_MODEL`            | `claude-haiku-4-5-…`  | Model id for the AI Dealer.                                              |
| `VAULT_PROCESSOR`         | `playmoney`           | Crypto-vault adapter. Real processors plug in by config.                 |
| `DAILY_DEPOSIT_CAP_CRYPT`   | `5000`                | Per-user per-day cap (in CRYPT) on play-money deposits.                    |
| `MAX_PENDING_DEPOSITS`    | `5`                   | Per-user limit on in-flight (pending) deposits.                          |

See [`SECURITY.md`](SECURITY.md) for the full security model (argon2id, account
lockout, CSRF, CSP/HSTS, audit log, server-authoritative wagers, prompt-injection
guarding on the AI dealer).

---

## Let a friend try it

### Fastest: share it right now with a tunnel

If it's running locally (`npm start`), expose it with a temporary public URL — no deploy,
no account. Pick one:

```bash
# Cloudflare (no install if you have it; gives a https://*.trycloudflare.com URL)
cloudflared tunnel --url http://localhost:3000

# or ngrok
ngrok http 3000

# or one-off via npx
npx localtunnel --port 3000
```

Send the printed URL to your friend. It stays live only while your machine and the tunnel
are running — great for a quick "check this out," not for permanent hosting.

### Durable: one-click deploy to Render (free, public link)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/cosmiceternal/cosmiceternal)

Click the button (or Render → **New → Blueprint** on this repo). The included
[`render.yaml`](render.yaml) provisions a **free PostgreSQL database**, wires it to the web
service, generates a session secret, and gives you a public URL like
`https://neonstake.onrender.com` to share — HTTPS included, no domain needed. Because it
uses Postgres, **accounts and balances persist** across restarts.

Heads-up on the free tier: the web service sleeps when idle (first hit takes ~30s to wake),
and Render's free Postgres has a limited lifetime (they email you before it expires).
Upgrade either to a paid plan to remove those limits, or point `DATABASE_URL` at a
[Neon](https://neon.tech) free database for longer-lived storage.

## Going from demo to live

The demo deploys with `VAULT_PROCESSOR=playmoney` so the deposit flow visually
works without real money — perfect for showing a friend. To accept real crypto
deposits later, the wiring is already in place; you just plug in credentials.

1. **Deploy:** Render Blueprint → connect repo → Apply.
2. **(Optional)** Set `ANTHROPIC_API_KEY` in the Render dashboard for live
   AI Dealer banter. Without it the dealer falls back to the scripted persona
   library (still good, just less surprising).
3. **To accept real crypto deposits via CoinPayments:**
   1. Create a [CoinPayments](https://www.coinpayments.net/) account.
      Generate an API key + secret under **Account → API Keys**, and copy
      your **IPN Secret** (Account Settings → Merchant Settings) and
      **Merchant ID**.
   2. In Render → your web service → **Environment**, set:
      - `COINPAYMENTS_KEY`
      - `COINPAYMENTS_SECRET`
      - `COINPAYMENTS_IPN_SECRET`
      - `COINPAYMENTS_MERCHANT_ID`
      - `VAULT_PROCESSOR=coinpayments`
   3. In CoinPayments → Account Settings → set the **IPN URL** to
      `https://<your-render-url>/api/vault/webhook`.
   4. Redeploy. The Vault modal now creates real deposits; settlement happens
      automatically via the IPN webhook (the client polls history every 5s
      to show the confirmation when it lands).
4. **Compliance is on you.** Running a real-money casino is regulated.
   Verify your licence covers the jurisdictions you accept players from
   and add geo-blocking / KYC / sanctions checks before going live.

## Deploying to your own domain

It's one Node service that serves both the API and the static front end, so any Node host
works. Three easy options:

### Option A — Render (free tier, simplest)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Web Service**, connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Add a **Disk** (e.g. 1 GB) mounted at `/data`, and set `DB_PATH=/data/neonstake.db`
   so accounts survive restarts/deploys.
5. Add env vars: `SESSION_SECRET` (a long random string) and `SECURE_COOKIES=1`.
6. Deploy. Then **Settings → Custom Domain**, add `yourdomain.com`, and create the
   `CNAME` record your registrar shows. Render provisions HTTPS automatically.

### Option B — Railway / Fly.io

Same idea: Node web service, `npm start`, attach a volume for `DB_PATH`, set
`SESSION_SECRET` + `SECURE_COOKIES=1`, then point your domain's `CNAME`/`A` record at the
service and enable TLS.

### Option C — Your own VPS

```bash
git clone <your repo> && cd crypt-casino
npm install --omit=dev
SESSION_SECRET="$(openssl rand -hex 32)" SECURE_COOKIES=1 PORT=3000 npm start
```

Put Nginx/Caddy in front for TLS and proxy `yourdomain.com → localhost:3000`.

> **Note:** plain static hosts like GitHub Pages **won't** work anymore — there's a real
> backend now. You need a host that runs Node.

---

## Architecture

```
public/                 static front end (served by the API server)
  index.html
  css/style.css
  js/
    api.js              fetch wrapper for the backend
    app.js              auth gate, routing, Fair + Stats modals, toasts
    bankroll.js         balance display (server is source of truth)
    fair.js             provably-fair UI (talks to /api/fair)
    feed.js             your-bets feed (from /api/history)
    games/{crash,mines,plinko,dice}.js   render server-settled results

server/
  index.js              Express app: API routes + static hosting
  db.js                 dual-driver async storage (Postgres if DATABASE_URL, else SQLite)
  auth.js               register/login, scrypt hashing, cookie sessions
  fair.js               per-user seeds, nonce, HMAC outcome draws
  games.js              all wager logic + atomic balance/history writes
```

### API overview

| Method & path                | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `POST /api/auth/register`    | Create account, start session             |
| `POST /api/auth/login`       | Sign in                                   |
| `POST /api/auth/logout`      | Clear session                             |
| `GET  /api/me`               | Current user / balance                    |
| `GET  /api/fair`             | Server-seed hash, client seed, nonce      |
| `POST /api/fair/client`      | Change client seed (resets nonce)         |
| `POST /api/fair/rotate`      | Reveal old server seed, mint a new one    |
| `POST /api/play/dice`        | Settle a dice bet                         |
| `POST /api/play/plinko`      | Settle a plinko drop                      |
| `POST /api/play/crash`       | Settle a crash bet (vs. auto-cashout)     |
| `POST /api/play/mines/*`     | `start` / `reveal` / `cashout`            |
| `GET  /api/history`          | Recent bets                               |
| `GET  /api/stats`            | Aggregate stats                           |

---

## Verifying fairness

Each outcome float is derived from:

```
HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}:${round}`)
```

The first 4 bytes become a fraction in `[0, 1)`:

```
f = b0/256 + b1/256² + b2/256³ + b3/256⁴
```

(Each HMAC yields 8 floats from its 32 bytes; `round` increments when a game needs more.)
Because you're shown `SHA256(serverSeed)` **before** you play, the server can't change the
seed after the fact. Hit **Rotate Server Seed** in the Fair panel to reveal the seed it was
using, then confirm `SHA256(revealedSeed)` equals the hash you were shown — and replay any
past nonce to reproduce the exact result.

---

## Disclaimer

For entertainment and educational use only. No real currency, deposits, or withdrawals.
Please gamble responsibly in real life — and if gambling is a problem for you or someone
you know, seek help from a local support service.
