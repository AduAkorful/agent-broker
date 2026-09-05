import { describe, expect, it, vi } from "vitest";
import {
  BinanceMcpClient,
  McpToolUnavailableError,
  formatAvailableToolNames,
  mergeTools,
  parseToolSearchPayload,
  selectMarketTools,
} from "../src/mcp-client.js";
import type { McpCallResult, McpClientLike, McpTool } from "../src/types.js";

class FakeMcpClient implements McpClientLike {
  readonly calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  constructor(
    private readonly tools: McpTool[],
    private readonly responses: Record<string, McpCallResult>,
  ) {}
  async connect() {}
  async close() {}
  async listTools() {
    return { tools: this.tools };
  }
  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    this.calls.push(params);
    return this.responses[params.name] ?? { isError: true };
  }
}

const tools: McpTool[] = [
  { name: "spot_ticker" },
  { name: "market_klines" },
  { name: "order_book_depth" },
  { name: "futures_open_interest" },
];

describe("BinanceMcpClient", () => {
  it("discovers market tools and returns normalized market data", async () => {
    const fake = new FakeMcpClient(tools, {
      spot_ticker: { structuredContent: { symbol: "BTCUSDT", lastPrice: "64000.5" } },
      market_klines: {
        content: [{ type: "text", text: JSON.stringify({ data: [[1000, "1", "2", "0.5", "1.5", "10"]] }) }],
      },
      order_book_depth: { structuredContent: { bids: [["63999", "2"]], asks: [{ price: "64001", qty: "3" }] } },
      futures_open_interest: { structuredContent: { openInterest: "123.4" } },
    });
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });

    const snapshot = await client.getMarketSnapshot("btcusdt", "15m", 12);

    expect(snapshot.symbol).toBe("btcusdt");
    expect(snapshot.ticker.lastPrice).toBe("64000.5");
    expect(snapshot.klines).toEqual([{ openTime: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
    expect(snapshot.orderBook).toEqual({
      bids: [{ price: 63999, quantity: 2 }],
      asks: [{ price: 64001, quantity: 3 }],
    });
    expect(snapshot.openInterest).toBe(123.4);
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        { name: "spot_ticker", arguments: { symbol: "btcusdt" } },
        { name: "market_klines", arguments: { symbol: "btcusdt", interval: "15m", limit: 12 } },
        { name: "order_book_depth", arguments: { symbol: "btcusdt", limit: 12 } },
        { name: "futures_open_interest", arguments: { symbol: "btcusdt" } },
      ]),
    );
  });

  it("allows open interest to be absent while requiring core market tools", async () => {
    const fake = new FakeMcpClient(tools.slice(0, 3), {
      spot_ticker: { structuredContent: { lastPrice: 1 } },
      market_klines: { structuredContent: [] },
      order_book_depth: { structuredContent: { bids: [], asks: [] } },
    });
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });
    const snapshot = await client.getMarketSnapshot("ETHUSDT");
    expect(snapshot).toMatchObject({ symbol: "ETHUSDT" });
    expect(snapshot.openInterest).toBeUndefined();
  });

  it("reports unavailable required tools clearly", async () => {
    const fake = new FakeMcpClient([{ name: "spot_ticker" }], { spot_ticker: { structuredContent: { lastPrice: 1 } } });
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });
    await expect(client.getMarketSnapshot("BTCUSDT")).rejects.toBeInstanceOf(McpToolUnavailableError);
  });

  it("recovers after tool discovery fails", async () => {
    let attempts = 0;
    const fake: McpClientLike = {
      async connect() {},
      async close() {},
      async listTools() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary discovery failure");
        return { tools: tools.slice(0, 3) };
      },
      async callTool({ name }) {
        const responses: Record<string, McpCallResult> = {
          spot_ticker: { structuredContent: { lastPrice: 1 } },
          market_klines: { structuredContent: [] },
          order_book_depth: { structuredContent: { bids: [], asks: [] } },
        };
        return responses[name] ?? { isError: true };
      },
    };
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });
    await expect(client.getMarketSnapshot("BTCUSDT")).rejects.toThrow("temporary discovery failure");
    await expect(client.getMarketSnapshot("BTCUSDT")).resolves.toMatchObject({ symbol: "BTCUSDT" });
    expect(attempts).toBe(2);
  });

  it("ignores a failed optional open-interest call", async () => {
    const fake = new FakeMcpClient(tools, {
      spot_ticker: { structuredContent: { lastPrice: 1 } },
      market_klines: { structuredContent: [] },
      order_book_depth: { structuredContent: { bids: [], asks: [] } },
      futures_open_interest: { isError: true },
    });
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });
    const snapshot = await client.getMarketSnapshot("BTCUSDT");
    expect(snapshot.openInterest).toBeUndefined();
  });

  it("rejects invalid limits and malformed core payloads", async () => {
    const fake = new FakeMcpClient(tools.slice(0, 3), {
      spot_ticker: { structuredContent: { lastPrice: 1 } },
      market_klines: { structuredContent: { unexpected: true } },
      order_book_depth: { structuredContent: { bids: [], asks: [] } },
    });
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });
    await expect(client.getMarketSnapshot("BTCUSDT", "1h", 0)).rejects.toThrow("Kline limit");
    await expect(client.getMarketSnapshot("BTCUSDT")).rejects.toThrow("invalid kline payload");
  });

  it("does not use derivative-only tools for the core spot snapshot", async () => {
    const fake = new FakeMcpClient(
      [{ name: "futures_ticker" }, { name: "futures_klines" }, { name: "futures_depth" }],
      {},
    );
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });
    await expect(client.getMarketSnapshot("BTCUSDT")).rejects.toBeInstanceOf(McpToolUnavailableError);
  });

  it("times out when MCP tool call never resolves", async () => {
    const hangingFake: McpClientLike = {
      async connect() {},
      async close() {},
      async listTools() {
        return { tools };
      },
      async callTool() {
        return new Promise<never>(() => {});
      },
    };
    const client = new BinanceMcpClient({ clientFactory: () => hangingFake, requestTimeoutMs: 100 });

    await expect(client.getMarketSnapshot("BTCUSDT")).rejects.toThrow("Timed out");
  });

  it("times out when MCP connect never resolves", async () => {
    const hangingFake: McpClientLike = {
      async connect() {
        return new Promise<never>(() => {});
      },
      async close() {},
      async listTools() {
        return { tools };
      },
      async callTool() {
        return { structuredContent: {} };
      },
    };
    const client = new BinanceMcpClient({ clientFactory: () => hangingFake, requestTimeoutMs: 100 });

    await expect(client.getMarketSnapshot("BTCUSDT")).rejects.toThrow("Timed out");
  });

  it("closes the underlying client when connected", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const fake: McpClientLike = {
      async connect() {},
      close: closeSpy,
      async listTools() {
        return { tools: tools.slice(0, 3) };
      },
      async callTool() {
        return { structuredContent: {} };
      },
      setDisconnectHandler(_handler: () => void): void {},
    };
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });

    await client.connect();
    expect(client.isConnected()).toBe(true);

    await client.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });

  it("does not call close when not connected", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const fake: McpClientLike = {
      async connect() {},
      close: closeSpy,
      async listTools() {
        return { tools };
      },
      async callTool() {
        return { structuredContent: {} };
      },
      setDisconnectHandler(_handler: () => void): void {},
    };
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });

    expect(client.isConnected()).toBe(false);
    await client.close();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("discovers spot market tools via tool_search and calls them directly", async () => {
    const listed: McpTool[] = [
      { name: "tool_search" },
      { name: "futures_ticker" },
      { name: "futures_klines" },
      { name: "futures_depth" },
      { name: "tool_execute" },
    ];
    const fake = new FakeMcpClient(listed, {
      tool_search: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              tools: [
                { name: "spot.ticker", description: "Spot ticker" },
                { name: "spot.klines", description: "Spot klines" },
                { name: "spot.depth", description: "Spot order book" },
              ],
            }),
          },
        ],
      },
      "spot.ticker": { structuredContent: { symbol: "BTCUSDT", lastPrice: "65000" } },
      "spot.klines": { structuredContent: [[1000, "1", "2", "0.5", "1.5", "10"]] },
      "spot.depth": { structuredContent: { bids: [["64999", "1"]], asks: [["65001", "2"]] } },
    });
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });

    const snapshot = await client.getMarketSnapshot("BTCUSDT", "1h", 24);

    expect(snapshot.ticker.lastPrice).toBe("65000");
    expect(snapshot.klines).toHaveLength(1);
    expect(snapshot.orderBook.bids[0]?.price).toBe(64999);
    expect(fake.calls.filter((call) => call.name === "tool_search")).toEqual(
      expect.arrayContaining([{ name: "tool_search", arguments: { category: "market" } }]),
    );
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        { name: "spot.ticker", arguments: { symbol: "BTCUSDT" } },
        { name: "spot.klines", arguments: { symbol: "BTCUSDT", interval: "1h", limit: 24 } },
        { name: "spot.depth", arguments: { symbol: "BTCUSDT", limit: 24 } },
      ]),
    );
    expect(fake.calls.some((call) => call.name.startsWith("futures_"))).toBe(false);
  });

  it("truncates huge available-tool lists in McpToolUnavailableError", async () => {
    const manyTools = Array.from({ length: 40 }, (_, index) => ({ name: `misc_tool_${index}` }));
    const fake = new FakeMcpClient(manyTools, {});
    const client = new BinanceMcpClient({ clientFactory: () => fake, requestTimeoutMs: 100 });
    await expect(client.getMarketSnapshot("BTCUSDT")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(McpToolUnavailableError);
      const message = (error as Error).message;
      expect(message).toContain("misc_tool_0");
      expect(message).toContain("...and 10 more");
      expect(message).not.toContain("misc_tool_39");
      return true;
    });
  });
});

describe("mcp-client helpers", () => {
  it("merges discovered tools by name without dropping always-exposed tools", () => {
    const merged = mergeTools(
      [{ name: "tool_search" }, { name: "futures_ticker" }],
      [{ name: "spot.ticker", description: "Spot ticker" }, { name: "futures_ticker", description: "updated" }],
    );
    expect(merged.map((tool) => tool.name)).toEqual(["tool_search", "futures_ticker", "spot.ticker"]);
    expect(merged.find((tool) => tool.name === "futures_ticker")?.description).toBe("updated");
  });

  it("parses tool_search JSON payloads including nextCursor", () => {
    const parsed = parseToolSearchPayload({
      tools: [{ name: "spot.depth", inputSchema: { type: "object" } }, { name: "" }, { nope: true }],
      nextCursor: "page-2",
    });
    expect(parsed.tools).toEqual([{ name: "spot.depth", inputSchema: { type: "object" } }]);
    expect(parsed.nextCursor).toBe("page-2");
  });

  it("prefers exact spot tool names when selecting market tools", () => {
    const selected = selectMarketTools([
      { name: "spot.tickerPrice" },
      { name: "spot.ticker" },
      { name: "spot.uiKlines" },
      { name: "spot.klines" },
      { name: "spot.depth" },
      { name: "futures_ticker" },
    ]);
    expect(selected.ticker?.name).toBe("spot.ticker");
    expect(selected.klines?.name).toBe("spot.klines");
    expect(selected.orderBook?.name).toBe("spot.depth");
  });

  it("formats long tool-name lists with a trailing count", () => {
    const names = Array.from({ length: 35 }, (_, index) => `tool_${index}`);
    expect(formatAvailableToolNames(names)).toContain("...and 5 more");
    expect(formatAvailableToolNames([])).toBe("none");
  });
});
