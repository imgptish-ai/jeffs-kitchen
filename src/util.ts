/**
 * Small shared utilities: logging, sleeping, chunking, robust fetch (with
 * 429 / 5xx retry + backoff), and CSV serialization.
 */
import { CONFIG } from './config';

export const log = {
  info: (...args: unknown[]) => console.log('•', ...args),
  warn: (...args: unknown[]) => console.warn('⚠', ...args),
  error: (...args: unknown[]) => console.error('✖', ...args),
  step: (...args: unknown[]) => console.log('\n▸', ...args),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * fetch() a JSON endpoint with retry handling.
 *   - HTTP 429  -> honor Retry-After header if present, else exponential backoff
 *   - HTTP 5xx  -> retry with backoff
 *   - HTTP 4xx  -> throw immediately (won't fix itself by retrying)
 * Never spams: sleeps between retries, capped by CONFIG.maxRetries.
 */
export async function fetchJson<T>(url: string, init?: RequestInit, attempt = 1): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Network-level failure (DNS, socket, etc.) — retry a few times.
    if (attempt <= CONFIG.maxRetries) {
      const wait = CONFIG.retryBackoffMs * attempt;
      log.warn(`Network error (attempt ${attempt}), retrying in ${wait}ms: ${(err as Error).message}`);
      await sleep(wait);
      return fetchJson<T>(url, init, attempt + 1);
    }
    throw err;
  }

  if (res.status === 429) {
    if (attempt > CONFIG.maxRetries) {
      throw new Error(`Rate limited (HTTP 429) after ${attempt} attempts: ${url}`);
    }
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0;
    const wait = retryAfterMs || CONFIG.retryBackoffMs * attempt;
    log.warn(`HTTP 429 rate limit — backing off ${wait}ms (attempt ${attempt}/${CONFIG.maxRetries}).`);
    await sleep(wait);
    return fetchJson<T>(url, init, attempt + 1);
  }

  if (res.status >= 500) {
    if (attempt > CONFIG.maxRetries) {
      throw new Error(`Server error (HTTP ${res.status}) after ${attempt} attempts: ${url}`);
    }
    const wait = CONFIG.retryBackoffMs * attempt;
    log.warn(`HTTP ${res.status} — retrying in ${wait}ms (attempt ${attempt}/${CONFIG.maxRetries}).`);
    await sleep(wait);
    return fetchJson<T>(url, init, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Escape one CSV cell per RFC 4180 (quote if it contains , " or newline). */
function csvCell(value: unknown): string {
  if (value == null) return '';
  let s: string;
  if (Array.isArray(value)) s = value.join('; ');
  else s = String(value);
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Turn an array of row-objects into a CSV string using the given columns. */
export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: (keyof T)[]): string {
  const header = columns.map((c) => csvCell(c as string)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvCell(row[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}
