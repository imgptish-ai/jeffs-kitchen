/**
 * Output: console table + JSON + CSV, including the NA/EU grouped files.
 *
 * Output columns are intentionally minimal — exactly what's needed to scan
 * a result list at a glance: Name, Symbol, ContractAddress, MarketCap,
 * PeakMarketCap, PairCreatedAt, XLink, Wallets. "PeakMarketCap" is the same
 * value the filter judged the token against (athEstimate) — it folds in
 * GeckoTerminal history, observed ATH, and current mcap/fdv, and is always a
 * number (never blank), unlike the raw GeckoTerminal-only figure which can be
 * null when history wasn't available. "PairCreatedAt" is formatted in
 * CONFIG.timezone (America/Chicago by default, DST-aware) rather than raw UTC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';
import { toCsv, log } from './util';
import { formatInZone } from './time';
import type { TokenResult } from './types';

/** The slim record actually written to results files (JSON + CSV alike). */
interface OutputRecord {
  name: string;
  symbol: string;
  contractAddress: string;
  marketCap: number | string;
  peakMarketCap: number;
  pairCreatedAt: string; // formatted in CONFIG.timezone (America/Chicago by default), or '' if unknown
  xLink: string;
  wallets: string[];
}

function toOutputRecord(r: TokenResult): OutputRecord {
  return {
    name: r.name,
    symbol: r.symbol,
    contractAddress: r.contractAddress,
    marketCap: r.marketCap ?? '',
    peakMarketCap: r.athEstimate,
    pairCreatedAt: formatInZone(r.pairCreatedAt, CONFIG.timezone),
    xLink: r.xLink ?? '',
    wallets: r.wallets,
  };
}

const CSV_COLUMNS: (keyof OutputRecord)[] = [
  'name',
  'symbol',
  'contractAddress',
  'marketCap',
  'peakMarketCap',
  'pairCreatedAt',
  'xLink',
  'wallets',
];

function writeJson(dir: string, file: string, data: TokenResult[]): void {
  const records = data.map(toOutputRecord);
  fs.writeFileSync(path.join(dir, file), JSON.stringify(records, null, 2));
}

function writeCsv(dir: string, file: string, data: TokenResult[]): void {
  const rows = data.map(toOutputRecord);
  fs.writeFileSync(path.join(dir, file), toCsv(rows as unknown as Record<string, unknown>[], CSV_COLUMNS));
}

/** Pretty console.table of the key columns — mirrors the file output columns. */
export function printConsoleTable(results: TokenResult[]): void {
  if (results.length === 0) {
    log.info('No tokens matched the filters in this window.');
    return;
  }
  const rows = results.map((r) => ({
    name: r.name || '(?)',
    symbol: r.symbol || '(?)',
    contractAddress: r.contractAddress.slice(0, 6) + '…' + r.contractAddress.slice(-4),
    'marketCap$': r.marketCap != null ? Math.round(r.marketCap) : '',
    'peakMarketCap$': Math.round(r.athEstimate),
    pairCreatedAt: formatInZone(r.pairCreatedAt, CONFIG.timezone),
    xLink: r.xLink ?? '',
    wallets: r.wallets.length,
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

  // Grouped (still split by NA/EU session internally; the session label
  // itself isn't one of the requested columns, so it's not repeated in-file —
  // which file you open is what tells you NA vs EU).
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
  return `${r.symbol || '(?)'} [${r.sessionCategory}] peak≈$${Math.round(r.athEstimate).toLocaleString('en-US')}`;
}
