/** A single detected "buy" of a token by one wallet. */
export interface WalletBuy {
  mint: string; // token mint address (a.k.a. contract address on Solana)
  wallet: string; // the buyer wallet from your imported list
  boughtAt: number; // epoch ms of the transaction
  signature: string; // tx signature (useful for debugging)
}

/** Aggregated per-token buy info across all wallets. */
export interface TokenBuyAggregate {
  mint: string;
  wallets: string[]; // distinct wallets that bought it
  firstBuyAt: number; // earliest buy time (epoch ms)
  buyTimes: number[]; // all buy times (epoch ms)
}

/** Market data pulled from DEX Screener for the best pair of a token. */
export interface PairData {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  name: string;
  symbol: string;
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  volume24h: number; // value of the chosen volume field
  volumeField: string; // which field was used: h24 | h6 | h1 | m5 | none
  priceChange24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  pairCreatedAt: number | null; // epoch ms, from DEX Screener
}

/** Persisted observed-ATH record for a single mint. */
export interface AthRecord {
  mint: string;
  observedAthMarketCap: number;
  lastMarketCap: number | null;
  firstSeenAt: number; // epoch ms
  lastSeenAt: number; // epoch ms
  snapshotCount: number;
}

export type SessionCategory = 'NA' | 'EU';

/** The final, filtered result object for one token. */
export interface TokenResult {
  // Identity
  name: string;
  symbol: string;
  contractAddress: string; // == mint on Solana
  mint: string;

  // Timestamps
  tokenCreatedAt: number | null; // true mint creation time if resolved (epoch ms)
  tokenCreatedAtSource: 'token' | null;
  pairCreatedAt: number | null; // DEX Screener pool creation (epoch ms)

  // Session
  sessionCategory: SessionCategory;
  sessionCategoryReason: string;
  sessionTimestampUsed: number; // the epoch ms that drove the classification
  sessionTimestampSource: 'token' | 'pair' | 'buy';

  // Market data
  marketCap: number | null;
  fdv: number | null;
  primaryMcap: number | null; // per CONFIG.mcapMode
  observedAthMarketCap: number | null;
  peakMarketCap: number | null; // estimated peak from GeckoTerminal history (null if unavailable)
  peakPriceUsd: number | null;
  peakAt: number | null; // when the peak occurred (epoch ms)
  athEstimate: number; // the value the peak-band filter used
  peakConfidence: 'history' | 'observed-or-current';
  volume24h: number;
  volumeField: string;
  liquidityUsd: number | null;
  priceUsd: number | null;
  priceChange24h: number | null;
  chainId: string;
  dexId: string;
  buys24h: number | null;
  sells24h: number | null;

  // Links
  pairAddress: string;
  dexScreenerUrl: string;

  // Provenance
  wallets: string[];
  firstBuyAt: number;
  detectedAt: number; // when this scan ran (epoch ms)
  filterReason: string; // why it passed the filters
}
