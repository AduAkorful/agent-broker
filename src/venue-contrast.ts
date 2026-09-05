import ccxt, { type Exchange } from "ccxt";
import { logger } from "./logger.js";

export interface VenueContrastConfig {
  /** CCXT exchange id, e.g. "okx" or "bybit". */
  exchangeId: string;
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
  exchangeId: process.env.SECONDARY_VENUE ?? "okx",
  timeoutMs: (() => {
    const v = Number(process.env.SECONDARY_VENUE_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : 5_000;
  })(),
  enabled: process.env.SECONDARY_VENUE_ENABLED !== "false",
};

function extractMidFromTicker(ticker: {
  bid?: number | undefined;
  ask?: number | undefined;
  last?: number | undefined;
  close?: number | undefined;
}): { mid: number | null; last: number | null } {
  const bid = typeof ticker.bid === "number" && Number.isFinite(ticker.bid) ? ticker.bid : null;
  const ask = typeof ticker.ask === "number" && Number.isFinite(ticker.ask) ? ticker.ask : null;
  const last =
    typeof ticker.last === "number" && Number.isFinite(ticker.last)
      ? ticker.last
      : typeof ticker.close === "number" && Number.isFinite(ticker.close)
        ? ticker.close
        : null;
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : last;
  return { mid, last };
}

function toCcxtSymbol(binanceSymbol: string): string {
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

export class CcxtVenueContrastClient implements VenueContrastClient {
  private exchange: Exchange | null = null;
  private readonly config: VenueContrastConfig;

  constructor(config: Partial<VenueContrastConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getExchange(): Exchange {
    if (this.exchange) return this.exchange;
    const id = this.config.exchangeId.toLowerCase();
    const factories = ccxt as unknown as Record<string, new (opts?: Record<string, unknown>) => Exchange>;
    const Factory = factories[id];
    if (!Factory) {
      throw new Error(`Unknown CCXT exchange id: ${id}`);
    }
    this.exchange = new Factory({
      enableRateLimit: true,
      timeout: this.config.timeoutMs,
    });
    return this.exchange;
  }

  async fetchContrast(symbol: string, binanceMid: number | null): Promise<VenueContrast | null> {
    if (!this.config.enabled) return null;
    const fetchedAt = Date.now();
    const venue = this.config.exchangeId.toLowerCase();
    const ccxtSymbol = toCcxtSymbol(symbol);
    try {
      const exchange = this.getExchange();
      const ticker = await exchange.fetchTicker(ccxtSymbol);
      const { mid, last } = extractMidFromTicker(ticker);
      return {
        venue,
        symbol: ccxtSymbol,
        mid,
        last,
        binance_mid: binanceMid,
        basis_bps: basisBps(mid, binanceMid),
        available: true,
        fetched_at: fetchedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Secondary venue contrast unavailable (${venue}/${ccxtSymbol}): ${message}`);
      return {
        venue,
        symbol: ccxtSymbol,
        mid: null,
        last: null,
        binance_mid: binanceMid,
        basis_bps: null,
        available: false,
        error: "secondary_venue_unavailable",
        fetched_at: fetchedAt,
      };
    }
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
