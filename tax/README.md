# Tax Code Reader (private)

A standalone, access-controlled service that **reads U.S. tax law on demand**
from official sources and can **answer questions about it with citations**.

It is intentionally **separate from the casino app** — its own process, its own
port, bound to `localhost` by default, and every API route gated by a token.

## What it covers

| Corpus | Source | Use |
| --- | --- | --- |
| **Internal Revenue Code** — 26 U.S.C. (the statute) | govinfo (GPO) API, with a Cornell LII fallback | the law itself |
| **Treasury / IRS regulations** — 26 C.F.R. | official eCFR API (`ecfr.gov`) | how the IRS interprets the statute |
| **IRS guidance** — Federal Register documents | Federal Register API (`federalregister.gov`) | Treasury Decisions, proposed/final regs, IRS notices |
| **Federal tax case law** | CourtListener API (`courtlistener.com`) | how courts have applied the law |

> **Coverage caveat:** Revenue Rulings and Revenue Procedures are published only
> in the Internal Revenue Bulletin, which has **no public API**, so they are out
> of automated scope. IRS guidance that appears in the Federal Register (the
> bulk of binding rulemaking) **is** covered.

It pulls text **live, on demand** from the official sources — nothing is
bundled, so it never goes stale. Results are cached in-process (6h default).

## What it does

1. **Look up a section** — verbatim text of any Title 26 section.
   Accepts `61`, `§ 61`, `section 162(a)`, `26 USC 1031`, or a regulation like
   `1.61-1`.
2. **Search** — full-text search across the statute and/or regulations.
3. **Ask (AI)** — a plain-English question is answered **using only retrieved
   statute/regulation text**, with section citations and the sources listed for
   verification. Powered by Claude (the same SDK the app already uses).

> This is research assistance, **not legal or tax advice**. Every AI answer is
> grounded in retrieved text and lists its sources so a qualified professional
> can verify before reliance.

## Run it

```bash
cd tax
npm install
cp .env.example .env      # set TAX_ACCESS_TOKEN and (optionally) ANTHROPIC_API_KEY
npm start
```

Open `http://127.0.0.1:4000`, paste the access token, and use the three tabs.
If you didn't set `TAX_ACCESS_TOKEN`, the server prints a generated one at boot.

### Runtime requirements

- **Outbound network access** to `api.govinfo.gov`, `www.ecfr.gov`,
  `www.law.cornell.edu`, `www.federalregister.gov`, and `www.courtlistener.com`.
  If egress is blocked, calls return `ok: false` with the exact URLs that were
  attempted (it degrades cleanly, never crashes).
- **`ANTHROPIC_API_KEY`** only for the **Ask** tab. Lookup and Search work
  without it.
- A free **`GOVINFO_API_KEY`** ([api.data.gov](https://api.data.gov/signup/)) is
  recommended; `DEMO_KEY` works for light use but is rate-limited.
- The Federal Register API needs no key. **`COURTLISTENER_API_TOKEN`**
  ([free](https://www.courtlistener.com/help/api/rest/)) is optional and lifts
  the case-law rate limit.

## API

All routes require `Authorization: Bearer <TAX_ACCESS_TOKEN>` except `/healthz`.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET`  | `/healthz` | — | liveness |
| `GET`  | `/api/config` | — | `{ aiEnabled, model, sources }` |
| `GET`/`POST` | `/api/section` | `?cite=` / `{ citation }` | verbatim statute/regulation section |
| `GET`  | `/api/guidance` | `?doc=<FR doc number>` | full text of an IRS Federal Register document |
| `GET`  | `/api/case` | `?id=<opinion id>` | full text of a court opinion |
| `POST` | `/api/search` | `{ query, scope, limit }` | matching results (`scope`: `all`\|`usc`\|`cfr`\|`guidance`\|`caselaw`) |
| `POST` | `/api/ask` | `{ question, scope?, cite?[] }` | grounded answer + sources used |

```bash
TOKEN=...   # your TAX_ACCESS_TOKEN

curl -s -X POST localhost:4000/api/section \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"citation":"61"}'

curl -s -X POST localhost:4000/api/ask \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"question":"Is cancellation of debt taxable income, and what exclusions apply?"}'
```

## Tests

```bash
npm test      # offline unit tests for citation parsing, markup→text, retrieval prompt
```

The live source fetchers can only be exercised in an environment with outbound
network access; the pure logic they depend on is unit-tested offline.

## Layout

```
tax/
  server.js            Express app: token gate + routes (separate process)
  lib/
    config.js          env-driven configuration
    http.js            fetch wrapper (timeout/retry) + HTML/XML→text
    citation.js        parse/format/route Title 26 citations  (unit-tested)
    cache.js           TTL + LRU cache
    sources/
      usc.js           26 U.S.C. via govinfo (+ Cornell fallback)
      ecfr.js          26 C.F.R. via the eCFR API
      guidance.js      IRS guidance via the Federal Register API
      caselaw.js       federal tax case law via CourtListener
      index.js         unified getSection() / getDocument() / search()
    ai.js              retrieval-augmented answers (Claude)
  public/index.html    private web UI (lookup / search / ask)
  test/parse.test.js   offline unit tests
```
