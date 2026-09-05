import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesContrastClient } from "../src/venue-contrast.js";

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe("BinanceFuturesContrastClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("computes basis_bps vs spot mid (futures == spot → 0 bps)", async () => {
    const fetchSpy = mockFetch(200, {
      bidPrice: "50000.00",
      askPrice: "50020.00",
      lastPrice: "50010.00",
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 });
    const result = await client.fetchContrast("BTCUSDT", 50010);

    expect(result).not.toBeNull();
    expect(result!.venue).toBe("binance_futures");
    expect(result!.mid).toBe(50010); // (50000 + 50020) / 2
    expect(result!.binance_mid).toBe(50010);
    expect(result!.basis_bps).toBe(0);
    expect(result!.available).toBe(true);
    expect(result!.symbol).toBe("BTC/USDT");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT",
      expect.any(Object),
    );
  });

  it("returns positive basis_bps when futures trade above spot", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { bidPrice: "51000.00", askPrice: "51020.00" }));

    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 });
    const result = await client.fetchContrast("ETHUSDT", 50000);

    expect(result!.mid).toBe(51010);
    // ((51010 - 50000) / 50000) * 10000 = 202 bps
    expect(result!.basis_bps).toBe(202);
  });

  it("soft-fails with available:false on HTTP error", async () => {
    vi.stubGlobal("fetch", mockFetch(403, { error: "blocked" }));

    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 });
    const result = await client.fetchContrast("BTCUSDT", 50000);

    expect(result!.available).toBe(false);
    expect(result!.error).toBe("secondary_venue_unavailable");
    expect(result!.mid).toBeNull();
    expect(result!.basis_bps).toBeNull();
    expect(result!.venue).toBe("binance_futures");
  });

  it("returns null when disabled", async () => {
    const client = new BinanceFuturesContrastClient({ enabled: false, timeoutMs: 1000 });
    const result = await client.fetchContrast("BTCUSDT", 50000);
    expect(result).toBeNull();
  });

  it("maps symbols to display format (case-insensitive)", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { bidPrice: "100", askPrice: "102" }));

    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 });
    const result = await client.fetchContrast("solusdt", 100);
    expect(result!.symbol).toBe("SOL/USDT");
  });

  it("handles null spot mid gracefully (basis null, contrast still available)", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { bidPrice: "50000.00", askPrice: "50020.00" }));

    const client = new BinanceFuturesContrastClient({ enabled: true, timeoutMs: 1000 });
    const result = await client.fetchContrast("BTCUSDT", null);

    expect(result!.mid).toBe(50010);
    expect(result!.binance_mid).toBeNull();
    expect(result!.basis_bps).toBeNull();
    expect(result!.available).toBe(true);
  });
});
