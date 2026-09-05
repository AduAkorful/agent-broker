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
  exchangeId: process.env.SECONDARY_VENUE ?? "bybit",
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

function compactSymbol(ccxtSymbol: string): string {
  return ccxtSymbol.replace("/", "");
}

function okxInstId(ccxtSymbol: string): string {
  return ccxtSymbol.replace("/", "-");
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "agent-broker-venue-contrast/1.0",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 120)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Direct spot ticker — skips CCXT loadMarkets (blocked on some cloud egress). */
async function fetchSpotTickerRest(
  venue: string,
  ccxtSymbol: string,
  timeoutMs: number,
): Promise<{ mid: number | null; last: number | null } | null> {
  if (venue === "bybit") {
    const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${compactSymbol(ccxtSymbol)}`;
    const raw = (await fetchJson(url, timeoutMs)) as {
      retCode?: number;
      retMsg?: string;
      result?: { list?: Array<Record<string, string>> };
    };
    if (raw.retCode !== 0) {
      throw new Error(`bybit retCode=${raw.retCode} ${raw.retMsg ?? ""}`.trim());
    }
    const row = raw.result?.list?.[0];
    if (!row) throw new Error("bybit empty ticker list");
    const bid = Number(row.bid1Price);
    const ask = Number(row.ask1Price);
    const last = Number(row.lastPrice);
    return extractMidFromTicker({
      bid: Number.isFinite(bid) ? bid : undefined,
      ask: Number.isFinite(ask) ? ask : undefined,
      last: Number.isFinite(last) ? last : undefined,
    });
  }
  if (venue === "okx") {
    const url = `https://www.okx.com/api/v5/market/ticker?instId=${okxInstId(ccxtSymbol)}`;
    const raw = (await fetchJson(url, timeoutMs)) as {
      code?: string;
      msg?: string;
      data?: Array<Record<string, string>>;
    };
    if (raw.code !== "0") {
      throw new Error(`okx code=${raw.code} ${raw.msg ?? ""}`.trim());
    }
    const row = raw.data?.[0];
    if (!row) throw new Error("okx empty ticker data");
    const bid = Number(row.bidPx);
    const ask = Number(row.askPx);
    const last = Number(row.last);
    return extractMidFromTicker({
      bid: Number.isFinite(bid) ? bid : undefined,
      ask: Number.isFinite(ask) ? ask : undefined,
      last: Number.isFinite(last) ? last : undefined,
    });
  }
  return null;
}

function ensureSpotMarket(exchange: Exchange, symbol: string): void {
  if (exchange.markets?.[symbol]) return;
  const [base, quote] = symbol.split("/");
  if (!base || !quote) return;
  const id = `${base}${quote}`;
  const market = {
    id,
    symbol,
    base,
    quote,
    baseId: base,
    quoteId: quote,
    active: true,
    type: "spot",
    spot: true,
    margin: false,
    swap: false,
    future: false,
    option: false,
    contract: false,
    precision: { amount: 8, price: 8 },
    limits: { amount: {}, price: {}, cost: {}, leverage: {} },
    info: {},
  } as Exchange["markets"] extends Record<string, infer M> ? M : never;
  exchange.markets = { ...(exchange.markets ?? {}), [symbol]: market };
  const byId = (exchange.markets_by_id ?? {}) as Record<string, unknown>;
  byId[id] = [market];
  exchange.markets_by_id = byId as Exchange["markets_by_id"];
  exchange.symbols = Object.keys(exchange.markets);
  // Skip remote instruments load (403 on Render for Bybit/OKX).
  exchange.loadMarkets = async () => exchange.markets!;
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
      options: { defaultType: "spot" },
    });
    return this.exchange;
  }

  async fetchContrast(symbol: string, binanceMid: number | null): Promise<VenueContrast | null> {
    if (!this.config.enabled) return null;
    const fetchedAt = Date.now();
    const venue = this.config.exchangeId.toLowerCase();
    const ccxtSymbol = toCcxtSymbol(symbol);
    try {
      const rest = await fetchSpotTickerRest(venue, ccxtSymbol, this.config.timeoutMs);
      let mid: number | null;
      let last: number | null;
      if (rest) {
        ({ mid, last } = rest);
      } else {
        const exchange = this.getExchange();
        ensureSpotMarket(exchange, ccxtSymbol);
        const ticker = await exchange.fetchTicker(ccxtSymbol);
        ({ mid, last } = extractMidFromTicker(ticker));
      }
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
