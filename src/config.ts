/**
 * Central configuration.
 *
 * Everything is driven by environment variables (loaded from `.env`) but has a
 * sensible default baked in here, so the file doubles as living documentation
 * of every knob you can turn. Edit `.env` (preferred) or the defaults below.
 */
import 'dotenv/config';
import { parseClockTimeToSeconds } from './time';

function num(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Base tokens / stables that are NEVER treated as "memecoins bought".
const DEFAULT_IGNORED_MINTS = [
  'So11111111111111111111111111111111111111112', // Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
];

// The creation-age band (see requireCreationInWindow below) determines how
// far back wallet buys need to be scanned: a token that's exactly
// creationMaxAgeHours old could have been bought any time between its
// creation and now, so the buy lookback must reach at least that far back.
// Computed as locals (not inline in CONFIG) so scanWindowHours can default
// from it below.
const creationMinAgeHours = num(process.env.CREATION_MIN_AGE_HOURS, 8);
const creationMaxAgeHours = num(process.env.CREATION_MAX_AGE_HOURS, 16);

export const CONFIG = {
  // ---- Secrets ----
  heliusApiKey: process.env.HELIUS_API_KEY ?? '',

  // ---- Scan window (wallet-buy lookback) ----
  // Defaults to creationMaxAgeHours so it automatically covers the full
  // creation-age band below without you having to keep two numbers in sync.
  // Override only if you know you want a different buy lookback.
  scanWindowHours: num(process.env.SCAN_WINDOW_HOURS, creationMaxAgeHours),

  // ---- Filters (operate on the PEAK / ATH market-cap estimate, not current) ----
  // A coin passes only if its estimated peak market cap is within this band.
  minMarketCap: num(process.env.MIN_MARKET_CAP, 10_000), // floor: peak must have reached this
  maxMarketCap: num(process.env.MAX_MARKET_CAP, 25_000), // ceiling: peak must NOT exceed this. 0 = no ceiling.
  minVolume: num(process.env.MIN_VOLUME, 10_000),

  /** Require the token to have an X/Twitter link on DEX Screener to pass. */
  requireXLink: bool(process.env.REQUIRE_X_LINK, false),

  /**
   * Require the token's AGE at scan time to fall inside [creationMinAgeHours,
   * creationMaxAgeHours] — e.g. "created 8-16 hours ago as of right now".
   * Uses true token creation time when known, otherwise falls back to DEX
   * Screener's pairCreatedAt (honestly labeled). A pair can never be created
   * before its token exists, so a pair older than creationMaxAgeHours proves
   * the token is too old too — letting us skip the expensive lookup entirely
   * for those. The "too young" side can't be pre-proven the same way (a pair
   * can lag well behind true token creation), so that side always needs the
   * real lookup (or the honest pairCreatedAt-based fallback).
   */
  requireCreationInWindow: bool(process.env.REQUIRE_CREATION_IN_WINDOW, true),
  creationMinAgeHours,
  creationMaxAgeHours,

  // ---- Peak / ATH estimation (GeckoTerminal, free, no API key, no Helius cost) ----
  /** Pull historical daily candles to estimate a real peak market cap. */
  resolvePeakMarketCap: bool(process.env.RESOLVE_PEAK_MARKET_CAP, true),
  /** Delay between GeckoTerminal calls (free tier ~30/min -> keep >= 2000ms). */
  geckoDelayMs: num(process.env.GECKO_DELAY_MS, 2100),

  /** Which mcap metric is the "primary" displayed value / ATH snapshot source. */
  mcapMode: (process.env.MCAP_MODE ?? 'marketCap') as 'marketCap' | 'fdv' | 'observedAth',

  /** Mints to ignore (base/stable tokens). Defaults + EXTRA_IGNORED_MINTS. */
  ignoredMints: new Set<string>([...DEFAULT_IGNORED_MINTS, ...list(process.env.EXTRA_IGNORED_MINTS)]),

  // ---- Session classification ----
  timezone: process.env.TIMEZONE ?? 'America/Chicago',
  naStartSec: parseClockTimeToSeconds(process.env.NA_START ?? '10:00 AM'),
  naEndSec: parseClockTimeToSeconds(process.env.NA_END ?? '10:00 PM'),
  euStartSec: parseClockTimeToSeconds(process.env.EU_START ?? '10:00 PM'),
  euEndSec: parseClockTimeToSeconds(process.env.EU_END ?? '10:00 AM'),

  // ---- Output ----
  outputDir: process.env.OUTPUT_DIR ?? 'output',
  files: {
    mainJson: 'results.json',
    mainCsv: 'results.csv',
    allJson: 'results_all.json',
    naJson: 'results_na.json',
    euJson: 'results_eu.json',
    allCsv: 'results_all.csv',
    naCsv: 'results_na.csv',
    euCsv: 'results_eu.csv',
  },

  // ---- Rate limiting / retries ----
  requestDelayMs: num(process.env.REQUEST_DELAY_MS, 300),
  maxRetries: num(process.env.MAX_RETRIES, 4),
  retryBackoffMs: num(process.env.RETRY_BACKOFF_MS, 1500),
  dexBatchSize: num(process.env.DEX_BATCH_SIZE, 30),

  // ---- Helius paging caps ----
  maxTxPagesPerWallet: num(process.env.MAX_TX_PAGES_PER_WALLET, 20),
  resolveTokenCreationTime: bool(process.env.RESOLVE_TOKEN_CREATION_TIME, true),
  maxSignaturePagesPerMint: num(process.env.MAX_SIG_PAGES_PER_MINT, 5),

  // ---- Scheduler ----
  scheduleIntervalHours: num(process.env.SCHEDULE_INTERVAL_HOURS, 12),

  // ---- Web server ----
  port: num(process.env.PORT, 3000),

  // ---- Files ----
  walletsFile: process.env.WALLETS_FILE ?? 'wallets.txt',
  athStoreFile: process.env.ATH_STORE_FILE ?? 'data/ath-store.json',
} as const;

/** Throws a friendly error if required config is missing. Call at startup. */
export function assertConfig(): void {
  if (!CONFIG.heliusApiKey || CONFIG.heliusApiKey === 'your_helius_api_key_here') {
    throw new Error(
      'HELIUS_API_KEY is not set. Copy .env.example to .env and add your Helius API key ' +
        '(free at https://www.helius.dev/).',
    );
  }
  if (CONFIG.requireCreationInWindow && CONFIG.creationMinAgeHours > CONFIG.creationMaxAgeHours) {
    throw new Error(
      `CREATION_MIN_AGE_HOURS (${CONFIG.creationMinAgeHours}) is greater than ` +
        `CREATION_MAX_AGE_HOURS (${CONFIG.creationMaxAgeHours}) — this would exclude every token. ` +
        'Fix so min <= max.',
    );
  }
}
