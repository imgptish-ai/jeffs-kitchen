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
import { getWalletBuys, getTokenCreationTime, getHeliusStats, resetHeliusStats } from './helius';
import { getPairsForMints } from './dexscreener';
import { getPeakPriceUsd } from './geckoterminal';
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
  resetHeliusStats();

  const now = Date.now();
  const sinceMs = now - CONFIG.scanWindowHours * 3600 * 1000;

  log.step(
    `Scan started ${formatInZone(now, CONFIG.timezone)} | wallet-buy lookback = last ${CONFIG.scanWindowHours}h ` +
      `(since ${formatInZone(sinceMs, CONFIG.timezone)})` +
      (CONFIG.requireCreationInWindow
        ? ` | keeping tokens created ${CONFIG.creationMinAgeHours}-${CONFIG.creationMaxAgeHours}h ago`
        : ''),
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

    // Cheap pre-checks: skip the expensive lookups (Helius creation time +
    // GeckoTerminal peak) for coins that are ALREADY disqualified and can't be
    // rescued by a higher peak. Volume/chain/ignored can only exclude, and if
    // the CURRENT mcap already exceeds the ceiling, the peak (which is >=
    // current) can't bring it back under. This saves Helius calls too.
    const currentMax = Math.max(pair.marketCap ?? 0, pair.fdv ?? 0);
    const ceilingEnabled = CONFIG.maxMarketCap > 0;
    const alreadyOverCeiling = ceilingEnabled && currentMax > CONFIG.maxMarketCap;
    const missingRequiredX = CONFIG.requireXLink && !pair.xLink;
    // A trading pair can never be created before its own token, so if the
    // pair is already older than the band's outer edge (creationMaxAgeHours,
    // which sinceMs is derived from), the token is definitely too old too —
    // safe to exclude without spending a Helius call to check further. The
    // "too young" side can't be pre-proven this way, since a pair can lag
    // well behind true token creation (e.g. later migration to a new pool).
    const pairProvesTooOld =
      CONFIG.requireCreationInWindow && pair.pairCreatedAt != null && pair.pairCreatedAt < sinceMs;
    if (
      CONFIG.ignoredMints.has(mint) ||
      pair.chainId !== 'solana' ||
      pair.volume24h < CONFIG.minVolume ||
      alreadyOverCeiling ||
      missingRequiredX ||
      pairProvesTooOld
    ) {
      continue;
    }

    // Best-effort true token creation time (may be null -> we fall back later).
    let tokenCreatedAt: number | null = null;
    try {
      tokenCreatedAt = await getTokenCreationTime(mint);
    } catch (err) {
      log.warn(`Token creation lookup failed for ${mint}: ${(err as Error).message}`);
    }
    await sleep(CONFIG.requestDelayMs);

    // Creation age check: true creation time if we have it, else DEX
    // Screener's pairCreatedAt as an honest fallback. Unknown (neither
    // available) does NOT count as in-band — see filters.ts.
    const creationTimestamp = tokenCreatedAt ?? pair.pairCreatedAt ?? null;
    const creationTimestampSource: 'token' | 'pair' | 'unknown' =
      tokenCreatedAt != null ? 'token' : pair.pairCreatedAt != null ? 'pair' : 'unknown';
    const creationAgeHours = creationTimestamp != null ? (now - creationTimestamp) / 3600000 : null;

    // Estimate a REAL peak market cap from GeckoTerminal price history.
    // peak market cap = current market cap scaled by (peak price / current price),
    // which assumes supply is ~constant (true for typical memecoins).
    let peakMarketCap: number | null = null;
    let peakPriceUsd: number | null = null;
    let peakAt: number | null = null;
    const baseMcap = pair.marketCap ?? pair.fdv ?? null;
    if (CONFIG.resolvePeakMarketCap && pair.pairAddress && pair.priceUsd && pair.priceUsd > 0 && baseMcap) {
      try {
        const peak = await getPeakPriceUsd(pair.pairAddress, mint);
        if (peak) {
          peakPriceUsd = peak.peakPriceUsd;
          peakAt = peak.peakAt;
          // Peak can't be below the current price; clamp for safety.
          const ratio = Math.max(peak.peakPriceUsd / pair.priceUsd, 1);
          peakMarketCap = baseMcap * ratio;
        }
      } catch (err) {
        log.warn(`Peak lookup failed for ${mint}: ${(err as Error).message}`);
      }
      await sleep(CONFIG.geckoDelayMs);
    }

    // Observed ATH: fold in the current snapshot AND the history-based peak,
    // so the local ATH store is seeded with real peaks from the first run.
    const snapshotMcap = Math.max(pair.marketCap ?? 0, pair.fdv ?? 0, peakMarketCap ?? 0) || null;
    const observedAth = athStore.update(mint, snapshotMcap, now);

    // Primary mcap per configured mode.
    const primaryMcap =
      CONFIG.mcapMode === 'fdv'
        ? pair.fdv
        : CONFIG.mcapMode === 'observedAth'
          ? observedAth
          : pair.marketCap;

    // Filter (peak/ATH band).
    const outcome = applyFilters({
      mint,
      chainId: pair.chainId,
      walletCount: agg.wallets.length,
      marketCap: pair.marketCap,
      fdv: pair.fdv,
      observedAthMarketCap: observedAth,
      peakMarketCap,
      volume24h: pair.volume24h,
      volumeField: pair.volumeField,
      xLink: pair.xLink,
      creationAgeHours,
      creationTimestampSource,
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
      xLink: pair.xLink,
      sessionCategory: session.sessionCategory,
      sessionCategoryReason: session.sessionCategoryReason,
      sessionTimestampUsed: session.sessionTimestampUsed,
      sessionTimestampSource: session.sessionTimestampSource,
      marketCap: pair.marketCap,
      fdv: pair.fdv,
      primaryMcap,
      observedAthMarketCap: observedAth,
      peakMarketCap,
      peakPriceUsd,
      peakAt,
      athEstimate: outcome.athEstimate,
      peakConfidence: outcome.peakConfidence,
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

  // Newest-created first. True token creation time when known, else DEX
  // Screener's pairCreatedAt as the fallback (same priority used elsewhere).
  // A token with neither (shouldn't happen when REQUIRE_CREATION_IN_WINDOW is
  // on, since that requires a resolvable timestamp to pass) sorts last.
  const creationTimeFor = (r: TokenResult): number => r.tokenCreatedAt ?? r.pairCreatedAt ?? -Infinity;
  results.sort((a, b) => creationTimeFor(b) - creationTimeFor(a));

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

  const heliusStats = getHeliusStats();
  log.step(
    `Helius calls this run: ${heliusStats.total} total ` +
      `(${heliusStats.walletTxCalls} wallet-transaction, ${heliusStats.creationTimeCalls} token-creation-time). ` +
      `Compare against your Helius dashboard to track usage over time.`,
  );

  const outDir = writeAllOutputs({ all: results, na, eu });
  log.step(`Wrote results to ${outDir}`);
  log.info(
    `Files: ${CONFIG.files.mainJson}, ${CONFIG.files.mainCsv}, ` +
      `${CONFIG.files.allJson}/${CONFIG.files.naJson}/${CONFIG.files.euJson}, ` +
      `${CONFIG.files.allCsv}/${CONFIG.files.naCsv}/${CONFIG.files.euCsv}`,
  );
}
