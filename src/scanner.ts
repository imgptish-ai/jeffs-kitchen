/**
 * The main scan pipeline:
 *
 *   1. Load wallets.
 *   2. For each wallet, pull recent transactions (Helius) and detect token buys
 *      inside the scan window.
 *   3. Aggregate by mint: which wallets bought it, first buy time, all buy times.
 *      Drop ignored base/stable tokens.
 *   4. Fetch market data for every mint (DEX Screener, batched).
 *   5. Resolve best-effort true token creation time (Helius) — else fall back.
 *   6. Update the observed-ATH store.
 *   7. Apply filters.
 *   8. Classify NA/EU.
 *   9. Write console table + JSON + CSV (all / NA / EU).
 */
import { CONFIG, assertConfig } from './config';
import { loadWallets } from './wallets';
import { getWalletBuys, getTokenCreationTime } from './helius';
import { getPairsForMints } from './dexscreener';
import { AthStore } from './athStore';
import { applyFilters } from './filters';
import { classifyWithReason } from './session';
import { writeAllOutputs, printConsoleTable, summarizeResult } from './export';
import { log, sleep } from './util';
import { formatInZone } from './time';
import type { TokenBuyAggregate, TokenResult, WalletBuy } from './types';

/** Aggregate raw per-wallet buys into per-token records. */
function aggregateBuys(buys: WalletBuy[]): Map<string, TokenBuyAggregate> {
  const map = new Map<string, TokenBuyAggregate>();
  for (const b of buys) {
    if (CONFIG.ignoredMints.has(b.mint)) continue; // safety net
    const agg = map.get(b.mint);
    if (!agg) {
      map.set(b.mint, {
        mint: b.mint,
        wallets: [b.wallet],
        firstBuyAt: b.boughtAt,
        buyTimes: [b.boughtAt],
      });
    } else {
      if (!agg.wallets.includes(b.wallet)) agg.wallets.push(b.wallet);
      agg.buyTimes.push(b.boughtAt);
      if (b.boughtAt < agg.firstBuyAt) agg.firstBuyAt = b.boughtAt;
    }
  }
  return map;
}

export async function runScan(): Promise<TokenResult[]> {
  assertConfig();

  const now = Date.now();
  const sinceMs = now - CONFIG.scanWindowHours * 3600 * 1000;

  log.step(
    `Scan started ${formatInZone(now, CONFIG.timezone)} | window = last ${CONFIG.scanWindowHours}h ` +
      `(since ${formatInZone(sinceMs, CONFIG.timezone)})`,
  );

  // 1. wallets
  const wallets = loadWallets();
  log.info(`Loaded ${wallets.length} wallet(s) from ${CONFIG.walletsFile}.`);

  // 2. per-wallet buys
  const allBuys: WalletBuy[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i]!;
    try {
      const buys = await getWalletBuys(wallet, sinceMs);
      allBuys.push(...buys);
      log.info(`[${i + 1}/${wallets.length}] ${wallet.slice(0, 6)}… -> ${buys.length} buy(s)`);
    } catch (err) {
      log.warn(`Wallet ${wallet} failed: ${(err as Error).message}`);
    }
    await sleep(CONFIG.requestDelayMs);
  }

  // 3. aggregate
  const aggregates = aggregateBuys(allBuys);
  const mints = [...aggregates.keys()];
  log.info(`Found ${mints.length} unique non-base token(s) bought across all wallets.`);
  if (mints.length === 0) {
    const empty: TokenResult[] = [];
    finish(empty);
    return empty;
  }

  // 4. market data
  log.step('Fetching DEX Screener market data…');
  const pairs = await getPairsForMints(mints);
  log.info(`Got market data for ${pairs.size}/${mints.length} token(s).`);

  // 5–8. enrich, filter, classify
  const athStore = new AthStore();
  const results: TokenResult[] = [];

  for (const mint of mints) {
    const agg = aggregates.get(mint)!;
    const pair = pairs.get(mint);
    if (!pair) continue; // no market data -> can't meet mcap/vol thresholds

    // Best-effort true token creation time (may be null -> we fall back later).
    let tokenCreatedAt: number | null = null;
    try {
      tokenCreatedAt = await getTokenCreationTime(mint);
    } catch (err) {
      log.warn(`Token creation lookup failed for ${mint}: ${(err as Error).message}`);
    }
    await sleep(CONFIG.requestDelayMs);

    // Observed ATH: snapshot the primary mcap (fallback to fdv).
    const snapshotMcap = pair.marketCap ?? pair.fdv ?? null;
    const observedAth = athStore.update(mint, snapshotMcap, now);

    // Primary mcap per configured mode.
    const primaryMcap =
      CONFIG.mcapMode === 'fdv'
        ? pair.fdv
        : CONFIG.mcapMode === 'observedAth'
          ? observedAth
          : pair.marketCap;

    // Filter.
    const outcome = applyFilters({
      mint,
      chainId: pair.chainId,
      walletCount: agg.wallets.length,
      marketCap: pair.marketCap,
      fdv: pair.fdv,
      observedAthMarketCap: observedAth,
      volume24h: pair.volume24h,
      volumeField: pair.volumeField,
    });
    if (!outcome.passed) continue;

    // Classify NA/EU using timestamp priority.
    const session = classifyWithReason({
      tokenCreatedAt,
      pairCreatedAt: pair.pairCreatedAt,
      firstBuyAt: agg.firstBuyAt,
    });

    results.push({
      name: pair.name,
      symbol: pair.symbol,
      contractAddress: mint,
      mint,
      tokenCreatedAt,
      tokenCreatedAtSource: tokenCreatedAt != null ? 'token' : null,
      pairCreatedAt: pair.pairCreatedAt,
      sessionCategory: session.sessionCategory,
      sessionCategoryReason: session.sessionCategoryReason,
      sessionTimestampUsed: session.sessionTimestampUsed,
      sessionTimestampSource: session.sessionTimestampSource,
      marketCap: pair.marketCap,
      fdv: pair.fdv,
      primaryMcap,
      observedAthMarketCap: observedAth,
      volume24h: pair.volume24h,
      volumeField: pair.volumeField,
      liquidityUsd: pair.liquidityUsd,
      priceUsd: pair.priceUsd,
      priceChange24h: pair.priceChange24h,
      chainId: pair.chainId,
      dexId: pair.dexId,
      buys24h: pair.buys24h,
      sells24h: pair.sells24h,
      pairAddress: pair.pairAddress,
      dexScreenerUrl: pair.url || `https://dexscreener.com/solana/${mint}`,
      wallets: agg.wallets,
      firstBuyAt: agg.firstBuyAt,
      detectedAt: now,
      filterReason: outcome.reason,
    });
  }

  athStore.save();

  // Sort: biggest market cap first for readability.
  results.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));

  finish(results);
  return results;
}

/** Split into NA/EU, print, and write all output files. */
function finish(results: TokenResult[]): void {
  const na = results.filter((r) => r.sessionCategory === 'NA');
  const eu = results.filter((r) => r.sessionCategory === 'EU');

  log.step(`Matched ${results.length} token(s): ${na.length} NA, ${eu.length} EU.`);
  for (const r of results) log.info(summarizeResult(r));

  printConsoleTable(results);

  const outDir = writeAllOutputs({ all: results, na, eu });
  log.step(`Wrote results to ${outDir}`);
  log.info(
    `Files: ${CONFIG.files.mainJson}, ${CONFIG.files.mainCsv}, ` +
      `${CONFIG.files.allJson}/${CONFIG.files.naJson}/${CONFIG.files.euJson}, ` +
      `${CONFIG.files.allCsv}/${CONFIG.files.naCsv}/${CONFIG.files.euCsv}`,
  );
}
