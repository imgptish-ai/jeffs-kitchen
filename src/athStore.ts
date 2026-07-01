/**
 * Local "observed all-time-high market cap" store.
 *
 * WHY THIS EXISTS:
 *   DEX Screener does NOT expose a token's true historical ATH market cap.
 *   So we approximate it ourselves: every time the scanner runs, we record the
 *   token's current market cap and keep the maximum ever seen. This is an
 *   "observed ATH" that only reflects the moments the scanner actually ran —
 *   it is NOT the token's real all-time high. The more often you run the
 *   scanner, the more complete this becomes.
 *
 * Storage is a single JSON file (CONFIG.athStoreFile). No database needed,
 * which keeps the project beginner-friendly. Swap this module for a real DB
 * later if you outgrow it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';
import { log } from './util';
import type { AthRecord } from './types';

type Store = Record<string, AthRecord>;

export class AthStore {
  private store: Store = {};

  constructor(private readonly file: string = CONFIG.athStoreFile) {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        this.store = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Store;
      }
    } catch (err) {
      log.warn(`Could not read ATH store (${this.file}); starting fresh: ${(err as Error).message}`);
      this.store = {};
    }
  }

  save(): void {
    const dir = path.dirname(this.file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.store, null, 2));
  }

  /**
   * Record a fresh market-cap snapshot for a mint and return the updated
   * observed ATH. `currentMarketCap` may be null (token not priced yet); in
   * that case we don't move the ATH but still register that we've seen it.
   */
  update(mint: string, currentMarketCap: number | null, now: number): number {
    const existing = this.store[mint];
    const cap = currentMarketCap != null && Number.isFinite(currentMarketCap) ? currentMarketCap : 0;

    if (!existing) {
      const rec: AthRecord = {
        mint,
        observedAthMarketCap: cap,
        lastMarketCap: currentMarketCap,
        firstSeenAt: now,
        lastSeenAt: now,
        snapshotCount: 1,
      };
      this.store[mint] = rec;
      return rec.observedAthMarketCap;
    }

    existing.observedAthMarketCap = Math.max(existing.observedAthMarketCap, cap);
    existing.lastMarketCap = currentMarketCap;
    existing.lastSeenAt = now;
    existing.snapshotCount += 1;
    return existing.observedAthMarketCap;
  }

  get(mint: string): AthRecord | undefined {
    return this.store[mint];
  }
}
