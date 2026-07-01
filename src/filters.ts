/**
 * Filtering logic. A token passes only if ALL conditions hold within the
 * scan window:
 *   - bought by >= 1 imported wallet          (guaranteed: results derive from buys)
 *   - marketCap OR fdv OR observedAth >= MIN_MARKET_CAP
 *   - 24h volume (or closest field) >= MIN_VOLUME
 *   - chain is solana
 *   - the token is not an ignored base/stable
 */
import { CONFIG } from './config';

export interface FilterInput {
  mint: string;
  chainId: string;
  walletCount: number;
  marketCap: number | null;
  fdv: number | null;
  observedAthMarketCap: number | null;
  volume24h: number;
  volumeField: string;
}

export interface FilterOutcome {
  passed: boolean;
  reason: string; // human-readable summary of what did/didn't pass
}

function usd(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return '$' + Math.round(n).toLocaleString('en-US');
}

export function applyFilters(input: FilterInput): FilterOutcome {
  const notes: string[] = [];

  const boughtOk = input.walletCount >= 1;
  const bestMcap = Math.max(input.marketCap ?? 0, input.fdv ?? 0, input.observedAthMarketCap ?? 0);
  const mcapOk = bestMcap >= CONFIG.minMarketCap;
  const volOk = input.volume24h >= CONFIG.minVolume;
  const solOk = input.chainId === 'solana';
  const notIgnored = !CONFIG.ignoredMints.has(input.mint);

  notes.push(`${boughtOk ? '✓' : '✗'} bought by ${input.walletCount} wallet(s)`);
  notes.push(
    `${mcapOk ? '✓' : '✗'} mcap/fdv/observedATH best=${usd(bestMcap)} (>= ${usd(CONFIG.minMarketCap)})`,
  );
  notes.push(`${volOk ? '✓' : '✗'} vol(${input.volumeField})=${usd(input.volume24h)} (>= ${usd(CONFIG.minVolume)})`);
  notes.push(`${solOk ? '✓' : '✗'} chain=${input.chainId}`);
  if (!notIgnored) notes.push('✗ token is an ignored base/stable');

  const passed = boughtOk && mcapOk && volOk && solOk && notIgnored;
  return { passed, reason: notes.join('; ') };
}
