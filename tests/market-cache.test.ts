import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketDataCache } from "../src/market-cache.js";
import type { MarketSnapshot } from "../src/types.js";

function makeSnapshot(symbol = "BTCUSDT"): MarketSnapshot {
  return {
    symbol,
    interval: "1h",
    fetchedAt: Date.now(),
    ticker: { lastPrice: "64000" },
    klines: [],
    orderBook: { bids: [], asks: [] },
    sources: ["ticker", "klines", "orderBook"],
  };
}

describe("MarketDataCache", () => {
  let cache: MarketDataCache;

  afterEach(() => {
    cache?.clear();
  });

  it("returns null for unknown symbols", () => {
    cache = new MarketDataCache();
    expect(cache.get("BTCUSDT")).toBeNull();
  });

  it("stores and retrieves snapshots by symbol", () => {
    cache = new MarketDataCache();
    const snapshot = makeSnapshot();
    cache.set("BTCUSDT", snapshot);

    const result = cache.get("BTCUSDT");
    expect(result).not.toBeNull();
    expect(result!.snapshot).toEqual(snapshot);
    expect(result!.stale).toBe(false);
  });

  it("is case-insensitive for symbol keys", () => {
    cache = new MarketDataCache();
    const snapshot = makeSnapshot("BTCUSDT");
    cache.set("BTCUSDT", snapshot);
    expect(cache.get("btcusdt")).not.toBeNull();
    expect(cache.get("BTCUSDT")).not.toBeNull();
  });

  it("marks data as stale after TTL expires", async () => {
    vi.useFakeTimers();
    cache = new MarketDataCache(1); // 1 second TTL

    const snapshot = makeSnapshot();
    cache.set("BTCUSDT", snapshot);

    expect(cache.get("BTCUSDT")!.stale).toBe(false);

    vi.advanceTimersByTime(1_100);

    const result = cache.get("BTCUSDT");
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);

    vi.useRealTimers();
  });

  it("tracks cache size", () => {
    cache = new MarketDataCache();
    expect(cache.size).toBe(0);
    cache.set("BTCUSDT", makeSnapshot("BTCUSDT"));
    expect(cache.size).toBe(1);
    cache.set("ETHUSDT", makeSnapshot("ETHUSDT"));
    expect(cache.size).toBe(2);
    cache.set("BTCUSDT", makeSnapshot("BTCUSDT")); // overwrite
    expect(cache.size).toBe(2);
  });

  it("checks key existence via has()", () => {
    cache = new MarketDataCache();
    expect(cache.has("BTCUSDT")).toBe(false);
    cache.set("BTCUSDT", makeSnapshot());
    expect(cache.has("BTCUSDT")).toBe(true);
    expect(cache.has("btcusdt")).toBe(true);
  });

  it("clear() empties the cache", () => {
    cache = new MarketDataCache();
    cache.set("BTCUSDT", makeSnapshot());
    cache.set("ETHUSDT", makeSnapshot());
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("evicts oldest entries when max size is reached", () => {
    cache = new MarketDataCache(30, 3); // 30s TTL, max 3 entries
    cache.set("AAA", makeSnapshot("AAA"));
    cache.set("BBB", makeSnapshot("BBB"));
    cache.set("CCC", makeSnapshot("CCC"));
    expect(cache.size).toBe(3);

    cache.set("DDD", makeSnapshot("DDD")); // should evict AAA (oldest)
    expect(cache.size).toBe(3);
    expect(cache.has("AAA")).toBe(false);
    expect(cache.has("DDD")).toBe(true);
  });

  it("evicts entries past max stale age on set; soft-stale retained until then", async () => {
    vi.useFakeTimers();
    cache = new MarketDataCache(1, 100, 5); // 1s soft TTL, 5s hard max stale

    cache.set("BTCUSDT", makeSnapshot());
    expect(cache.size).toBe(1);

    vi.advanceTimersByTime(1_100);
    // Soft-stale but within max stale age — still retained
    cache.set("ETHUSDT", makeSnapshot("ETHUSDT"));
    expect(cache.size).toBe(2);
    expect(cache.get("BTCUSDT")?.stale).toBe(true);

    vi.advanceTimersByTime(5_100);
    cache.set("SOLUSDT", makeSnapshot("SOLUSDT"));
    expect(cache.has("BTCUSDT")).toBe(false);
    expect(cache.has("ETHUSDT")).toBe(false);
    expect(cache.has("SOLUSDT")).toBe(true);

    vi.useRealTimers();
  });

  it("respects custom max size", () => {
    cache = new MarketDataCache(30, 5);
    for (let i = 0; i < 10; i++) {
      cache.set(`SYM${i}`, makeSnapshot(`SYM${i}`));
    }
    expect(cache.size).toBe(5);
  });
});
