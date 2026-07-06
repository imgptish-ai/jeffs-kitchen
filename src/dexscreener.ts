/**
 * DEX Screener market-data helper.
 *
 * Endpoint used: GET https://api.dexscreener.com/tokens/v1/solana/{mints}
 *   - Accepts up to 30 comma-separated token addresses per request.
 *   - Returns an array of "pair" objects (a token can have several pairs).
 *   - Rate limit is ~300 requests/minute; we batch by 30 and sleep between
 *     batches (CONFIG.requestDelayMs) plus honor 429 in fetchJson().
 *
 * For each token we pick the BEST pair = the one where the token is the base
 * token, with the highest USD liquidity. DEX Screener's marketCap / fdv refer
 * to the pair's base token, so selecting a base-token pair keeps those numbers
 * meaningful for our token.
 *
 * What DEX Screener does NOT give us:
 *   - wallet transaction history (that's Helius's job)
 *   - a true all-time-high market cap (we build "observed ATH" ourselves)
 *   - guaranteed true token creation time (pairCreatedAt is pool creation)
 */
import { CONFIG } from './config';
import { fetchJson, sleep, chunk } from './util';
import type { PairData } from './types';

interface DexToken {
  address?: string;
  name?: string;
  symbol?: string;
}
interface DexSocial {
  platform?: string;
  handle?: string;
  type?: string;
  url?: string;
}
interface DexWebsite {
  url?: string;
  label?: string;
}
interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: DexToken;
  quoteToken?: DexToken;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: Partial<Record<'h24' | 'h6' | 'h1' | 'm5', number>>;
  priceChange?: Partial<Record<'h24' | 'h6' | 'h1' | 'm5', number>>;
  txns?: Partial<Record<'h24' | 'h6' | 'h1' | 'm5', { buys?: number; sells?: number }>>;
  pairCreatedAt?: number; // epoch ms
  info?: { websites?: DexWebsite[]; socials?: DexSocial[] };
}

/**
 * Find an X/Twitter link in DEX Screener's `info.socials` (or, failing that,
 * `info.websites`, since some tokens list x.com under websites instead).
 * DEX Screener's data still generally labels this platform "twitter"
 * internally even though the site is branded X, so we match both.
 */
function findXLink(info: DexPair['info']): string | null {
  const isX = (s: string | undefined) => {
    const v = (s ?? '').toLowerCase();
    return v.includes('twitter') || v.includes('x.com') || v === 'x';
  };

  for (const s of info?.socials ?? []) {
    if (isX(s.platform) || isX(s.type) || isX(s.url)) {
      if (s.url) return s.url;
      if (s.handle) return `https://x.com/${s.handle.replace(/^@/, '')}`;
    }
  }
  for (const w of info?.websites ?? []) {
    if (w.url && (w.url.includes('x.com/') || w.url.includes('twitter.com/'))) return w.url;
  }
  return null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Choose the 24h volume, falling back to the closest available window. */
function pickVolume(vol: DexPair['volume']): { value: number; field: string } {
  if (vol) {
    for (const f of ['h24', 'h6', 'h1', 'm5'] as const) {
      const v = vol[f];
      if (typeof v === 'number' && Number.isFinite(v)) return { value: v, field: f };
    }
  }
  return { value: 0, field: 'none' };
}

function mapPair(p: DexPair): PairData {
  const vol = pickVolume(p.volume);
  const txns24 = p.txns?.h24;
  return {
    chainId: p.chainId ?? 'solana',
    dexId: p.dexId ?? '',
    pairAddress: p.pairAddress ?? '',
    url: p.url ?? '',
    name: p.baseToken?.name ?? '',
    symbol: p.baseToken?.symbol ?? '',
    priceUsd: num(p.priceUsd),
    marketCap: num(p.marketCap),
    fdv: num(p.fdv),
    liquidityUsd: num(p.liquidity?.usd),
    volume24h: vol.value,
    volumeField: vol.field,
    priceChange24h: num(p.priceChange?.h24),
    buys24h: txns24?.buys ?? null,
    sells24h: txns24?.sells ?? null,
    pairCreatedAt: typeof p.pairCreatedAt === 'number' ? p.pairCreatedAt : null,
    xLink: findXLink(p.info),
  };
}

/**
 * Fetch market data for many mints. Returns a Map keyed by mint address.
 * Mints with no listed pair simply won't appear in the map.
 */
export async function getPairsForMints(mints: string[]): Promise<Map<string, PairData>> {
  const out = new Map<string, PairData>();
  const batches = chunk(mints, Math.min(CONFIG.dexBatchSize, 30));

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const url = `https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`;

    let raw: unknown;
    try {
      raw = await fetchJson<unknown>(url);
    } catch (err) {
      // Don't let one bad batch kill the whole scan.
      console.warn(`⚠ DEX Screener batch ${i + 1}/${batches.length} failed: ${(err as Error).message}`);
      if (i < batches.length - 1) await sleep(CONFIG.requestDelayMs);
      continue;
    }

    // The tokens/v1 endpoint returns an array; older endpoints return {pairs:[]}.
    const pairs: DexPair[] = Array.isArray(raw)
      ? (raw as DexPair[])
      : ((raw as { pairs?: DexPair[] })?.pairs ?? []);

    // Group pairs by their base-token mint.
    const byMint = new Map<string, DexPair[]>();
    for (const p of pairs) {
      const base = p.baseToken?.address;
      if (!base) continue;
      const bucket = byMint.get(base);
      if (bucket) bucket.push(p);
      else byMint.set(base, [p]);
    }

    for (const mint of batch) {
      const candidates = byMint.get(mint);
      if (!candidates || candidates.length === 0) continue;
      // Highest USD liquidity wins.
      candidates.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      out.set(mint, mapPair(candidates[0]!));
    }

    if (i < batches.length - 1) await sleep(CONFIG.requestDelayMs);
  }

  return out;
}
