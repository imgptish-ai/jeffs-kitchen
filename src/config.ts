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

export const CONFIG = {
  // ---- Secrets ----
  heliusApiKey: process.env.HELIUS_API_KEY ?? '',

  // ---- Scan window ----
  scanWindowHours: num(process.env.SCAN_WINDOW_HOURS, 24),

  // ---- Filters (operate on the PEAK / ATH market-cap estimate, not current) ----
  // A coin passes only if its estimated peak market cap is within this band.
  minMarketCap: num(process.env.MIN_MARKET_CAP, 10_000), // floor: peak must have reached this
  maxMarketCap: num(process.env.MAX_MARKET_CAP, 25_000), // ceiling: peak must NOT exceed this. 0 = no ceiling.
  minVolume: num(process.env.MIN_VOLUME, 10_000),

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
}
