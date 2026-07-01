# Solana Meme Coin Scanner

Scan a list of Solana wallets for the tokens they **bought in the last 24 hours**, enrich each token with **DEX Screener** market data, keep only the ones that meet your **market-cap / volume** thresholds, and label each one as an **NA** or **EU** session token using **Chicago Central Time**. Results are printed as a console table and written to JSON + CSV (all / NA / EU).

---

## Architecture at a glance

```
wallets.txt
   │  (addresses)
   ▼
Helius Enhanced Transactions API ──► detect token BUYS in the last 24h
   │                                   (wallet received a token AND spent SOL/USDC/USDT)
   ▼
aggregate by token mint  ──► { wallets[], firstBuyAt, buyTimes[] }   (dedupe; drop SOL/USDC/USDT)
   │
   ▼
DEX Screener /tokens/v1/solana (batched, ≤30 mints/req) ──► name, symbol, mcap, fdv, volume, liquidity, pairCreatedAt…
   │
   ├─► Helius getSignaturesForAddress ──► best-effort TRUE token creation time (else fall back)
   │
   ├─► local ATH store (data/ath-store.json) ──► "highest observed market cap" across runs
   │
   ▼
filters (mcap ≥ $10k, vol ≥ $10k, on Solana, not a base/stable, bought by ≥1 wallet)
   │
   ▼
NA / EU classification (America/Chicago, DST-aware)
   │
   ▼
console table + results.json/csv + results_all/na/eu.json/csv
```

**Why two data providers?** DEX Screener has great token/pair market data but **no wallet transaction history**. Helius provides parsed Solana transactions so we can see what each wallet actually bought. DEX Screener is used only for token/pair market data.

### Files

| File | Purpose |
|---|---|
| `src/config.ts` | All settings (reads `.env`, has defaults). |
| `src/wallets.ts` | Import wallet addresses from `wallets.txt`/CSV. |
| `src/helius.ts` | Wallet transaction parsing + buy detection + token creation time. |
| `src/dexscreener.ts` | Batched DEX Screener market-data helper. |
| `src/filters.ts` | The pass/fail filter logic. |
| `src/session.ts` | NA / EU classification (America/Chicago). |
| `src/athStore.ts` | Local "highest observed market cap" storage. |
| `src/export.ts` | Console table + JSON/CSV writers. |
| `src/scanner.ts` | Orchestrates the whole pipeline. |
| `src/index.ts` | `npm run scan` — run once. |
| `src/scheduler.ts` | `npm run scan:watch` — run every 12h. |
| `src/server.ts` | `npm run serve` — web dashboard API + static hosting. |
| `src/scanState.ts` | In-memory scan status for the dashboard. |
| `public/` | The dashboard frontend (`index.html`, `app.js`, `styles.css`). |
| `src/time.ts` | Timezone/clock helpers (dependency-free). |

---

## Install

Requires **Node.js 18+** (uses the built-in `fetch` and full-ICU timezone support). Node 20/22 recommended.

```bash
npm install
```

## Add your wallets

Edit **`wallets.txt`**. One Solana address per line. Lines starting with `#` and blank lines are ignored. Comma-separated / single-column CSV also works, and duplicates are removed automatically.

```
# my tracked wallets
9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9
```

## Add your API key

```bash
cp .env.example .env
```

Then open `.env` and set `HELIUS_API_KEY` (free at <https://www.helius.dev/>). DEX Screener needs no key. Every other setting has a default — see `.env.example`.

## Run

```bash
npm run scan         # run once
npm run scan:watch   # run now, then every 12 hours
npm run serve        # web dashboard at http://localhost:3000
npm run typecheck    # optional: TypeScript type check
```

Output lands in `output/` (configurable via `OUTPUT_DIR`).

## Web dashboard

`npm run serve` starts a small web app (default <http://localhost:3000>) with a **Run scan** button, a live status indicator, sortable results table, All / NA / EU tabs, and click-to-expand rows showing wallets, timestamps, and the pass reason.

How it's wired (and why it's safe):

- The scan logic runs **server-side**. Your `HELIUS_API_KEY` stays in `.env` on the server and is **never** sent to the browser.
- The browser only talks to this app's own endpoints — it never calls Helius or DEX Screener directly (which would leak the key and hit CORS limits).
- Scans run in the background: `POST /api/scan` returns immediately and the page polls `GET /api/status` until it finishes, so nothing times out on long scans.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/config` | GET | Non-secret settings for display (window, thresholds, timezone). Never returns keys. |
| `/api/status` | GET | `{ scanning, lastRun }` — the page polls this while a scan runs. |
| `/api/results` | GET | The latest results from `output/results.json`. |
| `/api/scan` | POST | Starts a scan in the background. Returns `409` if one is already running. |

Set the port with `PORT` in `.env`. To deploy, host it like any Node web app (Railway/Render/Fly.io/a VPS): set the env vars there (especially `HELIUS_API_KEY`), run `npm install`, and start it with `npm run serve`. The scheduler (`npm run scan:watch`) and the dashboard can run side by side — the dashboard just reads whatever the latest scan wrote.

---

## How the 24-hour scan window works

Each scan computes `since = now − SCAN_WINDOW_HOURS` (default 24h) and only counts buys with a transaction timestamp `>= since`. It always measures **relative to the moment the scan runs**, not to calendar day boundaries. `npm run scan:watch` re-runs every 12h, so consecutive 24h windows overlap by ~12h and nothing between runs is missed.

## How the filters work

A token is returned only if **all** of these are true within the window:

1. Bought by **≥ 1** wallet from your list.
2. `max(marketCap, fdv, observedAthMarketCap)` **≥ `MIN_MARKET_CAP`** (default `$10,000`).
3. 24h volume **≥ `MIN_VOLUME`** (default `$10,000`). If DEX Screener has no `h24` volume, the closest available field (`h6`→`h1`→`m5`) is used, and `volumeField` records which one.
4. Chain is **`solana`**.
5. Token is **not** an ignored base/stable (SOL/USDC/USDT are always ignored; add more via `EXTRA_IGNORED_MINTS`).

Each result carries a `filterReason` string spelling out what passed.

> `MCAP_MODE` (`marketCap` | `fdv` | `observedAth`) only picks which value is shown as the **primary** market cap and which one feeds the observed-ATH snapshot. The pass/fail mcap check above always uses the **best** of the three, matching the spec ("market cap, FDV, **or** highest observed market cap reached at least $10,000").

## How NA and EU categories are calculated

Every token gets a `sessionCategory` of **`NA`** or **`EU`**, using **`America/Chicago`** (so daylight-saving is handled automatically — CDT in summer, CST in winter):

- **NA** — timestamp falls between **10:00:00 AM and 9:59:59 PM** Chicago time.
- **EU** — timestamp falls between **10:00:00 PM and 9:59:59 AM** Chicago time (wraps past midnight).

These boundaries are configurable (`NA_START`, `NA_END`, `EU_START`, `EU_END`). NA and EU are complementary; the NA window is the source of truth and everything else is EU.

### Which timestamp is used for NA/EU classification

Priority order (first available wins):

1. **True token creation time** (from Helius), if resolved.
2. **DEX Screener `pairCreatedAt`** (pool/pair creation), if token creation time is unavailable.
3. **First detected wallet buy time**, if neither of the above is available.

Each result includes a `sessionCategoryReason`, e.g.:

- `Classified as NA using token creation time`
- `Classified as EU using DEX Screener pairCreatedAt`
- `Classified as NA using first wallet buy time`

## What DEX Screener can and cannot provide

**Can:** name, symbol, pair address, DEX Screener URL, current market cap, FDV, liquidity (USD), 24h volume, 24h price change, 24h buys/sells, `pairCreatedAt`, chain, DEX id.

**Cannot:**
- **Wallet-level transaction history** → that's why Helius is used to find buys.
- **True all-time-high market cap** → we build an **observed ATH** locally (see below).
- **A guaranteed true token mint creation time** → `pairCreatedAt` is the **pool** creation time, not the token's. We try to resolve the true creation time from Solana, and only fall back to `pairCreatedAt` (clearly labeled) when we can't.

### Difference between token creation time and pair creation time

- **Token creation time** = when the SPL token **mint** was first created on-chain. We resolve this best-effort by paging back to the mint account's earliest signature via Helius. On the token object this is `tokenCreatedAt` with `tokenCreatedAtSource: "token"`.
- **Pair creation time** (`pairCreatedAt`) = when the **liquidity pool / trading pair** was created on a DEX. It's usually *after* the token was minted. If we can't confirm the true token creation time, the output leaves `tokenCreatedAt` null and the session classification transparently uses `pairCreatedAt` instead (and says so in `sessionCategoryReason`).

### How "highest observed market cap" is calculated

Because no free source gives a token's real historical ATH market cap, this scanner **builds its own** over time. Every run writes a market-cap snapshot per token to `data/ath-store.json` and keeps the running maximum (`observedAthMarketCap`). **This only reflects the moments the scanner actually ran** — it is *not* the token's true ATH, and it starts accumulating the first time you scan a given token. Run more often (e.g. `scan:watch`) for a fuller picture. Delete `data/ath-store.json` to reset it.

## How to schedule it every 12 hours

```bash
npm run scan:watch
```

This runs immediately, then every 12h (`SCHEDULE_INTERVAL_HOURS`), each time looking back 24h. It's a simple in-process loop, so keep the process alive with your tool of choice, e.g.:

```bash
# pm2
npm i -g pm2
pm2 start "npm run scan:watch" --name memecoin-scanner

# or a plain cron running the one-shot version twice a day (crontab -e):
0 */12 * * * cd /path/to/solana-memecoin-scanner && /usr/bin/npm run scan >> scan.log 2>&1
```

---

## Configuration reference (`.env`)

| Key | Default | Meaning |
|---|---|---|
| `HELIUS_API_KEY` | — | **Required.** Helius API key. |
| `SCAN_WINDOW_HOURS` | `24` | Look-back window per scan. |
| `MIN_MARKET_CAP` | `10000` | Min market cap / FDV / observed ATH. |
| `MIN_VOLUME` | `10000` | Min 24h volume. |
| `MCAP_MODE` | `marketCap` | Primary mcap metric: `marketCap` \| `fdv` \| `observedAth`. |
| `EXTRA_IGNORED_MINTS` | — | Extra mints to ignore (comma-separated). |
| `TIMEZONE` | `America/Chicago` | IANA timezone for NA/EU. |
| `NA_START` / `NA_END` | `10:00 AM` / `10:00 PM` | NA window (Chicago). |
| `EU_START` / `EU_END` | `10:00 PM` / `10:00 AM` | EU window (Chicago). |
| `OUTPUT_DIR` | `output` | Where result files go. |
| `REQUEST_DELAY_MS` | `300` | Delay between API requests. |
| `MAX_RETRIES` | `4` | Retries on 429/5xx/network errors. |
| `RETRY_BACKOFF_MS` | `1500` | Base backoff (×attempt). |
| `DEX_BATCH_SIZE` | `30` | Mints per DEX Screener request (max 30). |
| `MAX_TX_PAGES_PER_WALLET` | `20` | Cap on tx pages per wallet (100 tx/page). |
| `RESOLVE_TOKEN_CREATION_TIME` | `true` | Try to resolve true token creation time. |
| `MAX_SIG_PAGES_PER_MINT` | `5` | Cap on signature pages when resolving creation time. |
| `SCHEDULE_INTERVAL_HOURS` | `12` | Interval for `scan:watch`. |
| `WALLETS_FILE` | `wallets.txt` | Wallet list path. |
| `ATH_STORE_FILE` | `data/ath-store.json` | Observed-ATH storage path. |

## Output fields (per token)

`name`, `symbol`, `contractAddress` (= `mint`), `tokenCreatedAt`, `tokenCreatedAtSource`, `pairCreatedAt`, `sessionCategory`, `sessionCategoryReason`, `sessionTimestampUsed`, `sessionTimestampSource`, `marketCap`, `fdv`, `primaryMcap`, `observedAthMarketCap`, `volume24h`, `volumeField`, `liquidityUsd`, `priceUsd`, `priceChange24h`, `chainId`, `dexId`, `buys24h`, `sells24h`, `pairAddress`, `dexScreenerUrl`, `wallets`, `firstBuyAt`, `detectedAt`, `filterReason`.

> On Solana, the **contract address is the token mint address** — both `contractAddress` and `mint` are always populated with it.

## Rate limits & batching

- DEX Screener token endpoint: batched ≤30 mints/request, ~300 req/min limit; a `REQUEST_DELAY_MS` pause sits between batches and wallet fetches.
- All HTTP goes through a retry helper that honors **HTTP 429** (`Retry-After` if present, else exponential backoff), retries **5xx** and transient network errors, and fails fast on other 4xx. It never hammers an endpoint.

## Common errors and how to fix them

| Symptom | Fix |
|---|---|
| `HELIUS_API_KEY is not set` | Copy `.env.example` → `.env` and add your key. |
| `Wallets file not found` | Create `wallets.txt` (or set `WALLETS_FILE`) with addresses. |
| `No valid Solana wallet addresses found` | Check the addresses are valid base58 Solana pubkeys. |
| Lots of `HTTP 429` warnings | Increase `REQUEST_DELAY_MS`, lower `DEX_BATCH_SIZE`, or check your Helius plan limits. |
| A wallet returns 0 buys but you expected some | Buys are only counted if the wallet **received a token AND spent SOL/USDC/USDT** in the same tx; pure transfers/airdrops are intentionally excluded. Also confirm the buy is within the window. |
| `tokenCreatedAt` is null / uses `pairCreatedAt` | Expected for very active mints — resolving the true first signature can exceed `MAX_SIG_PAGES_PER_MINT`. Raise that cap (costs more API calls) or accept the labeled `pairCreatedAt` fallback. |
| Token missing from results | It probably isn't listed on DEX Screener, or didn't meet the mcap/volume thresholds. |
| `fetch is not defined` | You're on Node < 18. Upgrade to Node 18+ (20/22 recommended). |
| Wrong NA/EU near midnight/DST | Confirm `TIMEZONE=America/Chicago` and that your Node build has full ICU (default on official Node 18+). |

## Notes & limitations

- **Buy detection is a heuristic**, not a full DEX-router decoder. It favors precision (require token-in + base-token-out) to avoid counting airdrops. Unusual swap routes may occasionally be missed.
- **Observed ATH ≠ true ATH.** See above.
- This tool is for research/analytics on public on-chain and market data. It is **not** financial advice.
