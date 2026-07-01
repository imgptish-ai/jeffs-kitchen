/**
 * NA / EU session classification.
 *
 * A timestamp is converted to local wall-clock time in CONFIG.timezone
 * (default America/Chicago, DST-aware) and checked against the NA window.
 *
 * Defaults:
 *   NA = 10:00:00 AM .. 9:59:59 PM  (Chicago)   -> [10:00, 22:00)
 *   EU = 10:00:00 PM .. 9:59:59 AM  (Chicago)   -> everything else (wraps midnight)
 *
 * Timestamp PRIORITY for the "relevant timestamp" (per spec):
 *   1. true token creation time (if resolved)
 *   2. DEX Screener pairCreatedAt
 *   3. first detected wallet buy time
 */
import { CONFIG } from './config';
import { getZonedSecondsOfDay } from './time';
import type { SessionCategory } from './types';

/** Is `sec` inside [start, end)? Supports windows that wrap past midnight. */
function inWindow(sec: number, start: number, end: number): boolean {
  if (start <= end) return sec >= start && sec < end; // same-day window
  return sec >= start || sec < end; // wraps midnight
}

/** Classify a single epoch-ms timestamp into NA or EU. */
export function classifySession(ms: number): SessionCategory {
  const { secondsOfDay } = getZonedSecondsOfDay(ms, CONFIG.timezone);
  return inWindow(secondsOfDay, CONFIG.naStartSec, CONFIG.naEndSec) ? 'NA' : 'EU';
}

export interface SessionClassification {
  sessionCategory: SessionCategory;
  sessionCategoryReason: string;
  sessionTimestampUsed: number;
  sessionTimestampSource: 'token' | 'pair' | 'buy';
}

/**
 * Pick the highest-priority available timestamp, classify it, and build a
 * human-readable reason string like:
 *   "Classified as NA using token creation time"
 *   "Classified as EU using DEX Screener pairCreatedAt"
 *   "Classified as NA using first wallet buy time"
 */
export function classifyWithReason(input: {
  tokenCreatedAt: number | null;
  pairCreatedAt: number | null;
  firstBuyAt: number;
}): SessionClassification {
  let ts: number;
  let source: 'token' | 'pair' | 'buy';
  let label: string;

  if (input.tokenCreatedAt != null) {
    ts = input.tokenCreatedAt;
    source = 'token';
    label = 'token creation time';
  } else if (input.pairCreatedAt != null) {
    ts = input.pairCreatedAt;
    source = 'pair';
    label = 'DEX Screener pairCreatedAt';
  } else {
    ts = input.firstBuyAt;
    source = 'buy';
    label = 'first wallet buy time';
  }

  const category = classifySession(ts);
  return {
    sessionCategory: category,
    sessionCategoryReason: `Classified as ${category} using ${label}`,
    sessionTimestampUsed: ts,
    sessionTimestampSource: source,
  };
}
