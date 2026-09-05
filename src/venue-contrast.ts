import { logger } from "./logger.js";

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

/** Binance USDT-M futures base URL for the book ticker endpoint. */
const FAPI_BASE_URL = "https://fapi.binance.com";

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

async function fetchFuturesMid(
  symbol: string,
  timeoutMs: number,
): Promise<{ mid: number | null; last: number | null }> {
  const url = `${FAPI_BASE_URL}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "agent-broker/1.0 (+https://github.com/AduAkorful/agent-broker)",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 100)}`);
    }
    const row = (await res.json()) as { bidPrice?: string; askPrice?: string; lastPrice?: string };
    const bid = Number(row.bidPrice);
    const ask = Number(row.askPrice);
    const last = Number(row.lastPrice);
    const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    return { mid, last: Number.isFinite(last) ? last : null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Venue contrast via Binance USDT-M futures order-book midpoint vs the
 * Binance spot mid supplied by the primary MCP path. Renders a cross-market
 * basis signal (spot vs perpetual) on the same exchange so contrast works on
 * Render without third-party proxies or egress-blocked venues.
 */
export class BinanceFuturesContrastClient implements VenueContrastClient {
  private readonly config: VenueContrastConfig;

  constructor(config: Partial<VenueContrastConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async fetchContrast(symbol: string, binanceMid: number | null): Promise<VenueContrast | null> {
    if (!this.config.enabled) return null;
    const fetchedAt = Date.now();
    const displaySymbol = toDisplaySymbol(symbol);

    try {
      const { mid } = await fetchFuturesMid(symbol, this.config.timeoutMs);
      return {
        venue: "binance_futures",
        symbol: displaySymbol,
        mid,
        last: null,
        binance_mid: binanceMid,
        basis_bps: basisBps(mid, binanceMid),
        available: mid !== null,
        fetched_at: fetchedAt,
      };
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
