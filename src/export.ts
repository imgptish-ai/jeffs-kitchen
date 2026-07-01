/**
 * Output: console table + JSON + CSV, including the NA/EU grouped files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';
import { toCsv, log } from './util';
import { formatInZone, toIso } from './time';
import type { TokenResult } from './types';

/** CSV column order (stable, human-friendly). */
const CSV_COLUMNS = [
  'name',
  'symbol',
  'contractAddress',
  'sessionCategory',
  'sessionCategoryReason',
  'marketCap',
  'fdv',
  'peakMarketCap',
  'athEstimate',
  'peakConfidence',
  'observedAthMarketCap',
  'volume24h',
  'volumeField',
  'liquidityUsd',
  'priceUsd',
  'priceChange24h',
  'buys24h',
  'sells24h',
  'dexId',
  'pairAddress',
  'dexScreenerUrl',
  'wallets',
  'tokenCreatedAtIso',
  'pairCreatedAtIso',
  'firstBuyAtIso',
  'detectedAtIso',
  'filterReason',
] as const;

/** Flatten a TokenResult into a CSV-friendly row (dates as ISO, arrays joined). */
function toCsvRow(r: TokenResult): Record<string, unknown> {
  return {
    name: r.name,
    symbol: r.symbol,
    contractAddress: r.contractAddress,
    sessionCategory: r.sessionCategory,
    sessionCategoryReason: r.sessionCategoryReason,
    marketCap: r.marketCap ?? '',
    fdv: r.fdv ?? '',
    peakMarketCap: r.peakMarketCap ?? '',
    athEstimate: r.athEstimate ?? '',
    peakConfidence: r.peakConfidence,
    observedAthMarketCap: r.observedAthMarketCap ?? '',
    volume24h: r.volume24h,
    volumeField: r.volumeField,
    liquidityUsd: r.liquidityUsd ?? '',
    priceUsd: r.priceUsd ?? '',
    priceChange24h: r.priceChange24h ?? '',
    buys24h: r.buys24h ?? '',
    sells24h: r.sells24h ?? '',
    dexId: r.dexId,
    pairAddress: r.pairAddress,
    dexScreenerUrl: r.dexScreenerUrl,
    wallets: r.wallets, // toCsv joins arrays with "; "
    tokenCreatedAtIso: toIso(r.tokenCreatedAt),
    pairCreatedAtIso: toIso(r.pairCreatedAt),
    firstBuyAtIso: toIso(r.firstBuyAt),
    detectedAtIso: toIso(r.detectedAt),
    filterReason: r.filterReason,
  };
}

function writeJson(dir: string, file: string, data: TokenResult[]): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2));
}

function writeCsv(dir: string, file: string, data: TokenResult[]): void {
  const rows = data.map(toCsvRow);
  fs.writeFileSync(path.join(dir, file), toCsv(rows, CSV_COLUMNS as unknown as (keyof (typeof rows)[number])[]));
}

/** Pretty console.table of the key columns. */
export function printConsoleTable(results: TokenResult[]): void {
  if (results.length === 0) {
    log.info('No tokens matched the filters in this window.');
    return;
  }
  const rows = results.map((r) => ({
    symbol: r.symbol || '(?)',
    session: r.sessionCategory,
    'peak$': Math.round(r.athEstimate),
    'peak?': r.peakConfidence === 'history' ? 'hist' : 'est',
    'mcap$': r.marketCap != null ? Math.round(r.marketCap) : '',
    'vol24h$': Math.round(r.volume24h),
    'liq$': r.liquidityUsd != null ? Math.round(r.liquidityUsd) : '',
    wallets: r.wallets.length,
    mint: r.contractAddress.slice(0, 6) + '…' + r.contractAddress.slice(-4),
  }));
  console.table(rows);
}

export interface ExportBundle {
  all: TokenResult[];
  na: TokenResult[];
  eu: TokenResult[];
}

/** Write all JSON + CSV files (main + grouped) into CONFIG.outputDir. */
export function writeAllOutputs(bundle: ExportBundle): string {
  const dir = CONFIG.outputDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Main (== all)
  writeJson(dir, CONFIG.files.mainJson, bundle.all);
  writeCsv(dir, CONFIG.files.mainCsv, bundle.all);

  // Grouped
  writeJson(dir, CONFIG.files.allJson, bundle.all);
  writeJson(dir, CONFIG.files.naJson, bundle.na);
  writeJson(dir, CONFIG.files.euJson, bundle.eu);
  writeCsv(dir, CONFIG.files.allCsv, bundle.all);
  writeCsv(dir, CONFIG.files.naCsv, bundle.na);
  writeCsv(dir, CONFIG.files.euCsv, bundle.eu);

  return path.resolve(dir);
}

/** One-line human summary of a result, used in the run log. */
export function summarizeResult(r: TokenResult): string {
  const created = r.tokenCreatedAt
    ? `token@${formatInZone(r.tokenCreatedAt, CONFIG.timezone)}`
    : r.pairCreatedAt
      ? `pair@${formatInZone(r.pairCreatedAt, CONFIG.timezone)}`
      : `buy@${formatInZone(r.firstBuyAt, CONFIG.timezone)}`;
  return `${r.symbol || '(?)'} [${r.sessionCategory}] ${created}`;
}
