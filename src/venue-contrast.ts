import { logger } from "./logger.js";
import type { FuturesMidSource } from "./types.js";

export interface VenueContrastConfig {
  /** Fetch timeout in ms. */
  timeoutMs: number;
  /** Disable secondary venue contrast entirely. */
  enabled: boolean;
}

export interface VenueContrast {
  venue: string;
  symbol: string;
  mid: number | null;
  last: number | null;
  binance_mid: number | null;
  basis_bps: number | null;
  available: boolean;
  error?: string;
  fetched_at: number;
}

export interface VenueContrastClient {
  fetchContrast(symbol: string, binanceMid: number | null): Promise<VenueContrast | null>;
}

const DEFAULT_CONFIG: VenueContrastConfig = {
  timeoutMs: (() => {
    const v = Number(process.env.SECONDARY_VENUE_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : 5_000;
  })(),
  enabled: process.env.SECONDARY_VENUE_ENABLED !== "false",
};

function toDisplaySymbol(binanceSymbol: string): string {
  const upper = binanceSymbol.toUpperCase();
  const quotes = ["USDT", "USDC", "BUSD", "USD", "BTC", "ETH", "BNB"];
  for (const quote of quotes) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      const base = upper.slice(0, -quote.length);
      return `${base}/${quote}`;
    }
  }
  return upper;
}

function basisBps(secondaryMid: number | null, binanceMid: number | null): number | null {
  if (secondaryMid === null || binanceMid === null || binanceMid === 0) return null;
  return Math.round(((secondaryMid - binanceMid) / binanceMid) * 10_000 * 100) / 100;
}

/**
 * Venue contrast: Binance spot (primary, via MCP) vs Binance USDT-M futures
 * (secondary, via the MCP relay's futures order-book tool). Computing the
 * basis on the same exchange/venue family gives a clean cross-market signal,
 * and because both legs ride the reachable `agent.binance.com` MCP relay, no
 * direct exchange REST egress (e.g. `fapi.binance.com`) is required — which
 * matters on networks such as Render where that host is blocked.
 *
 * The futures mid is resolved through a `FuturesMidSource` (the primary
 * BinanceMcpClient in production). If the source is unavailable, returns
 * `null` (no futures tool / call failed), the contrast soft-fails and the
 * paid/free intelligence path is unaffected.
 */
export class BinanceFuturesContrastClient implements VenueContrastClient {
  private readonly config: VenueContrastConfig;
  private readonly futuresSource?: FuturesMidSource;

  constructor(config: Partial<VenueContrastConfig> = {}, futuresSource?: FuturesMidSource) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.futuresSource = futuresSource;
  }

  async fetchContrast(symbol: string, binanceMid: number | null): Promise<VenueContrast | null> {
    if (!this.config.enabled) return null;
    const fetchedAt = Date.now();
    const displaySymbol = toDisplaySymbol(symbol);

    let futuresMid: number | null;
    try {
      if (!this.futuresSource) {
        throw new Error("no futures mid source configured");
      }
      futuresMid = await this.futuresSource.getFuturesMid(symbol, this.config.timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Secondary venue contrast unavailable (binance_futures/${displaySymbol}): ${message.slice(0, 180)}`);
      return {
        venue: "binance_futures",
        symbol: displaySymbol,
        mid: null,
        last: null,
        binance_mid: binanceMid,
        basis_bps: null,
        available: false,
        error: "secondary_venue_unavailable",
        fetched_at: fetchedAt,
      };
    }

    return {
      venue: "binance_futures",
      symbol: displaySymbol,
      mid: futuresMid,
      last: null,
      binance_mid: binanceMid,
      basis_bps: basisBps(futuresMid, binanceMid),
      available: futuresMid !== null,
      fetched_at: fetchedAt,
    };
  }
}

/** Test double that never hits the network. */
export class NullVenueContrastClient implements VenueContrastClient {
  async fetchContrast(_symbol: string, _binanceMid: number | null): Promise<VenueContrast | null> {
    return null;
  }
}

export function extractBinanceMid(ticker: Record<string, unknown>): number | null {
  const bid = Number(ticker.bidPrice ?? ticker.bid ?? ticker.b);
  const ask = Number(ticker.askPrice ?? ticker.ask ?? ticker.a);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  const last = Number(ticker.lastPrice ?? ticker.last ?? ticker.c ?? ticker.price);
  if (Number.isFinite(last) && last > 0) return last;
  return null;
}
