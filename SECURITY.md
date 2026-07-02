# Security model

This is a play-money web app — **not** a real-money or licensed gambling
operator. The security posture below covers the application code only; an
operator running this in production is responsible for legal compliance,
KYC/AML, sanctions screening, geo-blocking, custody, payment processing,
and similar regulatory work. See the README's warning paragraph.

## Authentication

- **Password hashing:** Argon2id (current OWASP recommendation), with the
  legacy scrypt format still verifiable for accounts created before the
  cutover. Legacy hashes are transparently upgraded to argon2id on the next
  successful login.
- **Password policy:** ≥ 8 characters, top-22 common-password blocklist,
  rejects passwords containing the username.
- **Username-enumeration timing:** an argon2 verify is performed against a
  dummy hash even when the user doesn't exist, so login latency doesn't
  reveal whether the username is registered.
- **Account lockout:** per-username, 5 failed attempts within 15 min
  (configurable via `LOCKOUT_THRESHOLD` / `LOCKOUT_WINDOW_MS`) returns 429.
  Lockout-deflected attempts are intentionally not counted as new fails.
- **Sessions:** stateless signed cookie (`cs_session`), HMAC-SHA256 with a
  per-instance `SESSION_SECRET`. Tokens are versioned (`v2`) and carry an
  issued-at timestamp — enforced server-side (30 days), so a stolen token
  expires even if the cookie attributes are stripped — plus a per-user
  `session_epoch`. Changing your password bumps the epoch, which instantly
  invalidates every other session for that account. `HttpOnly`,
  `SameSite=Lax`, `Secure` when `SECURE_COOKIES=1`.
- **Lockout integrity:** the failed-attempt write is awaited before the
  response is sent, so rapid parallel login attempts can't race past the
  lockout threshold while earlier failures are still in flight.

## CSRF

- Double-submit cookie pattern. A non-`HttpOnly` `csrf` cookie is auto-issued
  on the first request; the client echoes it back as `X-CSRF-Token` on every
  `POST`/`PUT`/`PATCH`/`DELETE`. Mismatch → 403. The comparison is
  constant-time (`crypto.timingSafeEqual`).
- The CoinPayments IPN webhook (`/api/vault/webhook`) is intentionally exempt
  — it authenticates via an HMAC-SHA512 signature over the raw body instead.

## Admin

- Admin endpoints are gated by a `requireAdmin` middleware backed by an
  `is_admin` column (promoted at boot via `ADMIN_USERNAME`, or by another
  admin). All admin mutations (balance changes, locks, promotions) are
  written to the audit log as `admin.*` events with the acting admin's id.
- Self-demotion is rejected so the last admin can't lock themselves out.
- Locked accounts are refused at login *and* on every authenticated request,
  so locking a user kills their live sessions too.

## Transport / browser headers

- `Content-Security-Policy`: `default-src 'self'`, strict `script-src 'self'`
  (no inline / no eval / no remote JS), `style-src 'self' 'unsafe-inline'`
  (needed for the games' inline styles), `img-src 'self' data:`,
  `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
  in production.
- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, `Permissions-Policy` (denies geolocation, camera, mic,
  payment, USB, FLoC),  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`.
- `x-powered-by` disabled.
- `Cache-Control: no-store` on every `/api` response — balances, audit rows
  and session state never land in the browser or proxy cache.

## Rate limiting

- In-memory, per-IP fixed window. Defaults: global API 300/min, auth
  (login + register) 40 / 15 min, dealer AI line 30/min. All overridable
  via env vars (`RATE_API_MAX`, `RATE_AUTH_MAX`, `RATE_DEALER_MAX`).
- For multi-instance deploys, replace this with a shared store
  (Redis/Memcached) so limits hold across replicas.

## Server-authoritative game logic

- Every wager is debited atomically with a conditional `UPDATE` that doubles
  as both an availability check and a balance write — no two parallel bets
  can overdraw the same account.
- All draws come from a per-user provably-fair HMAC stream
  (`HMAC-SHA256(server_seed, "clientSeed:nonce:round")`); the server seed is
  pre-committed (SHA-256 hash exposed) and the player can rotate at any time
  to reveal the seed and recompute every past roll.

## Audit log

- `audit_log` table records: `user.register`, `auth.login_success`,
  `auth.login_fail`, `auth.lockout_hit`, `auth.logout`,
  `auth.password_change`, `auth.password_change_fail`, `security.csrf_fail`,
  `vault.deposit_created`, `vault.deposit_completed`,
  `vault.deposit_cancelled`. Each entry includes IP, User-Agent, JSON meta,
  and timestamp.
- `login_attempts` table is the source of truth for the lockout window.
- Users can query their own audit trail via `GET /api/auth/audit`.

## Prompt injection (AI dealer)

- Client-supplied `ctx` fed to the Claude API is hard-coerced to bounded
  integers (`playerTotal`, `dealerTotal`); no user-controlled strings ever
  reach the system or user prompt.
- The system prompt explicitly tells the model to stay in character, never
  reveal it's an AI, never give strategy advice, and return ≤ 12 words.

## Crypto vault (backend)

- Ships with a `playmoney` processor that returns plausibly-shaped but fake
  addresses and txids and credits CRYPT credits up to a per-day cap (default
  5000 CRYPT). The real-money path requires plugging a licensed processor
  (NowPayments, Coinpayments, BTCPayServer…) into the same adapter
  interface — `confirmDeposit` is rejected at runtime when the processor
  isn't `playmoney`, forcing real settlements through verified webhooks.
- Per-user `MAX_PENDING_DEPOSITS` (default 5) prevents orphan-row spam.
- Cap is re-checked atomically inside the settlement transaction, so
  parallel-deposit races can't exceed the cap.

## Reporting

This is a personal project — no bug bounty. If you find something serious,
open a private issue or email the repo owner.
