import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { Express } from "express";
import { createApp } from "../src/index.js";
import { BinanceMcpClient } from "../src/mcp-client.js";
import { B402FacilitatorClient } from "../src/payment/b402-client.js";
import { PaymentService } from "../src/payment/payment-service.js";
import { RateLimitStore } from "../src/payment/rate-limit-store.js";
import { SubscriptionStore } from "../src/payment/subscription-store.js";
import { NonceStore } from "../src/payment/nonce-store.js";
import { ScoreHistoryStore } from "../src/score-history-store.js";
import { TreasuryStore } from "../src/payment/treasury-store.js";
import { B402_CONFIG } from "../src/config.js";
import { MarketDataCache } from "../src/market-cache.js";
import type { PaymentPayload, SettleResponse, VerifyResponse } from "../src/payment/types.js";
import type { McpCallResult, McpClientLike, McpTool } from "../src/types.js";

const USDT = B402_CONFIG.tokens.usdt.address;
const SELLER = B402_CONFIG.payTo;
const SUB_AMOUNT = B402_CONFIG.pricing.subscriptionAtomic;
const BATCH_AMOUNT = B402_CONFIG.pricing.batchPerSymbolAtomic;

function makeMockFacilitator(
  verifyResponse: VerifyResponse = { isValid: true, payer: "0x1234" },
  settleResponse: SettleResponse = { success: true, transaction: "0xtx", network: "eip155:56", payer: "0x1234" },
): B402FacilitatorClient {
  const mock = {
    verify: vi.fn().mockResolvedValue(verifyResponse),
    settle: vi.fn().mockResolvedValue(settleResponse),
    checkHealth: vi.fn().mockResolvedValue(true),
  };
  return mock as unknown as B402FacilitatorClient;
}

function createPaymentPayload(nonce: string, amount: string = B402_CONFIG.price.atomic): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "http://localhost/api/v1/test" },
    accepted: {
      scheme: "exact",
      network: B402_CONFIG.network,
      asset: USDT,
      payTo: SELLER,
      amount,
      maxTimeoutSeconds: 3600,
      extra: {
        name: "Tether USD",
        version: "1",
        assetTransferMethod: "b402-relayer",
        nonce,
        validAfter: 1,
        validBefore: 9999999999,
      },
    },
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0x1234567890123456789012345678901234567890",
        to: SELLER,
        value: amount,
        validAfter: "1",
        validBefore: "9999999999",
        nonce,
      },
    },
  };
}

function encodePayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

function decodeHeader(headerValue: string | null): unknown {
  if (!headerValue) return null;
  return JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://localhost:${port}`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

const tools: McpTool[] = [{ name: "spot_ticker" }, { name: "market_klines" }, { name: "order_book_depth" }];

function makeSnapshotResponses(): Record<string, McpCallResult> {
  return {
    spot_ticker: { structuredContent: { lastPrice: "64000.5", symbol: "BTCUSDT" } },
    market_klines: {
      structuredContent: [
        { openTime: 1000, open: 63000, high: 65000, low: 62000, close: 64000, volume: 1000 },
        { openTime: 2000, open: 64000, high: 66000, low: 63000, close: 65000, volume: 1100 },
      ],
    },
    order_book_depth: {
      structuredContent: {
        bids: [
          { price: 63999, quantity: 10 },
          { price: 63998, quantity: 5 },
        ],
        asks: [
          { price: 64001, quantity: 8 },
          { price: 64002, quantity: 3 },
        ],
      },
    },
  };
}

class FakeMcpClient implements McpClientLike {
  callCount = 0;
  callLog: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
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
    this.callCount++;
    this.callLog.push(params);
    return this.responses[params.name] ?? { isError: true };
  }
  setDisconnectHandler?(_handler: () => void): void {}
}

interface TestContext {
  server: { url: string; close: () => Promise<void> } | null;
  paymentService: PaymentService | null;
  rateLimiter: RateLimitStore | null;
  subscriptionStore: SubscriptionStore | null;
  scoreHistoryStore: ScoreHistoryStore | null;
}

function makeTestContext(): TestContext {
  return {
    server: null,
    paymentService: null,
    rateLimiter: null,
    subscriptionStore: null,
    scoreHistoryStore: null,
  };
}

function cleanupContext(ctx: TestContext): void {
  ctx.paymentService?.close();
  ctx.rateLimiter?.close();
  ctx.subscriptionStore?.close();
  ctx.scoreHistoryStore?.close();
  if (ctx.server) ctx.server.close();
}

async function get402Nonce(
  serverUrl: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<string> {
  const init: RequestInit = method === "POST" ? { method: "POST" } : {};
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const challengeResp = await fetch(`${serverUrl}${path}`, init);
  expect(challengeResp.status).toBe(402);
  const pr = decodeHeader(challengeResp.headers.get("payment-required")) as {
    accepts: Array<{ extra: { nonce: string } }>;
  };
  return pr.accepts[0]!.extra.nonce;
}

async function payRequest(
  serverUrl: string,
  path: string,
  nonce: string,
  amount: string = B402_CONFIG.price.atomic,
  body?: unknown,
): Promise<Response> {
  const payload = createPaymentPayload(nonce, amount);
  const init: RequestInit = {
    headers: { "payment-signature": encodePayload(payload) },
  };
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return fetch(`${serverUrl}${path}`, init);
}

describe("M9 Adversarial — Subscription Farming Prevention", () => {
  let ctx: TestContext;

  afterEach(() => cleanupContext(ctx));

  it("PREVENTS: subscription nonce sent to /subscription does not deduct from existing balance", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.subscriptionStore = new SubscriptionStore();
    const nonceStore = new NonceStore();
    ctx.paymentService = new PaymentService({ facilitator, nonceStore, subscriptionStore: ctx.subscriptionStore! });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      subscriptionStore: ctx.subscriptionStore!,
      scoreHistoryStore: ctx.scoreHistoryStore!,
      cache: new MarketDataCache(),
    });
    ctx.server = await startServer(app);

    // Step 1: Purchase a subscription (pay 10 USDT) — no body needed, just get challenge
    const challengeNonce = await get402Nonce(ctx.server!.url, "/api/v1/subscription", "POST", {});

    // Pay with subscription amount
    const subResp = await payRequest(ctx.server!.url, "/api/v1/subscription", challengeNonce, SUB_AMOUNT, {});
    expect(subResp.status).toBe(200);
    const subData = (await subResp.json()) as {
      subscription_nonce: string;
      remaining_balance: number;
    };
    expect(subData.subscription_nonce).toBeTruthy();
    expect(subData.remaining_balance).toBe(B402_CONFIG.pricing.subscriptionRequests);
    const subNonce = subData.subscription_nonce;

    // Verify subscription balance is 200
    const subBefore = ctx.subscriptionStore!.getSubscription(subNonce);
    expect(subBefore).not.toBeNull();
    expect(subBefore!.remaining_balance).toBe(B402_CONFIG.pricing.subscriptionRequests);

    // Step 2: Attempt subscription farming — send subscription nonce to /subscription
    // The middleware should skip subscription check (skipSubscriptionCheck: true) and require real payment
    const farmResp = await payRequest(ctx.server!.url, "/api/v1/subscription", subNonce, SUB_AMOUNT, {});
    expect(farmResp.status).toBe(200); // payment succeeded via mock facilitator, new subscription created

    // The original subscription's balance must NOT have been deducted
    const subAfter = ctx.subscriptionStore!.getSubscription(subNonce);
    expect(subAfter).not.toBeNull();
    expect(subAfter!.remaining_balance).toBe(B402_CONFIG.pricing.subscriptionRequests); // unchanged!

    const farmData = (await farmResp.json()) as { subscription_nonce: string };
    expect(farmData.subscription_nonce).not.toBe(subNonce); // new nonce, not reused
  });

  it("PREVENTS: subscription nonce cannot bypass payment on protected endpoints when balance is 0", async () => {
    ctx = makeTestContext();
    // Use a facilitator that rejects (simulating no valid signature for subscription nonce)
    const facilitator = makeMockFacilitator({ isValid: false, invalidReason: "signature_invalid" });
    ctx.subscriptionStore = new SubscriptionStore();
    const nonceStore = new NonceStore();
    ctx.paymentService = new PaymentService({ facilitator, nonceStore, subscriptionStore: ctx.subscriptionStore! });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      subscriptionStore: ctx.subscriptionStore!,
      scoreHistoryStore: ctx.scoreHistoryStore!,
      cache: new MarketDataCache(),
    });
    ctx.server = await startServer(app);

    // Generate a nonce that exists in both NonceStore and SubscriptionStore
    const subNonce = nonceStore.generateNonce();
    ctx.subscriptionStore!.createSubscription(subNonce, 1, 86_400);

    // First request: uses last subscription unit
    const payload1 = createPaymentPayload(subNonce);
    const r1 = await fetch(`${ctx.server!.url}/api/v1/market-intelligence/volatility`, {
      headers: { "payment-signature": encodePayload(payload1) },
    });
    expect(r1.status).toBe(200); // served via subscription

    // Second request: subscription exhausted, falls through to payment verification (fails)
    const payload2 = createPaymentPayload(subNonce);
    const r2 = await fetch(`${ctx.server!.url}/api/v1/market-intelligence/volatility`, {
      headers: { "payment-signature": encodePayload(payload2) },
    });
    expect(r2.status).toBe(402); // balance exhausted, payment verification fails (nonce already consumed)
  });
});

describe("M9 Adversarial — Zero-Amount Batch Challenge", () => {
  let ctx: TestContext;

  afterEach(() => cleanupContext(ctx));

  it("REJECTS: empty symbols array before payment (400)", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    const challengeResp = await fetch(`${ctx.server!.url}/api/v1/market-intelligence/volatility/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: [] }),
    });
    expect(challengeResp.status).toBe(400);
    const emptyBody = (await challengeResp.json()) as { error: string };
    expect(emptyBody.error).toMatch(/valid symbols/i);
  });

  it("REJECTS: no symbols field before payment (400)", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    const challengeResp = await fetch(`${ctx.server!.url}/api/v1/market-intelligence/volatility/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(challengeResp.status).toBe(400);
    const missingBody = (await challengeResp.json()) as { error: string };
    expect(missingBody.error).toMatch(/valid symbols/i);
  });
});

describe("M9 Adversarial — Portfolio Risk Input Validation", () => {
  let ctx: TestContext;

  afterEach(() => cleanupContext(ctx));

  it("REJECTS: negative weights return 400 (after payment)", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    const nonce = await get402Nonce(ctx.server!.url, "/api/v1/market-intelligence/portfolio/risk", "POST", {
      symbols: ["BTCUSDT"],
      weights: [1],
    });

    const resp = await payRequest(ctx.server!.url, "/api/v1/market-intelligence/portfolio/risk", nonce, BATCH_AMOUNT, {
      symbols: ["BTCUSDT"],
      weights: [-1],
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("weights must be finite non-negative numbers");
  });

  it("REJECTS: NaN weights return 400", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    const nonce = await get402Nonce(ctx.server!.url, "/api/v1/market-intelligence/portfolio/risk", "POST", {
      symbols: ["BTCUSDT", "ETHUSDT"],
      weights: [1, 1],
    });

    const resp = await payRequest(
      ctx.server!.url,
      "/api/v1/market-intelligence/portfolio/risk",
      nonce,
      (BigInt(BATCH_AMOUNT) * 2n).toString(),
      { symbols: ["BTCUSDT", "ETHUSDT"], weights: [NaN, 1] },
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("weights must be finite non-negative numbers");
  });

  it("REJECTS: all symbols failing returns 503 (not 200 with empty data)", async () => {
    const alwaysFailMcp: McpClientLike = {
      connect: async () => {},
      close: async () => {},
      listTools: async () => ({ tools }),
      callTool: async () => {
        throw new Error("MCP server unreachable");
      },
      setDisconnectHandler: () => {},
    };

    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => alwaysFailMcp,
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    const nonce = await get402Nonce(ctx.server!.url, "/api/v1/market-intelligence/portfolio/risk", "POST", {
      symbols: ["BTCUSDT"],
      weights: [1],
    });

    const resp = await payRequest(ctx.server!.url, "/api/v1/market-intelligence/portfolio/risk", nonce, BATCH_AMOUNT, {
      symbols: ["BTCUSDT"],
      weights: [1],
    });
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("No market data available for any requested symbol");
  });
});

describe("M9 Adversarial — SubscriptionStore", () => {
  it("deducts balance atomically and rejects when exhausted", () => {
    const store = new SubscriptionStore();
    store.createSubscription("0xsub1", 5, 86_400);

    const results = Array.from({ length: 6 }, () => store.deduct("0xsub1"));
    const successCount = results.filter((r) => r.success).length;
    expect(successCount).toBe(5);

    const final = store.deduct("0xsub1");
    expect(final.success).toBe(false);
    expect(final.remaining).toBe(0);
    store.close();
  });

  it("verifyAndDeduct returns invalid when balance is 0", () => {
    const store = new SubscriptionStore();
    store.createSubscription("0xsub1", 1, 86_400);

    const first = store.verifyAndDeduct("0xsub1");
    expect(first.valid).toBe(true);
    expect(first.remaining).toBe(0);

    const second = store.verifyAndDeduct("0xsub1");
    expect(second.valid).toBe(false);
    expect(second.remaining).toBe(0);
    store.close();
  });

  it("does not throw when close() is called twice", () => {
    const store = new SubscriptionStore();
    store.createSubscription("0xsub1", 10, 86_400);

    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });
});

describe("M9 Adversarial — ScoreHistoryStore TTL + Max-Size", () => {
  it("evicts oldest records when maxSize is exceeded", () => {
    const store = new ScoreHistoryStore(":memory:", 3);
    for (let i = 0; i < 5; i++) {
      store.recordScore(
        "BTCUSDT",
        {
          symbol: "BTCUSDT",
          timestamp: i,
          volatility_score: 50,
          momentum_score: 50,
          composite_score: 50,
          open_interest: 0,
          order_book_imbalance: 0,
          realized_volatility_24h: 0.1,
          data_ttl_seconds: 30,
          sources: [],
          data_age_ms: 0,
          confidence_score: 90,
        },
        [],
        90,
        0,
      );
    }
    expect(store.getHistoryCount()).toBe(3);
    const history = store.getHistory("BTCUSDT", 10);
    expect(history).toHaveLength(3);
    // Most recent first
    expect(history[0]!.fetched_at).toBe(4);
    expect(history[2]!.fetched_at).toBe(2);
    store.close();
  });

  it("cleanupExpired removes records older than the cutoff", () => {
    const store = new ScoreHistoryStore(":memory:", 100);
    // Insert old record with old created_at
    const oldTimeSec = Math.floor(Date.now() / 1000) - 86_400;
    store.db
      .prepare(
        "INSERT INTO score_history (symbol, fetched_at, score_json, sources, confidence, data_age_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("BTCUSDT", oldTimeSec, "{}", "[]", 50, 100, oldTimeSec);
    // Insert fresh record
    store.recordScore(
      "ETHUSDT",
      {
        symbol: "ETHUSDT",
        timestamp: Date.now(),
        volatility_score: 50,
        momentum_score: 50,
        composite_score: 50,
        open_interest: 0,
        order_book_imbalance: 0,
        realized_volatility_24h: 0.1,
        data_ttl_seconds: 30,
        sources: [],
        data_age_ms: 0,
        confidence_score: 90,
      },
      [],
      90,
      0,
    );

    expect(store.getHistoryCount()).toBe(2);
    const cutoffSec = Math.floor(Date.now() / 1000) - 86_000;
    const deleted = store.cleanupExpired(cutoffSec);
    expect(deleted).toBe(1);
    expect(store.getHistoryCount()).toBe(1);
    expect(store.getHistory("ETHUSDT", 10)).toHaveLength(1);
    store.close();
  });
});

describe("M9 Adversarial — History Endpoint Error Handling", () => {
  it("skips corrupt score_json records instead of returning 500", () => {
    const store = new ScoreHistoryStore();
    // Insert a corrupt record
    store.db
      .prepare(
        "INSERT INTO score_history (symbol, fetched_at, score_json, sources, confidence, data_age_ms) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("BTCUSDT", Date.now(), "NOT VALID JSON", "[]", 50, 100);

    // Insert a valid record
    store.recordScore(
      "BTCUSDT",
      {
        symbol: "BTCUSDT",
        timestamp: Date.now() + 1,
        volatility_score: 50,
        momentum_score: 50,
        composite_score: 50,
        open_interest: 0,
        order_book_imbalance: 0,
        realized_volatility_24h: 0.1,
        data_ttl_seconds: 30,
        sources: [],
        data_age_ms: 0,
        confidence_score: 90,
      },
      [],
      90,
      0,
    );

    const history = store.getHistory("BTCUSDT", 10);
    expect(history).toHaveLength(2);

    // Parse with try/catch like the route handler does
    const scores = history
      .map((record) => {
        try {
          return JSON.parse(record.score_json);
        } catch {
          return null;
        }
      })
      .filter((s): s is Record<string, unknown> => s !== null);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.symbol).toBe("BTCUSDT");
    store.close();
  });
});

describe("M9 Adversarial — Agent Info Discovery", () => {
  let ctx: TestContext;

  afterEach(() => cleanupContext(ctx));

  it("returns discoverable metadata for all M9 signals and subscription pricing", async () => {
    ctx = makeTestContext();
    ctx.subscriptionStore = new SubscriptionStore();
    ctx.scoreHistoryStore = new ScoreHistoryStore();
    ctx.paymentService = new PaymentService({
      facilitator: makeMockFacilitator(),
      nonceStore: new NonceStore(),
      subscriptionStore: ctx.subscriptionStore,
    });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
      subscriptionStore: ctx.subscriptionStore!,
    });
    ctx.server = await startServer(app);

    const resp = await fetch(`${ctx.server!.url}/api/v1/agent/info`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      name: string;
      signals: Array<{ name: string; endpoint: string; price_atomic: string }>;
      payment: { accepts: string[]; subscription: { price_atomic: string; requests_included: number } };
    };
    expect(body.signals).toHaveLength(4);
    expect(body.signals.map((s) => s.endpoint)).toContain("GET /api/v1/market-intelligence/volatility/history");
    expect(body.signals.map((s) => s.endpoint)).toContain("POST /api/v1/market-intelligence/volatility/batch");
    expect(body.signals.map((s) => s.endpoint)).toContain("POST /api/v1/market-intelligence/portfolio/risk");
    expect(body.payment.accepts).toEqual(["USDT", "USDC"]);
    expect(body.payment.subscription.price_atomic).toBe(B402_CONFIG.pricing.subscriptionAtomic);
    expect(body.payment.subscription.requests_included).toBe(B402_CONFIG.pricing.subscriptionRequests);
  });
});

describe("M9 Phase 2 — Batch/Price DoS Prevention", () => {
  let ctx: TestContext;

  afterEach(() => cleanupContext(ctx));

  it("caps batch price at MAX_BATCH_SYMBOLS (100) even with 200 symbols", async () => {
    ctx = makeTestContext();
    ctx.subscriptionStore = new SubscriptionStore();
    const nonceStore = new NonceStore();
    ctx.paymentService = new PaymentService({
      facilitator: makeMockFacilitator(),
      nonceStore,
      subscriptionStore: ctx.subscriptionStore!,
    });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      subscriptionStore: ctx.subscriptionStore!,
      scoreHistoryStore: ctx.scoreHistoryStore!,
      cache: new MarketDataCache(),
    });
    ctx.server = await startServer(app);

    const manySymbols = Array.from({ length: 200 }, (_, i) => `SYM${i.toString().padStart(3, "0")}USDT`);
    const challengeResp = await fetch(`${ctx.server!.url}/api/v1/market-intelligence/volatility/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: manySymbols }),
    });
    expect(challengeResp.status).toBe(402);
    const pr = decodeHeader(challengeResp.headers.get("payment-required")) as {
      accepts: Array<{ amount: string }>;
    };
    const expected = (BigInt(100) * BigInt(BATCH_AMOUNT)).toString();
    expect(pr.accepts[0]!.amount).toBe(expected);
  });

  it("caps portfolio risk price at MAX_BATCH_SYMBOLS (100) even with 200 symbols", async () => {
    ctx = makeTestContext();
    ctx.subscriptionStore = new SubscriptionStore();
    const nonceStore = new NonceStore();
    ctx.paymentService = new PaymentService({
      facilitator: makeMockFacilitator(),
      nonceStore,
      subscriptionStore: ctx.subscriptionStore!,
    });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      subscriptionStore: ctx.subscriptionStore!,
      scoreHistoryStore: ctx.scoreHistoryStore!,
      cache: new MarketDataCache(),
    });
    ctx.server = await startServer(app);

    const manySymbols = Array.from({ length: 200 }, (_, i) => `SYM${i.toString().padStart(3, "0")}USDT`);
    const manyWeights = Array.from({ length: 200 }, () => 1);
    const challengeResp = await fetch(`${ctx.server!.url}/api/v1/market-intelligence/portfolio/risk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: manySymbols, weights: manyWeights }),
    });
    expect(challengeResp.status).toBe(402);
    const pr = decodeHeader(challengeResp.headers.get("payment-required")) as {
      accepts: Array<{ amount: string }>;
    };
    const expected = (BigInt(100) * BigInt(BATCH_AMOUNT)).toString();
    expect(pr.accepts[0]!.amount).toBe(expected);
  });

  it("batch handler returns 400 when all symbols are non-strings", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    const resp = await fetch(`${ctx.server!.url}/api/v1/market-intelligence/volatility/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: [1, 2, 3] }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("No valid symbols provided");
  });

  it("portfolio handler returns 400 for non-string symbols instead of 500", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    const nonce = await get402Nonce(ctx.server!.url, "/api/v1/market-intelligence/portfolio/risk", "POST", {
      symbols: ["BTCUSDT", "ETHUSDT"],
      weights: [1, 1],
    });

    const resp = await payRequest(
      ctx.server!.url,
      "/api/v1/market-intelligence/portfolio/risk",
      nonce,
      (BigInt(BATCH_AMOUNT) * 2n).toString(),
      { symbols: ["BTCUSDT", 123], weights: [1, 1] },
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("All symbols must be strings");
  });

  it("does not return 500 when scoreHistoryStore.recordScore throws", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();
    vi.spyOn(ctx.scoreHistoryStore, "recordScore").mockImplementation(() => {
      throw new Error("DB locked");
    });

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    const nonce = await get402Nonce(ctx.server!.url, "/api/v1/market-intelligence/volatility?symbol=BTCUSDT");
    const resp = await payRequest(ctx.server!.url, "/api/v1/market-intelligence/volatility?symbol=BTCUSDT", nonce);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { composite_score: number };
    expect(typeof body.composite_score).toBe("number");
  });

  it("deduplicates symbols in batch requests (MCP calls match unique symbols, not raw input)", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const fakeMcp = new FakeMcpClient(tools, makeSnapshotResponses());
    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => fakeMcp,
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    // Send ["BTCUSDT", "btcusdt", "ETHUSDT"] = 3 raw, 2 unique after dedup
    const nonce = await get402Nonce(ctx.server!.url, "/api/v1/market-intelligence/volatility/batch", "POST", {
      symbols: ["BTCUSDT", "btcusdt", "ETHUSDT"],
    });
    // Price is computed on validated unique symbols (2)
    const batchAmount = (BigInt(B402_CONFIG.pricing.batchPerSymbolAtomic) * BigInt(2)).toString();
    const resp = await payRequest(ctx.server!.url, "/api/v1/market-intelligence/volatility/batch", nonce, batchAmount, {
      symbols: ["BTCUSDT", "btcusdt", "ETHUSDT"],
    });
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as { count: number; scores: Array<{ symbol: string }> };
    // Only 2 unique symbols, so only 2 scores returned
    expect(body.count).toBe(2);
    expect(body.scores).toHaveLength(2);

    // Each symbol fetches 3 MCP tools (ticker, klines, order_book), so 2 unique symbols = 6 MCP calls
    // Without dedup, 3 raw symbols = 9 MCP calls
    expect(fakeMcp.callCount).toBe(6);
  });

  it("portfolio handler deduplicates symbols and merges weights", async () => {
    ctx = makeTestContext();
    const facilitator = makeMockFacilitator();
    ctx.paymentService = new PaymentService({ facilitator });
    ctx.rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    ctx.scoreHistoryStore = new ScoreHistoryStore();

    const fakeMcp = new FakeMcpClient(tools, makeSnapshotResponses());
    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => fakeMcp,
        requestTimeoutMs: 100,
      }),
      paymentService: ctx.paymentService!,
      rateLimiter: ctx.rateLimiter!,
      cache: new MarketDataCache(),
      scoreHistoryStore: ctx.scoreHistoryStore!,
    });
    ctx.server = await startServer(app);

    // Duplicate "BTCUSDT" with weights [0.3, 0.5] → merged weight 0.8
    const nonce = await get402Nonce(ctx.server!.url, "/api/v1/market-intelligence/portfolio/risk", "POST", {
      symbols: ["BTCUSDT", "btcusdt"],
      weights: [0.3, 0.5],
    });
    const amount = (BigInt(B402_CONFIG.pricing.batchPerSymbolAtomic) * BigInt(1)).toString();
    const resp = await payRequest(ctx.server!.url, "/api/v1/market-intelligence/portfolio/risk", nonce, amount, {
      symbols: ["BTCUSDT", "btcusdt"],
      weights: [0.3, 0.5],
    });
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as { symbols: string[]; portfolio: { composite_score: number } };
    // Only 1 unique symbol after dedup
    expect(body.symbols).toHaveLength(1);
    expect(body.symbols).toContain("BTCUSDT");
    // Only 3 MCP calls (1 symbol × 3 tools)
    expect(fakeMcp.callCount).toBe(3);
  });
});

describe("M9 Phase 2 — Store Close Safety", () => {
  it("NonceStore does not throw on double close", () => {
    const store = new NonceStore();
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it("RateLimitStore does not throw on double close", () => {
    const store = new RateLimitStore({ config: { maxRequests: 10, windowSeconds: 60 } });
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it("TreasuryStore does not throw on double close", () => {
    const store = new TreasuryStore();
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });
});
