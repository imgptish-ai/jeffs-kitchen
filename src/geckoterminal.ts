/**
 * GeckoTerminal helper — free, no API key, does NOT use your Helius quota.
 *
 * We use it to estimate a real PEAK market cap for each token, which DEX
 * Screener cannot give us (it only reports current values). We fetch daily
 * OHLCV candles for the token's pool; each daily candle's "high" is the true
 * highest price during that day, so the maximum high across the coin's life is
 * a genuine peak price.
 *
 *   Endpoint: GET /networks/solana/pools/{pool}/ohlcv/day
 *   Response: data.attributes.ohlcv_list = [[ts, open, high, low, close, vol], ...]
 *   Docs: https://apiguide.geckoterminal.com (free, ~30 calls/min, up to ~6 months)
 *
 * LIMITATIONS (be honest):
 *   - History goes back ~6 months and depends on the pool existing on
 *     GeckoTerminal. Peaks before that window aren't captured.
 *   - We pass the token mint so prices are for YOUR token, not the quote side.
 *   - If anything is missing/unavailable we return null and the caller falls
 *     back to current/observed values (and marks lower confidence).
 */
import { CONFIG } from './config';
import { fetchJson } from './util';

const BASE = 'https://api.geckoterminal.com/api/v2';

interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

export interface PeakResult {
  peakPriceUsd: number;
  peakAt: number; // epoch ms of the day the peak occurred
}

/**
 * Return the highest USD price the token reached across available daily
 * candles for `poolAddress`, or null if unavailable.
 */
export async function getPeakPriceUsd(poolAddress: string, mint: string): Promise<PeakResult | null> {
  if (!CONFIG.resolvePeakMarketCap || !poolAddress) return null;

  const url = new URL(`${BASE}/networks/solana/pools/${poolAddress}/ohlcv/day`);
  url.searchParams.set('aggregate', '1');
  url.searchParams.set('limit', '1000'); // as much history as the free API gives
  url.searchParams.set('currency', 'usd');
  url.searchParams.set('token', mint); // ensure prices are for OUR token

  let res: OhlcvResponse;
  try {
    res = await fetchJson<OhlcvResponse>(url.toString(), {
      headers: { Accept: 'application/json;version=20230302' },
    });
  } catch {
    return null; // pool not found on GeckoTerminal, etc. -> caller falls back
  }

  const list = res.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || list.length === 0) return null;

  let peakPriceUsd = 0;
  let peakAt = 0;
  for (const candle of list) {
    // candle = [timestampSec, open, high, low, close, volume]
    const ts = candle[0];
    const high = candle[2];
    if (typeof high === 'number' && Number.isFinite(high) && high > peakPriceUsd) {
      peakPriceUsd = high;
      peakAt = typeof ts === 'number' ? ts * 1000 : 0;
    }
  }
  if (peakPriceUsd <= 0) return null;
  return { peakPriceUsd, peakAt };
}
