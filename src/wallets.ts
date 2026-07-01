/**
 * Loads wallet addresses from a plain-text/CSV file.
 * - splits on newlines AND commas (so a wallets.txt or a single CSV column works)
 * - ignores blank lines and lines starting with "#"
 * - keeps only strings that look like base58 Solana addresses
 * - de-duplicates
 */
import fs from 'node:fs';
import { CONFIG } from './config';
import { log } from './util';

// Base58 alphabet excludes 0, O, I, l. Solana addresses are 32–44 chars.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isLikelySolanaAddress(s: string): boolean {
  return SOLANA_ADDRESS_RE.test(s);
}

export function loadWallets(): string[] {
  const path = CONFIG.walletsFile;
  if (!fs.existsSync(path)) {
    throw new Error(
      `Wallets file not found: "${path}". Create it and add one Solana address per line ` +
        `(see wallets.txt for an example).`,
    );
  }

  const raw = fs.readFileSync(path, 'utf8');
  const rawTokens = raw
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'));

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const t of rawTokens) {
    if (isLikelySolanaAddress(t)) valid.push(t);
    else invalid.push(t);
  }

  if (invalid.length > 0) {
    log.warn(`Skipped ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} that did not look like Solana addresses.`);
  }

  const unique = Array.from(new Set(valid));
  if (unique.length === 0) {
    throw new Error(`No valid Solana wallet addresses found in "${path}".`);
  }
  return unique;
}
