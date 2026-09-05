import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { B402_CONFIG } from "../src/config.js";
import { PaymentService } from "../src/payment/payment-service.js";
import { NonceStore } from "../src/payment/nonce-store.js";
import { paymentMiddleware, PAYMENT_RESPONSE_HEADER } from "../src/payment/middleware.js";
import { MarketDataCache } from "../src/market-cache.js";
import { assertValidInterval, BinanceMcpClient } from "../src/mcp-client.js";
import { CvmsScorer } from "../src/cvms.js";
import { createApp } from "../src/index.js";
import type { McpClientLike, MarketSnapshot } from "../src/types.js";
import type { PaymentPayload } from "../src/payment/types.js";
import { B402FacilitatorClient, toFacilitatorRequest } from "../src/payment/b402-client.js";

const SELLER = B402_CONFIG.payTo;
const RELAYER = B402_CONFIG.relayer;
const USDT = B402_CONFIG.tokens.usdt.address;

function makeAuthPayload(
  overrides: Partial<{
    value: string;
    to: string;
    token: string;
    payTo: string;
    amount: string;
    nonce: string;
  }> = {},
): PaymentPayload {
  const nonce = overrides.nonce ?? "0x" + "ab".repeat(32);
  const amount = overrides.amount ?? B402_CONFIG.price.atomic;
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: B402_CONFIG.network,
      asset: USDT,
      payTo: overrides.payTo ?? SELLER,
      amount,
      maxTimeoutSeconds: 3600,
      extra: { name: "B402", version: "1", assetTransferMethod: "b402-relayer", nonce },
    },
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: overrides.to ?? SELLER,
        value: overrides.value ?? amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce,
        ...(overrides.token ? { token: overrides.token } : {}),
      },
    },
  };
}

describe("FRESH remediation: B402 body + bind + free mode + intel", () => {
  it("toFacilitatorRequest never sends missing token / uses bsc", () => {
    const payload = makeAuthPayload();
    const body = toFacilitatorRequest(payload, payload.accepted, RELAYER);
    expect(body.paymentPayload.token).toBe(USDT);
    expect(body.paymentRequirements.network).toBe("bsc");
    expect(body.paymentRequirements.relayerContract).toBe(RELAYER);
  });

  it("rejects authorization.value mismatch before facilitator", async () => {
    const nonceStore = new NonceStore(":memory:");
    const facilitator = { verify: vi.fn(), settle: vi.fn(), checkHealth: vi.fn() } as unknown as B402FacilitatorClient;
    const paymentService = new PaymentService({ nonceStore, facilitator, config: B402_CONFIG });
    const challenge = paymentService.createPaymentChallenge("http://x/v", "t", B402_CONFIG.price.atomic);
    const payload = makeAuthPayload({ nonce: challenge.nonce, value: "1" });
    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("authorization_value_mismatch");
    expect(facilitator.verify).not.toHaveBeenCalled();
    paymentService.close();
  });

  it("rejects authorization.to diversion before facilitator", async () => {
    const nonceStore = new NonceStore(":memory:");
    const facilitator = { verify: vi.fn(), settle: vi.fn(), checkHealth: vi.fn() } as unknown as B402FacilitatorClient;
    const paymentService = new PaymentService({ nonceStore, facilitator, config: B402_CONFIG });
    const challenge = paymentService.createPaymentChallenge("http://x/v", "t", B402_CONFIG.price.atomic);
    const payload = makeAuthPayload({
      nonce: challenge.nonce,
      to: "0x2222222222222222222222222222222222222222",
    });
    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("authorization_to_mismatch");
    expect(facilitator.verify).not.toHaveBeenCalled();
    paymentService.close();
  });

  it("challenge payTo is seller not relayer; domain is B402", () => {
    const paymentService = new PaymentService({ nonceStore: new NonceStore(":memory:"), config: B402_CONFIG });
    const challenge = paymentService.createPaymentChallenge("http://x/v", "t", B402_CONFIG.price.atomic);
    for (const accept of challenge.paymentRequired.accepts) {
      expect(accept.payTo).toBe(SELLER);
      expect(accept.payTo).not.toBe(RELAYER);
      expect(accept.extra.name).toBe("B402");
      expect(accept.extra.verifyingContract).toBe(RELAYER);
      expect(accept.extra.assetTransferMethod).toBe("b402-relayer");
    }
    paymentService.close();
  });

  it("middleware skips 402 when paymentsEnabled is false", async () => {
    const paymentService = new PaymentService({ nonceStore: new NonceStore(":memory:"), config: B402_CONFIG });
    const app = express();
    app.get("/t", paymentMiddleware(paymentService, { paymentsEnabled: false }), (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/t`);
    expect(res.status).toBe(200);
    expect(
      res.headers.get(PAYMENT_RESPONSE_HEADER.toLowerCase()) || res.headers.get(PAYMENT_RESPONSE_HEADER),
    ).toBeTruthy();
    expect(await res.json()).toEqual({ ok: true });
    await new Promise<void>((r) => server.close(() => r()));
    paymentService.close();
  });

  it("middleware skips 402 when price is 0", async () => {
    const paymentService = new PaymentService({ nonceStore: new NonceStore(":memory:"), config: B402_CONFIG });
    const app = express();
    app.get("/t", paymentMiddleware(paymentService, { price: "0", paymentsEnabled: true }), (_req, res) =>
      res.json({ ok: true }),
    );
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/t`);
    expect(res.status).toBe(200);
    await new Promise<void>((r) => server.close(() => r()));
    paymentService.close();
  });

  it("rejects interval quantity < 1", () => {
    expect(() => assertValidInterval("0m")).toThrow();
    expect(() => assertValidInterval("1h")).not.toThrow();
  });

  it("CVMS exposes open_interest_signal not funding_rate_signal from OI", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score({
      symbol: "BTCUSDT",
      interval: "1h",
      fetchedAt: Date.now(),
      ticker: {},
      klines: [
        { openTime: 1, open: 1, high: 1, low: 1, close: 100, volume: 1 },
        { openTime: 2, open: 1, high: 1, low: 1, close: 110, volume: 1 },
      ],
      orderBook: { bids: [{ price: 1, quantity: 1 }], asks: [{ price: 1, quantity: 1 }] },
      openInterest: 1_000_000,
      sources: ["ticker", "klines", "orderBook", "openInterest"],
    });
    expect(score.open_interest).toBeGreaterThan(0);
    expect(score.open_interest_signal).toBe(score.open_interest);
    expect((score as { funding_rate_signal?: unknown }).funding_rate_signal).toBeUndefined();
  });

  it("batch rejects empty valid symbols before payment (400 not 402)", async () => {
    const mockClient: McpClientLike = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
    };
    const client = new BinanceMcpClient({ clientFactory: () => mockClient });
    const paymentService = new PaymentService({ nonceStore: new NonceStore(":memory:"), config: B402_CONFIG });
    const app = createApp({
      client,
      paymentService,
      adminApiKey: "test-admin-key-with-enough-length",
    });
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/market-intelligence/volatility/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: ["!!", ""] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/valid symbols/i);
    await new Promise<void>((r) => server.close(() => r()));
    paymentService.close();
  });
});

describe("market cache max stale", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes and returns null when beyond max stale age", () => {
    const cache = new MarketDataCache(30, 100, 60);
    cache.set("BTCUSDT", {
      symbol: "BTCUSDT",
      interval: "1h",
      fetchedAt: Date.now(),
      ticker: {},
      klines: [],
      orderBook: { bids: [], asks: [] },
      sources: [],
    } as MarketSnapshot);
    expect(cache.get("BTCUSDT")?.stale).toBe(false);
    vi.advanceTimersByTime(31_000);
    expect(cache.get("BTCUSDT")?.stale).toBe(true);
    vi.advanceTimersByTime(40_000);
    expect(cache.get("BTCUSDT")).toBeNull();
  });
});
