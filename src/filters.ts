/**
 * Filtering logic — the market-cap band is on the PEAK (ATH), not current,
 * and the creation-time check is on the token's AGE at scan time.
 *
 * A token passes only if ALL hold:
 *   - bought by >= 1 imported wallet
 *   - its estimated PEAK market cap >= MIN_MARKET_CAP
 *   - its estimated PEAK market cap <= MAX_MARKET_CAP
 *   - 24h volume (or closest field) >= MIN_VOLUME
 *   - chain is solana
 *   - not an ignored base/stable
 *   - token's AGE at scan time is inside
 *     [CREATION_MIN_AGE_HOURS, CREATION_MAX_AGE_HOURS], if
 *     REQUIRE_CREATION_IN_WINDOW=true.
 *
 * WHAT "PEAK" MEANS HERE:
 *   athEstimate = max(peakMarketCap from GeckoTerminal history, observed ATH
 *   across runs, current marketCap, current fdv). Using the max is
 *   deliberately conservative for the ceiling.
 */

import { CONFIG } from './config';

export interface FilterInput {
  mint: string;
  chainId: string;
  walletCount: number;
  marketCap: number | null;
  fdv: number | null;
  observedAthMarketCap: number | null;
  peakMarketCap: number | null;
  volume24h: number;
  volumeField: string;

  /** Token age at scan time, in hours. Null if no creation-ish timestamp was resolvable. */
  creationAgeHours: number | null;

  /** Which timestamp creationAgeHours was computed from. */
  creationTimestampSource: 'token' | 'pair' | 'unknown';
}

export interface FilterOutcome {
  passed: boolean;
  reason: string;
  athEstimate: number;
  peakConfidence: 'history' | 'observed-or-current';
}

function usd(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function hrs(n: number | null): string {
  return n == null ? 'unknown' : `${n.toFixed(1)}h`;
}

export function applyFilters(input: FilterInput): FilterOutcome {
  const notes: string[] = [];

  const athEstimate = Math.max(
    input.peakMarketCap ?? 0,
    input.observedAthMarketCap ?? 0,
    input.marketCap ?? 0,
    input.fdv ?? 0,
  );

  const peakConfidence: FilterOutcome['peakConfidence'] =
    input.peakMarketCap != null ? 'history' : 'observed-or-current';

  const boughtOk = input.walletCount >= 1;

  const floorOk = athEstimate >= CONFIG.minMarketCap;

  const ceilingEnabled = CONFIG.maxMarketCap > 0;
  const ceilingOk = !ceilingEnabled || athEstimate <= CONFIG.maxMarketCap;

  const volOk = input.volume24h >= CONFIG.minVolume;

  const solOk = input.chainId === 'solana';

  const notIgnored = !CONFIG.ignoredMints.has(input.mint);

  const ageOk =
    !CONFIG.requireCreationInWindow ||
    (
      input.creationAgeHours != null &&
      input.creationAgeHours >= CONFIG.creationMinAgeHours &&
      input.creationAgeHours <= CONFIG.creationMaxAgeHours
    );

  notes.push(`${boughtOk ? '✓' : '✗'} bought by ${input.walletCount} wallet(s)`);

  notes.push(
    `${floorOk ? '✓' : '✗'} peak≈${usd(athEstimate)} >= floor ${usd(CONFIG.minMarketCap)} [${peakConfidence}]`,
  );

  if (ceilingEnabled) {
    notes.push(
      `${ceilingOk ? '✓' : '✗'} peak≈${usd(athEstimate)} <= ceiling ${usd(CONFIG.maxMarketCap)}`,
    );
  }

  notes.push(
    `${volOk ? '✓' : '✗'} vol(${input.volumeField})=${usd(input.volume24h)} >= ${usd(CONFIG.minVolume)}`,
  );

  notes.push(`${solOk ? '✓' : '✗'} chain=${input.chainId}`);

  if (!notIgnored) {
    notes.push('✗ token is an ignored base/stable');
  }

  if (CONFIG.requireCreationInWindow) {
    notes.push(
      `${ageOk ? '✓' : '✗'} age=${hrs(input.creationAgeHours)} in [${CONFIG.creationMinAgeHours}h-${CONFIG.creationMaxAgeHours}h] [${input.creationTimestampSource}]`,
    );
  }

  const passed =
    boughtOk &&
    floorOk &&
    ceilingOk &&
    volOk &&
    solOk &&
    notIgnored &&
    ageOk;

  return {
    passed,
    reason: notes.join('; '),
    athEstimate,
    peakConfidence,
  };
}
