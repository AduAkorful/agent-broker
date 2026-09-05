import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Candle, MarketSnapshot, McpCallResult, McpClientLike, McpTool, OrderBookLevel } from "./types.js";

export const DEFAULT_BINANCE_MCP_ENDPOINT = "https://agent.binance.com/mcp/agentic";

export interface BinanceMcpClientOptions {
  endpoint?: string;
  requestTimeoutMs?: number;
  clientFactory?: () => McpClientLike;
  authToken?: string;
}

type MarketToolKind = "ticker" | "klines" | "orderBook" | "openInterest" | "fundingRate";

const TOOL_PATTERNS: Record<MarketToolKind, RegExp[]> = {
  ticker: [/ticker/i, /price/i],
  klines: [/kline/i, /candle/i, /ohlc/i],
  orderBook: [/order[_-]?book/i, /depth/i],
  openInterest: [/open[_-]?interest/i, /(^|[_-])oi([_-]|$)/i],
  fundingRate: [/funding[_-]?rate/i, /funding/i],
};

const PREFERRED_TOOL_NAMES: Record<MarketToolKind, string[]> = {
  ticker: ["spot.ticker", "spot.ticker24hr", "spot.tickerPrice"],
  klines: ["spot.klines", "spot.uiKlines"],
  orderBook: ["spot.depth"],
  openInterest: [],
  fundingRate: [],
};

const TOOL_SEARCH_CATEGORIES = ["market", "market-data"] as const;
const MAX_TOOL_SEARCH_PAGES = 10;
const MAX_ERROR_TOOL_NAMES = 30;

export function formatAvailableToolNames(availableTools: string[], maxNames = MAX_ERROR_TOOL_NAMES): string {
  if (availableTools.length === 0) return "none";
  if (availableTools.length <= maxNames) return availableTools.join(", ");
  const shown = availableTools.slice(0, maxNames).join(", ");
  return `${shown} ...and ${availableTools.length - maxNames} more`;
}

export class McpToolUnavailableError extends Error {
  constructor(kind: MarketToolKind, availableTools: string[]) {
    super(`Binance MCP tool for ${kind} is unavailable. Available tools: ${formatAvailableToolNames(availableTools)}`);
    this.name = "McpToolUnavailableError";
  }
}

export function mergeTools(existing: McpTool[], discovered: McpTool[]): McpTool[] {
  const byName = new Map<string, McpTool>();
  for (const tool of existing) {
    byName.set(tool.name, tool);
  }
  for (const tool of discovered) {
    const previous = byName.get(tool.name);
    if (!previous) {
      byName.set(tool.name, tool);
      continue;
    }
    byName.set(tool.name, {
      name: tool.name,
      description: tool.description ?? previous.description,
      inputSchema: tool.inputSchema ?? previous.inputSchema,
    });
  }
  return [...byName.values()];
}

export function parseToolSearchPayload(payload: unknown): { tools: McpTool[]; nextCursor?: string } {
  const record = asRecord(payload);
  const rawTools = record.tools;
  if (!Array.isArray(rawTools)) {
    return { tools: [] };
  }

  const tools: McpTool[] = [];
  for (const item of rawTools) {
    const entry = asRecord(item);
    if (typeof entry.name !== "string" || entry.name.trim() === "") continue;
    tools.push({
      name: entry.name,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(entry.inputSchema !== undefined ? { inputSchema: entry.inputSchema as McpTool["inputSchema"] } : {}),
    });
  }

  const nextCursor =
    typeof record.nextCursor === "string" && record.nextCursor.trim() !== "" ? record.nextCursor : undefined;
  return { tools, ...(nextCursor ? { nextCursor } : {}) };
}

function findToolSearchTool(tools: McpTool[]): McpTool | undefined {
  return tools.find((tool) => tool.name.toLowerCase() === "tool_search");
}

/**
 * Create MCP SDK client using Streamable HTTP transport (preferred over deprecated SSE).
 *
 * Auth notes (INTEL-C3 residual):
 * - Full interactive OAuth (`authProvider` + redirect) is not wired here; it requires a browser/user agent.
 * - Default path: optional Bearer `authToken` via requestInit Authorization header.
 * - For interactive OAuth, inject a custom `clientFactory` that constructs StreamableHTTPClientTransport
 *   with an `OAuthClientProvider`, or complete `finishAuth` after redirect.
 */
function createSdkClient(endpoint: string, authToken?: string): McpClientLike {
  const client = new Client({ name: "agent-to-agent-data-broker", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined,
  });
  let disconnectHandler: (() => void) | undefined;
  transport.onclose = () => disconnectHandler?.();
  transport.onerror = () => disconnectHandler?.();

  return {
    connect: () => client.connect(transport),
    close: () => client.close(),
    listTools: async () => {
      const response = await client.listTools();
      return { tools: response.tools as McpTool[] };
    },
    callTool: async (params) => client.callTool(params) as Promise<McpCallResult>,
    setDisconnectHandler: (handler) => {
      disconnectHandler = handler;
    },
  };
}

function payloadFromResult(result: McpCallResult): unknown {
  if (result.isError) {
    throw new Error("Binance MCP tool call failed");
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const text = result.content?.find((item) => item.type === "text" && item.text)?.text;
  if (!text) {
    throw new Error("Binance MCP tool returned no content");
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function requiredNumber(value: unknown, label: string): number {
  const parsed = numberValue(value);
  if (parsed === undefined) throw new Error(`Binance MCP returned an invalid ${label}`);
  return parsed;
}

function unwrapData(value: unknown): unknown {
  const record = asRecord(value);
  return record.data ?? record.result ?? record.payload ?? value;
}

function normalizeTicker(value: unknown): Record<string, unknown> {
  const ticker = asRecord(unwrapData(value));
  if (Object.keys(ticker).length === 0) throw new Error("Binance MCP returned an invalid ticker");
  return ticker;
}

function normalizeCandles(value: unknown): Candle[] {
  const data = unwrapData(value);
  const rows: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(asRecord(data).klines)
      ? (asRecord(data).klines as unknown[])
      : Array.isArray(asRecord(data).candles)
        ? (asRecord(data).candles as unknown[])
        : (() => {
            throw new Error("Binance MCP returned an invalid kline payload");
          })();
  return rows.map((row, index) => {
    if (Array.isArray(row)) {
      return {
        openTime: requiredNumber(row[0], `kline ${index} open time`),
        open: requiredNumber(row[1], `kline ${index} open`),
        high: requiredNumber(row[2], `kline ${index} high`),
        low: requiredNumber(row[3], `kline ${index} low`),
        close: requiredNumber(row[4], `kline ${index} close`),
        volume: requiredNumber(row[5], `kline ${index} volume`),
      };
    }

    const candle = asRecord(row);
    return {
      openTime: requiredNumber(candle.openTime ?? candle.open_time ?? candle.timestamp, `kline ${index} open time`),
      open: requiredNumber(candle.open, `kline ${index} open`),
      high: requiredNumber(candle.high, `kline ${index} high`),
      low: requiredNumber(candle.low, `kline ${index} low`),
      close: requiredNumber(candle.close, `kline ${index} close`),
      volume: requiredNumber(candle.volume, `kline ${index} volume`),
    };
  });
}

function normalizeLevels(value: unknown): OrderBookLevel[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((row, index) => {
    if (Array.isArray(row)) {
      return {
        price: requiredNumber(row[0], `order-book level ${index} price`),
        quantity: requiredNumber(row[1], `order-book level ${index} quantity`),
      };
    }
    const level = asRecord(row);
    return {
      price: requiredNumber(level.price, `order-book level ${index} price`),
      quantity: requiredNumber(level.quantity ?? level.qty, `order-book level ${index} quantity`),
    };
  });
}

function normalizeOrderBook(value: unknown): MarketSnapshot["orderBook"] {
  const book = asRecord(unwrapData(value));
  if (!Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    throw new Error("Binance MCP returned an invalid order-book payload");
  }
  return {
    bids: normalizeLevels(book.bids),
    asks: normalizeLevels(book.asks),
  };
}

function normalizeOpenInterest(value: unknown): number | undefined {
  const payload = unwrapData(value);
  const record = asRecord(payload);
  return numberValue(record.openInterest ?? record.open_interest ?? record.value ?? payload);
}

function normalizeFundingRate(value: unknown): number | undefined {
  const payload = unwrapData(value);
  const record = asRecord(payload);
  return numberValue(record.fundingRate ?? record.funding_rate ?? record.lastFundingRate ?? record.rate ?? payload);
}

function toolScore(tool: McpTool, kind: MarketToolKind): number {
  const name = tool.name.toLowerCase();
  let score = 0;
  const preferred = PREFERRED_TOOL_NAMES[kind];
  const preferredIndex = preferred.findIndex((candidate) => candidate.toLowerCase() === name);
  if (preferredIndex >= 0) {
    score += 300 - preferredIndex * 20;
  }
  if (name.includes("spot")) score += 20;
  if (name.includes("futures") || name.includes("perp")) score -= 10;
  if (kind === "ticker") {
    if (name.includes("ticker")) score += 100;
    else if (name.includes("price")) score += 10;
  } else if (kind === "klines") {
    if (name.includes("kline")) score += 100;
    else if (name.includes("candle") || name.includes("ohlc")) score += 80;
  } else if (kind === "orderBook") {
    if (name.includes("order_book") || name.includes("order-book")) score += 100;
    else if (name.includes("depth")) score += 80;
  } else if (kind === "openInterest") {
    if (name.includes("open_interest") || name.includes("open-interest")) score += 100;
    else if (/(^|[_-])oi([_-]|$)/.test(name)) score += 80;
  } else if (kind === "fundingRate") {
    if (name.includes("funding_rate") || name.includes("funding-rate")) score += 100;
    else if (name.includes("funding")) score += 70;
  }
  return score;
}

export function findTool(
  tools: McpTool[],
  kind: MarketToolKind,
  options: { allowFutures?: boolean } = {},
): McpTool | undefined {
  const allowFutures = options.allowFutures === true;
  const candidates = tools
    .filter((tool) => TOOL_PATTERNS[kind].some((pattern) => pattern.test(tool.name)))
    .filter(
      (tool) =>
        kind === "openInterest" ||
        kind === "fundingRate" ||
        allowFutures ||
        !/(futures|perp|derivative)/i.test(tool.name),
    );
  return candidates.sort((a, b) => toolScore(b, kind) - toolScore(a, kind))[0];
}

export function selectMarketTools(
  tools: McpTool[],
  options: { allowFuturesFallback?: boolean } = {},
): Record<"ticker" | "klines" | "orderBook", McpTool | undefined> {
  const kinds = ["ticker", "klines", "orderBook"] as const;
  const selected = Object.fromEntries(kinds.map((kind) => [kind, findTool(tools, kind)])) as Record<
    (typeof kinds)[number],
    McpTool | undefined
  >;

  if (options.allowFuturesFallback) {
    for (const kind of ["ticker", "klines"] as const) {
      if (!selected[kind]) {
        selected[kind] = findTool(tools, kind, { allowFutures: true });
      }
    }
  }

  return selected;
}

function hasCoreMarketTools(tools: McpTool[]): boolean {
  return Boolean(findTool(tools, "ticker") && findTool(tools, "klines") && findTool(tools, "orderBook"));
}

/** Validate kline interval: quantity must be >= 1 (rejects 0m etc.). */
export function assertValidInterval(interval: string): void {
  if (!/^\d+[mhdw]$/i.test(interval)) throw new Error("Invalid kline interval");
  const match = interval.match(/^(\d+)/);
  const qty = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(qty) || qty < 1) throw new Error("Interval quantity must be >= 1");
}

export class BinanceMcpClient {
  private readonly client: McpClientLike;
  private readonly requestTimeoutMs: number;
  private tools: McpTool[] = [];
  private connected = false;
  private connectPromise?: Promise<McpTool[]>;
  private marketToolsDiscoveryPromise?: Promise<void>;
  private marketToolsDiscovered = false;
  private toolSearchAvailable = false;

  constructor(options: BinanceMcpClientOptions = {}) {
    this.client =
      options.clientFactory?.() ?? createSdkClient(options.endpoint ?? DEFAULT_BINANCE_MCP_ENDPOINT, options.authToken);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.client.setDisconnectHandler?.(() => {
      this.connected = false;
      this.tools = [];
      this.marketToolsDiscovered = false;
      this.toolSearchAvailable = false;
      this.marketToolsDiscoveryPromise = undefined;
    });
  }

  async connect(): Promise<McpTool[]> {
    if (this.connected) return [...this.tools];
    if (!this.connectPromise) {
      this.connectPromise = this.initialize();
    }
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async initialize(): Promise<McpTool[]> {
    try {
      this.marketToolsDiscovered = false;
      this.marketToolsDiscoveryPromise = undefined;
      await this.withTimeout(this.client.connect(), "connect to Binance MCP");
      const response = await this.withTimeout(this.client.listTools(), "list MCP tools");
      this.tools = response.tools;
      this.toolSearchAvailable = Boolean(findToolSearchTool(this.tools));
      this.connected = true;
      await this.ensureMarketToolsDiscovered();
      return [...this.tools];
    } catch (error) {
      this.connected = false;
      this.tools = [];
      this.marketToolsDiscovered = false;
      this.toolSearchAvailable = false;
      this.marketToolsDiscoveryPromise = undefined;
      void this.client.close().catch(() => undefined);
      throw error;
    }
  }

  private async ensureMarketToolsDiscovered(): Promise<void> {
    if (this.marketToolsDiscovered) return;
    if (!this.marketToolsDiscoveryPromise) {
      this.marketToolsDiscoveryPromise = this.discoverMarketTools();
    }
    try {
      await this.marketToolsDiscoveryPromise;
    } finally {
      this.marketToolsDiscoveryPromise = undefined;
    }
  }

  private async discoverMarketTools(): Promise<void> {
    if (hasCoreMarketTools(this.tools)) {
      this.marketToolsDiscovered = true;
      return;
    }

    const searchTool = findToolSearchTool(this.tools);
    this.toolSearchAvailable = Boolean(searchTool);
    if (!searchTool) {
      this.marketToolsDiscovered = true;
      return;
    }

    for (const category of TOOL_SEARCH_CATEGORIES) {
      if (hasCoreMarketTools(this.tools)) break;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_SEARCH_PAGES; page += 1) {
        const args: Record<string, unknown> = { category };
        if (cursor) args.cursor = cursor;
        const result = await this.call(searchTool, args);
        const parsed = parseToolSearchPayload(payloadFromResult(result));
        this.tools = mergeTools(this.tools, parsed.tools);
        if (!parsed.nextCursor) break;
        cursor = parsed.nextCursor;
      }
    }

    this.marketToolsDiscovered = true;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
    this.tools = [];
    this.marketToolsDiscovered = false;
    this.toolSearchAvailable = false;
    this.marketToolsDiscoveryPromise = undefined;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getMarketSnapshot(symbol: string, interval = "1h", limit = 24): Promise<MarketSnapshot> {
    if (!/^[A-Za-z0-9]{3,20}$/.test(symbol)) throw new Error("Invalid market symbol");
    assertValidInterval(interval);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("Kline limit must be an integer from 1 to 1000");
    if (!this.connected) await this.connect();
    await this.ensureMarketToolsDiscovered();
    const kinds = ["ticker", "klines", "orderBook"] as const;
    const selected = selectMarketTools(this.tools, {
      allowFuturesFallback: !this.toolSearchAvailable && !hasCoreMarketTools(this.tools),
    });
    for (const kind of kinds) {
      if (!selected[kind])
        throw new McpToolUnavailableError(
          kind,
          this.tools.map((tool) => tool.name),
        );
    }

    const args = { symbol };
    const [tickerResult, klinesResult, orderBookResult] = await Promise.all([
      this.call(selected.ticker!, args),
      this.call(selected.klines!, { ...args, interval, limit }),
      this.call(selected.orderBook!, { ...args, limit }),
    ]);

    const openInterestTool = findTool(this.tools, "openInterest");
    let openInterest: number | undefined;
    if (openInterestTool) {
      try {
        const result = await this.call(openInterestTool, args);
        openInterest = normalizeOpenInterest(payloadFromResult(result));
      } catch {
        openInterest = undefined;
      }
    }

    const fundingRateTool = findTool(this.tools, "fundingRate");
    let fundingRate: number | undefined;
    if (fundingRateTool) {
      try {
        const result = await this.call(fundingRateTool, args);
        fundingRate = normalizeFundingRate(payloadFromResult(result));
      } catch {
        fundingRate = undefined;
      }
    }

    const sources = ["ticker", "klines", "orderBook"];
    if (openInterest !== undefined) sources.push("openInterest");
    if (fundingRate !== undefined) sources.push("fundingRate");

    return {
      symbol,
      interval,
      fetchedAt: Date.now(),
      ticker: normalizeTicker(payloadFromResult(tickerResult)),
      klines: normalizeCandles(payloadFromResult(klinesResult)),
      orderBook: normalizeOrderBook(payloadFromResult(orderBookResult)),
      ...(openInterest === undefined ? {} : { openInterest }),
      ...(fundingRate === undefined ? {} : { fundingRate }),
      sources,
    };
  }

  private async call(tool: McpTool, args: Record<string, unknown>): Promise<McpCallResult> {
    return this.withTimeout(this.client.callTool({ name: tool.name, arguments: args }), `call ${tool.name}`);
  }

  /**
   * Futures order-book midpoint via the MCP relay (agent.binance.com), used for
   * the spot-vs-futures venue contrast. Looks up a Binance futures order-book
   * tool (e.g. `futures_depth` / `binance.futures.depth`) by name so that no
   * direct `fapi.binance.com` REST egress is required. Returns `null` when no
   * such tool exists or the call fails.
   */
  async getFuturesMid(symbol: string, timeoutMs: number): Promise<number | null> {
    if (!/^[A-Za-z0-9]{3,20}$/.test(symbol)) return null;
    if (!this.connected) await this.connect();
    await this.ensureMarketToolsDiscovered();

    const tool = this.tools
      .filter((t) => /(futures|perp|derivatives?)/i.test(t.name))
      .filter((t) => /(order[_-]?book|depth)/i.test(t.name))
      .sort((a, b) => toolScore(b, "orderBook") - toolScore(a, "orderBook"))[0];
    if (!tool) return null;

    try {
      const result = await this.withTimeout(
        this.client.callTool({ name: tool.name, arguments: { symbol } }),
        `fetch futures order book for ${symbol}`,
        timeoutMs,
      );
      const book = normalizeOrderBook(payloadFromResult(result));
      if (book.bids.length === 0 || book.asks.length === 0) return null;
      const bestBid = Math.max(...book.bids.map((b) => b.price));
      const bestAsk = Math.min(...book.asks.map((a) => a.price));
      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
      return (bestBid + bestAsk) / 2;
    } catch {
      return null;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    operation: string,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Timed out while trying to ${operation}`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
