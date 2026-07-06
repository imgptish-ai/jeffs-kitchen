# Solana Meme Coin Scanner

Manually trigger a scan of your Solana wallets for tokens **created 8–16 hours before the moment you click Run**, enrich each token with **DEX Screener** market data, keep only the ones that meet your **peak market-cap / volume** thresholds, and label each one as an **NA** or **EU** session token using **Chicago Central Time**. Results are printed as a console table and written to JSON + CSV (all / NA / EU).

There is **no automatic schedule** — every scan happens because you clicked the button. Each click uses "now" (the moment you click) as its clock: it never looks at a fixed calendar window, only at the token's age relative to your click.

---

## Architecture at a glance

```
You click "Run workflow" (no schedule — manual only)
   │
wallets.txt
   │  (addresses)
   ▼
Helius Enhanced Transactions API ──► detect token BUYS in the wallet-buy lookback
   │                                   (wallet received a token AND spent SOL/USDC/USDT)
   │                                   (lookback auto-sized to cover the creation-age band)
   ▼
aggregate by token mint  ──► { wallets[], firstBuyAt, buyTimes[] }   (dedupe; drop SOL/USDC/USDT)
   │
   ▼
DEX Screener /tokens/v1/solana (batched, ≤30 mints/req) ──► name, symbol, mcap, fdv, volume, liquidity, pairCreatedAt, socials…
   │
   ├─► Helius getSignaturesForAddress ──► best-effort TRUE token creation time (else fall back)
   │
   ├─► GeckoTerminal daily candles ──► estimated real PEAK market cap (free, no key, no Helius cost)
   │
   ├─► local ATH store (data/ath-store.json) ──► "highest observed market cap" across runs
   │
   ▼
filters (peak mcap in [floor,ceiling], vol ≥ min, on Solana, not a base/stable,
         bought by ≥1 wallet, optional X-link, age in [min,max]h as of click time)
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
npm run scan         # run once, right now
npm run serve        # web dashboard at http://localhost:3000
npm run typecheck    # optional: TypeScript type check
```

Output lands in `output/` (configurable via `OUTPUT_DIR`).

The GitHub Actions workflow (`.github/workflows/scan.yml`) is **manual-only by design** — it has no schedule, only a "Run workflow" button on the Actions tab. `npm run scan:watch` still exists in `src/scheduler.ts` if you ever want a local, always-on loop on your own machine, but it's entirely separate from the GitHub Action and nothing runs it automatically.

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

## How timing works: manual clicks, not a schedule

There's no cron, no auto-run — a scan only happens when you click **Run workflow** (in GitHub Actions) or run `npm run scan` yourself. The moment you click **is** "now" for that scan: every age and timestamp is computed relative to it, never against a fixed calendar window.

Two settings work together:

- **`CREATION_MIN_AGE_HOURS` / `CREATION_MAX_AGE_HOURS`** (default `8` / `16`) — the token must have been created between this many hours ago, as of your click. This is the setting that actually matters day-to-day.
- **`SCAN_WINDOW_HOURS`** — how far back the scanner looks for *wallet buys*. Leave it unset and it **auto-derives to match `CREATION_MAX_AGE_HOURS`**: that's the minimum lookback needed to guarantee catching a buy of a token that could still fall in the creation-age band (a token created 16h ago could have been bought any time between then and now, so the buy search has to reach at least that far back). You only need to touch `SCAN_WINDOW_HOURS` yourself if you deliberately want a wider buy search than that.

## How the filters work

The market-cap band is applied to each coin's **estimated peak (ATH) market cap**, not its current value — so it answers "how high did this coin ever get?"

A token is returned only if **all** of these are true within the window:

1. Bought by **≥ 1** wallet from your list.
2. Estimated **peak market cap ≥ `MIN_MARKET_CAP`** (default `$10,000`) — it did reach the floor.
3. Estimated **peak market cap ≤ `MAX_MARKET_CAP`** (default `$25,000`) — it never blew past the ceiling. Set `MAX_MARKET_CAP=0` to turn the ceiling off.
4. 24h volume **≥ `MIN_VOLUME`** (default `$10,000`). If DEX Screener has no `h24` volume, the closest field (`h6`→`h1`→`m5`) is used, recorded in `volumeField`.
5. Chain is **`solana`**.
6. Token is **not** an ignored base/stable (SOL/USDC/USDT are always ignored; add more via `EXTRA_IGNORED_MINTS`).
7. *(optional)* Has an **X/Twitter link** listed on DEX Screener, if `REQUIRE_X_LINK=true`. Off by default. This is a cheap check (comes from the same DEX Screener response, no extra API calls) and is applied early, so it also skips the expensive peak/creation-time lookups for tokens without one — saving time and Helius credits.
8. *(optional, on by default)* Token's **age at scan time** falls inside **`[CREATION_MIN_AGE_HOURS, CREATION_MAX_AGE_HOURS]`** — default **8–16 hours old, as of the moment you click Run**. Not just bought recently — the token itself has to be that new. See below for exactly how this is judged.

### How the creation-age band is judged

Age is computed as `(now − creation timestamp)`, where "now" is the instant you clicked Run. It uses true token creation time when it's resolvable, and otherwise falls back to DEX Screener's `pairCreatedAt` — labeled honestly via `creationTimestampSource` in the filter reason (`[token]` or `[pair]`). If **neither** is available, the token is excluded — an unknown age is never assumed to be valid.

There's a free optimization built on one structural fact: a trading pair can never be created before the token it trades exists, so `pairCreatedAt` is always ≥ true token creation time. That means if the pair itself is already older than `CREATION_MAX_AGE_HOURS`, the token is guaranteed to be older too — so the scanner skips the expensive Helius creation-time lookup entirely for those tokens, saving both time and Helius credits before it ever gets that far. The "too young" side can't be pre-proven the same way (a pair can lag well behind true token creation — e.g. a pump.fun bonding-curve token that migrates to a new DEX pool much later), so that side always needs the real lookup, or the honest `pairCreatedAt`-based fallback if that lookup is disabled.


Each result carries a `filterReason` string spelling out what passed, plus `athEstimate` (the number the band was tested against) and `peakConfidence`.

### How the peak (ATH) is estimated

DEX Screener only reports *current* market cap — it has no all-time-high field. To get a real peak we query **GeckoTerminal** (free, no API key, and it does **not** use your Helius quota) for the token's **daily price candles**. Each daily candle's high is the true high for that day, so the maximum high across the coin's available history is a genuine peak price. We convert it to a peak market cap by scaling the current market cap by `peakPrice / currentPrice` (assuming supply is ~constant, which holds for typical memecoins).

The band is tested against the **most conservative** number we have:

```
athEstimate = max(history-based peak, observed ATH across runs, current marketCap, current fdv)
```

Using the max matters for the ceiling: if **any** reliable signal says the coin was once bigger than `MAX_MARKET_CAP`, it's excluded — which is exactly what stops a coin that pumped to $400k and fell back to $18k from sneaking into a "$10k–$25k" screen.

`peakConfidence` is `history` when a GeckoTerminal peak was available, or `observed-or-current` when it fell back (older than ~6 months, pool not on GeckoTerminal, etc.). In the dashboard, fallback peaks are marked with a `*`.

**Honest limitation:** GeckoTerminal history goes back ~6 months and depends on the pool being tracked there. A peak older than that, or on an untracked pool, won't be captured — in that case the coin falls back to `observed-or-current`, which is weaker. For brand-new memecoins (the usual case here) the daily history covers their whole life, so the peak is reliable.

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

## Running it manually vs. on a schedule

**Default: fully manual.** The GitHub Actions workflow has no cron trigger — nothing runs unless you click **Run workflow** on the Actions tab. Every click uses that moment as "now" for the creation-age band (default: keep tokens created 8–16h before your click).

**If you ever want automatic runs instead**, two options, both opt-in:

- **Re-add a schedule to the GitHub Action** — add a `schedule:` trigger back into `.github/workflows/scan.yml` (see git history for the original `cron: "0 */12 * * *"` example, or GitHub's [cron syntax docs](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)). If you do this, also raise `CREATION_MAX_AGE_HOURS` to comfortably exceed your interval so the age band doesn't miss tokens between runs.
- **Run a local always-on loop** — `npm run scan:watch` (in `src/scheduler.ts`) runs immediately, then every `SCHEDULE_INTERVAL_HOURS` (default 12h), independent of GitHub entirely:

  ```bash
  npm run scan:watch
  ```

  Keep the process alive with a tool like pm2:

  ```bash
  npm i -g pm2
  pm2 start "npm run scan:watch" --name memecoin-scanner
  ```

---

## Configuration reference (`.env`)

| Key | Default | Meaning |
|---|---|---|
| `HELIUS_API_KEY` | — | **Required.** Helius API key. |
| `SCAN_WINDOW_HOURS` | *(derives from `CREATION_MAX_AGE_HOURS`)* | Wallet-buy look-back window. Leave unset unless you want it wider than the creation-age ceiling. |
| `MIN_MARKET_CAP` | `10000` | Floor: coin's peak (ATH) market cap must reach this. |
| `MAX_MARKET_CAP` | `25000` | Ceiling: coin's peak must not exceed this. `0` disables it. |
| `MIN_VOLUME` | `10000` | Min 24h volume. |
| `RESOLVE_PEAK_MARKET_CAP` | `true` | Estimate a real peak via GeckoTerminal history. |
| `GECKO_DELAY_MS` | `2100` | Delay between GeckoTerminal calls (free ~30/min). |
| `REQUIRE_X_LINK` | `false` | Only keep tokens with an X/Twitter link on DEX Screener. |
| `REQUIRE_CREATION_IN_WINDOW` | `true` | Token's age at scan time must fall in the creation-age band below. |
| `CREATION_MIN_AGE_HOURS` | `8` | Minimum token age (hours) as of your click. |
| `CREATION_MAX_AGE_HOURS` | `16` | Maximum token age (hours) as of your click. |
| `MCAP_MODE` | `marketCap` | Which value is shown as "primary": `marketCap` \| `fdv` \| `observedAth`. |
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
