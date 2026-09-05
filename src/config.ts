import type { TokenConfig } from "./payment/types.js";

export interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
}

function toAtomic(decimalAmount: string, decimals: number): string {
  const [whole, frac = ""] = decimalAmount.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

export const TOKEN_DECIMALS = 18;

export interface TreasuryConfig {
  active: boolean;
  dailyLimitAtomic: string;
  singleLimitAtomic: string;
  withdrawalWhitelist: string[];
  tokenWhitelist: string[];
}

export interface PricingConfig {
  historyPerRecordAtomic: string;
  historyMinAtomic: string;
  batchPerSymbolAtomic: string;
  subscriptionAtomic: string;
  subscriptionRequests: number;
  subscriptionTtlSeconds: number;
}

export interface B402Config {
  network: string;
  /** Facilitator network slug ("bsc" | "base") — mapped from CAIP-2 at the edge. */
  facilitatorNetwork: string;
  chainId: number;
  facilitatorUrl: string;
  /** Relayer contract — verifyingContract / relayerContract only; never payTo. */
  relayer: string;
  /**
   * Seller payee wallet. Challenge `payTo` and authorization.to must match this.
   * Required when payments are enabled in production (fail closed).
   */
  payTo: string;
  /** When false, payment middleware skips 402 entirely. */
  paymentsEnabled: boolean;
  tokens: {
    usdt: TokenConfig;
    usdc: TokenConfig;
  };
  price: {
    atomic: string;
    decimal: string;
  };
  validityWindowSeconds: number;
  rateLimit: RateLimitConfig;
  treasury: TreasuryConfig;
  pricing: PricingConfig;
  /** Hard cap for serving stale MCP cache (seconds). */
  cacheMaxStaleSeconds: number;
  /** Max concurrent MCP snapshot fetches for batch/portfolio. */
  mcpConcurrency: number;
}

const isProduction = process.env.NODE_ENV === "production";

function resolvePayTo(): string {
  const fromEnv = process.env.B402_PAY_TO?.trim() ?? "";
  if (fromEnv) return fromEnv;
  // Non-production default for local/tests; production must set B402_PAY_TO when payments on.
  if (!isProduction) return "0x0000000000000000000000000000000000000001";
  return "";
}

function resolvePaymentsEnabled(): boolean {
  const raw = process.env.PAYMENTS_ENABLED;
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

/** B402 Relayer EIP-712 domain extras (NOT token EIP-3009). */
const B402_TOKEN_DOMAIN_EXTRAS = {
  eip712Name: "B402",
  eip712Version: "1",
  assetTransferMethod: "b402-relayer",
} as const;

export const B402_CONFIG: B402Config = {
  network: "eip155:56",
  facilitatorNetwork: "bsc",
  chainId: 56,
  facilitatorUrl: process.env.B402_FACILITATOR_URL ?? "https://facilitatorv3.b402.ai",
  relayer: process.env.B402_RELAYER ?? "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171",
  payTo: resolvePayTo(),
  paymentsEnabled: resolvePaymentsEnabled(),
  tokens: {
    usdt: {
      address: "0x55d398326f99059fF775485246999027B3197955",
      symbol: "USDT",
      decimals: 18,
      ...B402_TOKEN_DOMAIN_EXTRAS,
    },
    usdc: {
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      symbol: "USDC",
      decimals: 18,
      ...B402_TOKEN_DOMAIN_EXTRAS,
    },
  },
  price: {
    atomic: process.env.B402_PRICE_ATOMIC ?? "50000000000000000",
    decimal: process.env.B402_PRICE_DECIMAL ?? "0.05",
  },
  validityWindowSeconds: process.env.B402_VALIDITY_WINDOW
    ? Math.max(1, Number(process.env.B402_VALIDITY_WINDOW) || 3600)
    : 3600,
  rateLimit: {
    maxRequests: (() => {
      const v = Number(process.env.B402_RATE_LIMIT_MAX);
      return Number.isFinite(v) && v > 0 ? v : 10;
    })(),
    windowSeconds: (() => {
      const v = Number(process.env.B402_RATE_LIMIT_WINDOW);
      return Number.isFinite(v) && v > 0 ? v : 60;
    })(),
  },
  treasury: {
    active: process.env.B402_TREASURY_ACTIVE !== undefined ? process.env.B402_TREASURY_ACTIVE === "true" : true,
    dailyLimitAtomic: process.env.B402_TREASURY_DAILY_LIMIT ?? "10000000000000000000",
    singleLimitAtomic: process.env.B402_TREASURY_SINGLE_LIMIT ?? "1000000000000000000",
    withdrawalWhitelist: process.env.B402_WITHDRAWAL_WHITELIST
      ? process.env.B402_WITHDRAWAL_WHITELIST.split(",")
      : ["0x0000000000000000000000000000000000000001"],
    tokenWhitelist: process.env.B402_TOKEN_WHITELIST
      ? process.env.B402_TOKEN_WHITELIST.split(",")
      : ["0x55d398326f99059fF775485246999027B3197955", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"],
  },
  pricing: {
    historyPerRecordAtomic: process.env.B402_PRICING_HISTORY_PER_RECORD ?? toAtomic("0.01", TOKEN_DECIMALS),
    historyMinAtomic: process.env.B402_PRICING_HISTORY_MIN ?? toAtomic("1", TOKEN_DECIMALS),
    batchPerSymbolAtomic: process.env.B402_PRICING_BATCH_PER_SYMBOL ?? toAtomic("0.04", TOKEN_DECIMALS),
    subscriptionAtomic: process.env.B402_PRICING_SUBSCRIPTION ?? toAtomic("10", TOKEN_DECIMALS),
    subscriptionRequests: (() => {
      const v = Number(process.env.B402_SUBSCRIPTION_REQUESTS);
      return Number.isFinite(v) && v > 0 && v <= 100_000 ? v : 200;
    })(),
    subscriptionTtlSeconds: (() => {
      const v = Number(process.env.B402_SUBSCRIPTION_TTL);
      return Number.isFinite(v) && v > 0 && v <= 604_800 ? v : 86_400;
    })(),
  },
  cacheMaxStaleSeconds: (() => {
    const v = Number(process.env.MARKET_CACHE_MAX_STALE_SECONDS);
    return Number.isFinite(v) && v > 0 ? v : 900;
  })(),
  mcpConcurrency: (() => {
    const v = Number(process.env.MCP_CONCURRENCY);
    return Number.isFinite(v) && v > 0 && v <= 50 ? Math.floor(v) : 5;
  })(),
};

export interface SecondaryVenueConfig {
  enabled: boolean;
  exchangeId: string;
  timeoutMs: number;
}

export const SECONDARY_VENUE_CONFIG: SecondaryVenueConfig = {
  enabled: process.env.SECONDARY_VENUE_ENABLED !== "false",
  exchangeId: process.env.SECONDARY_VENUE ?? "bybit",
  timeoutMs: (() => {
    const v = Number(process.env.SECONDARY_VENUE_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : 5_000;
  })(),
};

/** Fail closed: seller payTo required when payments are enabled in production. */
export function assertPaymentConfig(config: B402Config = B402_CONFIG): void {
  if (!config.paymentsEnabled) return;
  if (isProduction && !config.payTo) {
    throw new Error("B402_PAY_TO is required in production when PAYMENTS_ENABLED is true");
  }
  if (config.payTo && normalizeHexAddress(config.payTo) === normalizeHexAddress(config.relayer)) {
    throw new Error("B402_PAY_TO must be the seller wallet, not the relayer contract");
  }
}

function normalizeHexAddress(addr: string): string {
  return addr.trim().toLowerCase();
}
