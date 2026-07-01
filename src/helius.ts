/**
 * Solana data provider (Helius).
 *
 * Why Helius and not DEX Screener here?
 *   DEX Screener does NOT expose wallet-level transaction history. To find out
 *   which tokens a wallet bought, we need a Solana transaction data provider.
 *   We use Helius's "Enhanced Transactions" API, which returns already-parsed
 *   transactions (token transfers, native SOL transfers, swap events), so we
 *   don't have to decode raw instructions ourselves.
 *
 * Two capabilities are implemented:
 *   1. getWalletBuys(wallet, sinceMs) -> detected token buys in the window.
 *   2. getTokenCreationTime(mint)     -> best-effort true mint creation time.
 */
import { CONFIG } from './config';
import { fetchJson, sleep, log } from './util';
import type { WalletBuy } from './types';

const ENHANCED_TX_BASE = 'https://api.helius.xyz/v0/addresses';
const rpcUrl = () => `https://mainnet.helius-rpc.com/?api-key=${CONFIG.heliusApiKey}`;

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
}
interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number; // lamports
}
interface HeliusTx {
  signature: string;
  timestamp?: number; // seconds
  type?: string;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
}

/**
 * Detect token "buys" performed by `wallet` inside a single transaction.
 *
 * Heuristic (deliberately simple and readable):
 *   A buy = the wallet RECEIVED a non-ignored token AND the wallet had an
 *   OUTFLOW in the same tx (spent native SOL, or spent an ignored base/stable
 *   like wrapped SOL / USDC / USDT). Requiring an outflow avoids counting plain
 *   airdrops or incoming transfers as "buys".
 */
function detectBuysInTx(tx: HeliusTx, wallet: string): WalletBuy[] {
  const tsMs = (tx.timestamp ?? 0) * 1000;
  const tokenTransfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  // Tokens this wallet received (excluding ignored base/stable tokens).
  const received = tokenTransfers.filter(
    (t) => t.toUserAccount === wallet && t.mint && !CONFIG.ignoredMints.has(t.mint),
  );
  if (received.length === 0) return [];

  // Did the wallet pay out anything? (native SOL out, or an ignored token out)
  const spentNative = nativeTransfers.some((n) => n.fromUserAccount === wallet && (n.amount ?? 0) > 0);
  const spentBaseToken = tokenTransfers.some(
    (t) => t.fromUserAccount === wallet && t.mint && CONFIG.ignoredMints.has(t.mint),
  );
  if (!spentNative && !spentBaseToken) return [];

  // One buy record per distinct received mint.
  const seen = new Set<string>();
  const buys: WalletBuy[] = [];
  for (const r of received) {
    const mint = r.mint!;
    if (seen.has(mint)) continue;
    seen.add(mint);
    buys.push({ mint, wallet, boughtAt: tsMs, signature: tx.signature });
  }
  return buys;
}

/** Fetch and parse a wallet's buys within the last `sinceMs..now` window. */
export async function getWalletBuys(wallet: string, sinceMs: number): Promise<WalletBuy[]> {
  const buys: WalletBuy[] = [];
  let before: string | undefined;
  let pages = 0;

  while (pages < CONFIG.maxTxPagesPerWallet) {
    pages++;
    const url = new URL(`${ENHANCED_TX_BASE}/${wallet}/transactions`);
    url.searchParams.set('api-key', CONFIG.heliusApiKey);
    url.searchParams.set('limit', '100');
    if (before) url.searchParams.set('before', before);

    const txs = await fetchJson<HeliusTx[]>(url.toString());
    if (!Array.isArray(txs) || txs.length === 0) break;

    for (const tx of txs) {
      const tsMs = (tx.timestamp ?? 0) * 1000;
      if (tsMs < sinceMs) continue; // outside window
      for (const buy of detectBuysInTx(tx, wallet)) buys.push(buy);
    }

    const oldest = txs[txs.length - 1]!;
    before = oldest.signature;
    const oldestMs = (oldest.timestamp ?? 0) * 1000;
    if (oldestMs < sinceMs) break; // we've paged past the window; stop.

    await sleep(CONFIG.requestDelayMs);
  }

  return buys;
}

interface RpcSignature {
  signature: string;
  blockTime?: number | null; // seconds
}
interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

/**
 * Best-effort TRUE token creation time.
 *
 * Approach: page backwards through the mint account's signatures
 * (getSignaturesForAddress returns newest-first). When a page returns fewer
 * than the page size, we've reached the account's earliest signature — that
 * signature's blockTime ≈ the mint creation time.
 *
 * LIMITATION: very active tokens can have huge signature histories. To avoid
 * spamming the RPC we cap paging at CONFIG.maxSignaturePagesPerMint. If we hit
 * the cap without reaching the first signature, we HONESTLY return null
 * (unknown), and the caller falls back to DEX Screener's pairCreatedAt. We
 * never pretend a pair-creation time is a token-creation time.
 */
export async function getTokenCreationTime(mint: string): Promise<number | null> {
  if (!CONFIG.resolveTokenCreationTime) return null;

  let before: string | undefined;
  let oldestBlockTime: number | null = null;
  let pages = 0;
  const PAGE = 1000;

  while (pages < CONFIG.maxSignaturePagesPerMint) {
    pages++;
    const body = {
      jsonrpc: '2.0',
      id: 'creation',
      method: 'getSignaturesForAddress',
      params: [mint, { limit: PAGE, ...(before ? { before } : {}) }],
    };

    const res = await fetchJson<RpcResponse<RpcSignature[]>>(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.error) {
      log.warn(`getSignaturesForAddress error for ${mint}: ${res.error.message ?? 'unknown'}`);
      return null;
    }
    const sigs = res.result;
    if (!Array.isArray(sigs) || sigs.length === 0) break;

    const last = sigs[sigs.length - 1]!;
    if (last.blockTime != null) oldestBlockTime = last.blockTime;
    before = last.signature;

    if (sigs.length < PAGE) {
      // Reached the earliest signature for this account -> creation time.
      return oldestBlockTime != null ? oldestBlockTime * 1000 : null;
    }
    await sleep(CONFIG.requestDelayMs);
  }

  // Cap reached without confirming the first signature -> unknown (be honest).
  return null;
}
