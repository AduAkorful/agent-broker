import { logger } from "./logger.js";

export interface VenueContrastConfig {
  /** Preferred venue id. Only "bybit" is supported for live contrast. */
  exchangeId: string;
  /** Fetch timeout in ms. */
  timeoutMs: number;
  /** Disable secondary venue contrast entirely. */
  enabled: boolean;
  /**
   * Optional Bybit REST base URL override (no trailing slash).
   * Example: https://api.bytick.com
   */
  baseUrl?: string;
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

/** Official Bybit public hosts — same venue, different edge (Render 403s some). */
const BYBIT_BASE_URLS = [
  process.env.SECONDARY_VENUE_BASE_URL,
  "https://api.bytick.com",
  "https://api.bybit.com",
].filter((u): u is string => typeof u === "string" && u.length > 0);

const DEFAULT_CONFIG: VenueContrastConfig = {
  exchangeId: process.env.SECONDARY_VENUE ?? "bybit",
  timeoutMs: (() => {
    const v = Number(process.env.SECONDARY_VENUE_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : 5_000;
  })(),
  enabled: process.env.SECONDARY_VENUE_ENABLED !== "false",
  baseUrl: process.env.SECONDARY_VENUE_BASE_URL,
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

function compactSymbol(ccxtSymbol: string): string {
  return ccxtSymbol.replace("/", "");
}

function uniqueBases(preferred?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [preferred, ...BYBIT_BASE_URLS]) {
    if (!raw) continue;
    const base = raw.replace(/\/$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

async function fetchBybitSpotTicker(
  baseUrl: string,
  ccxtSymbol: string,
  timeoutMs: number,
): Promise<{ mid: number | null; last: number | null }> {
  const url = `${baseUrl}/v5/market/tickers?category=spot&symbol=${compactSymbol(ccxtSymbol)}`;
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
      throw new Error(`${baseUrl} ${res.status} ${res.statusText} ${body.slice(0, 100)}`);
    }
    const raw = (await res.json()) as {
      retCode?: number;
      retMsg?: string;
      result?: { list?: Array<Record<string, string>> };
    };
    if (raw.retCode !== 0) {
      throw new Error(`${baseUrl} retCode=${raw.retCode} ${raw.retMsg ?? ""}`.trim());
    }
    const row = raw.result?.list?.[0];
    if (!row) throw new Error(`${baseUrl} empty ticker list`);
    return extractMidFromTicker({
      bid: Number(row.bid1Price),
      ask: Number(row.ask1Price),
      last: Number(row.lastPrice),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bybit-only venue contrast via public spot ticker REST.
 * Avoids CCXT loadMarkets (instruments-info), which Render egress 403s.
 * Tries official Bybit hosts only — never substitutes another exchange.
 */
export class CcxtVenueContrastClient implements VenueContrastClient {
  private readonly config: VenueContrastConfig;

  constructor(config: Partial<VenueContrastConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async fetchContrast(symbol: string, binanceMid: number | null): Promise<VenueContrast | null> {
    if (!this.config.enabled) return null;
    const fetchedAt = Date.now();
    const venue = this.config.exchangeId.toLowerCase();
    const ccxtSymbol = toCcxtSymbol(symbol);

    if (venue !== "bybit") {
      logger.warn(
        `Secondary venue contrast unavailable (${venue}/${ccxtSymbol}): only bybit is supported (got ${venue})`,
      );
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

    const errors: string[] = [];
    for (const base of uniqueBases(this.config.baseUrl)) {
      try {
        const { mid, last } = await fetchBybitSpotTicker(base, ccxtSymbol, this.config.timeoutMs);
        return {
          venue: "bybit",
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
        errors.push(message.slice(0, 180));
      }
    }

    logger.warn(`Secondary venue contrast unavailable (bybit/${ccxtSymbol}): ${errors.join(" | ")}`);
    return {
      venue: "bybit",
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
