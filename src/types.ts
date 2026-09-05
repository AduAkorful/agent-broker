export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallResult>;
  setDisconnectHandler?(handler: () => void): void;
}

/**
 * Minimal source for the Binance USDT-M futures order-book midpoint, fetched
 * through the MCP relay (agent.binance.com) so no direct exchange REST egress is
 * required. The contrast path is the sole consumer of this.
 */
export interface FuturesMidSource {
  /** Resolves the futures best-bid/ask midpoint, or `null` when unavailable. */
  getFuturesMid(symbol: string, timeoutMs: number): Promise<number | null>;
}

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface MarketSnapshot {
  symbol: string;
  interval: string;
  fetchedAt: number;
  ticker: Record<string, unknown>;
  klines: Candle[];
  orderBook: {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  };
  openInterest?: number;
  /** Real funding rate when MCP exposes a funding tool; never confused with OI. */
  fundingRate?: number;
  sources: string[];
}

export interface CvmsScore {
  symbol: string;
  timestamp: number;
  volatility_score: number;
  momentum_score: number;
  composite_score: number;
  open_interest: number;
  /** Alias of open_interest used in scoring (honest naming vs fake funding). */
  open_interest_signal?: number;
  /** Present only when a real funding-rate tool returned data. */
  funding_rate?: number;
  order_book_imbalance: number;
  realized_volatility_24h: number;
  data_ttl_seconds: number;
  stale?: boolean;
  sources: string[];
  data_age_ms: number;
  confidence_score: number;
}
