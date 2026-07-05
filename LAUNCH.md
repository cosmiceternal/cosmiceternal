# Launch runbook

The one-time launch takes about five minutes and three clicks. After it,
updates merged to `main` deploy themselves — you never need GitHub or a
terminal again.

## 1. Deploy (one time)

1. Open: **https://render.com/deploy?repo=https://github.com/cosmiceternal/cosmiceternal**
2. Sign in to Render (the free plan needs no card). It will ask to connect
   your GitHub account — approve it; this is the only GitHub interaction.
3. Click **Apply**. Render builds the app, provisions the PostgreSQL
   database, generates the session secret, and gives you a URL like
   `https://crypt-casino-xxxx.onrender.com`.

Your casino is now live at that URL, in play-money mode.

## 2. Claim your admin account (two minutes)

1. Open your live URL, **register** the account you want to own the casino.
2. Render dashboard → **crypt-casino** → **Environment** → set
   `ADMIN_USERNAME` to that username → **Save** (the service restarts
   itself).
3. Refresh the casino, sign in — the **⚡ Admin** button appears. From there
   you control users, balances, locks and withdrawal approvals.

## 3. Optional switches (any time, no code)

All in Render → **Environment**:

| Setting | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | AI Dealer speaks with live Claude-generated banter |
| `STARTING_BALANCE`  | Play-money credits new accounts start with |
| `DAILY_DEPOSIT_CAP_CRYPT` / `DAILY_WITHDRAW_CAP_CRYPT` | Vault caps |
| `COINPAYMENTS_*` + `VAULT_PROCESSOR=coinpayments` | Real crypto deposits/withdrawals (see below) |

## 4. Going real-money (when your licence and compliance are in place)

1. Create a CoinPayments account → API key + secret, IPN secret, merchant ID.
2. Fill the four `COINPAYMENTS_*` variables in Render, set
   `VAULT_PROCESSOR=coinpayments`.
3. In CoinPayments settings, point the IPN URL at
   `https://<your-url>/api/vault/webhook`.
4. Deposits then settle via signed webhooks; withdrawals queue as `pending`
   and you approve them in the ⚡ Admin → Withdrawals tab.

> Real-money operation is regulated. Confirm your licence covers your target
> jurisdictions and add KYC/geo-blocking before flipping the switch.

## 5. Free tier → launch tier

The free web service sleeps when idle (first visit takes ~30 s to wake) and
free Postgres has a limited lifetime. For a real launch: dashboard →
service → **Settings → Instance Type → Starter**, and database → **Basic**.
No code changes.

## 6. Custom domain (optional)

Dashboard → service → **Settings → Custom Domains** → add
`yourdomain.com` → create the CNAME record it shows you at your registrar.
HTTPS is provisioned automatically.

## Day-to-day operation

- **Updates:** merged to `main` → live automatically (`autoDeploy` in
  `render.yaml`). Watch progress in the dashboard's **Events** tab.
- **Health:** `https://<your-url>/healthz` returns `{"ok":true}`.
- **Logs:** dashboard → **Logs** (5xx and slow requests are single JSON
  lines).
- **Admin:** everything player-facing is in the ⚡ Admin console in the app
  itself.
