import { describe, expect, it, vi } from "vitest";
import type { FuturesMidSource } from "../src/types.js";
import { BinanceFuturesContrastClient, NullVenueContrastClient } from "../src/venue-contrast.js";

function makeFakeSource(value: number | null | Error): { source: FuturesMidSource; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn<(symbol: string, timeoutMs: number) => Promise<number | null>>(async (_symbol, _timeoutMs) => {
    if (value instanceof Error) throw value;
    return value;
  });
  return { source: { getFuturesMid: spy }, spy };
}

describe("BinanceFuturesContrastClient", () => {
  it("computes basis_bps vs spot mid (futures == spot -> 0 bps)", async () => {
    const { source, spy } = makeFakeSource(50000);
    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 }, source);
    const result = await client.fetchContrast("BTCUSDT", 50000);

    expect(result).not.toBeNull();
    expect(result!.venue).toBe("binance_futures");
    expect(result!.symbol).toBe("BTC/USDT");
    expect(result!.mid).toBe(50000);
    expect(result!.binance_mid).toBe(50000);
    expect(result!.basis_bps).toBe(0);
    expect(result!.available).toBe(true);
    expect(spy).toHaveBeenCalledWith("BTCUSDT", 1000);
  });

  it("returns positive basis_bps when futures trade above spot", async () => {
    const { source, spy } = makeFakeSource(51010);
    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 }, source);
    const result = await client.fetchContrast("ETHUSDT", 50000);

    expect(result).not.toBeNull();
    expect(result!.mid).toBe(51010);
    // ((51010 - 50000) / 50000) * 10000 = 202 bps
    expect(result!.basis_bps).toBe(202);
    expect(result!.symbol).toBe("ETH/USDT");
    expect(result!.available).toBe(true);
    expect(spy).toHaveBeenCalledWith("ETHUSDT", 1000);
  });

  it("returns negative basis_bps when futures trade below spot", async () => {
    const { source } = makeFakeSource(49000);
    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 5000 }, source);
    const result = await client.fetchContrast("BTCUSDT", 50000);

    expect(result!.basis_bps).toBe(-200);
    expect(result!.available).toBe(true);
  });

  it("soft-fails with available:false when futures source returns null", async () => {
    const { source } = makeFakeSource(null);
    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 }, source);
    const result = await client.fetchContrast("SOLUSDT", 50000);

    expect(result).not.toBeNull();
    expect(result!.available).toBe(false);
    expect(result!.mid).toBeNull();
    expect(result!.basis_bps).toBeNull();
    expect(result!.symbol).toBe("SOL/USDT");
    expect(result!.error).toBeUndefined();
  });

  it("soft-fails with available:false when futures source throws", async () => {
    const { source } = makeFakeSource(new Error("no futures order book"));
    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 }, source);
    const result = await client.fetchContrast("BTCUSDT", 50000);

    expect(result!.available).toBe(false);
    expect(result!.mid).toBeNull();
    expect(result!.basis_bps).toBeNull();
    expect(result!.error).toBe("secondary_venue_unavailable");
  });

  it("returns null when disabled", async () => {
    const { source } = makeFakeSource(51010);
    const client = new BinanceFuturesContrastClient({ enabled: false }, source);
    const result = await client.fetchContrast("BTCUSDT", 50000);

    expect(result).toBeNull();
    expect(source.getFuturesMid).not.toHaveBeenCalled();
  });
});

describe("NullVenueContrastClient", () => {
  it("never performs a contrast", async () => {
    const client = new NullVenueContrastClient();
    const result = await client.fetchContrast("BTCUSDT", 50000);
    expect(result).toBeNull();
  });
});
