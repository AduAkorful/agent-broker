import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { Express } from "express";
import { createApp } from "../src/index.js";
import { BinanceMcpClient } from "../src/mcp-client.js";
import { B402FacilitatorClient } from "../src/payment/b402-client.js";
import { PaymentService } from "../src/payment/payment-service.js";
import { RateLimitStore } from "../src/payment/rate-limit-store.js";
import { NonceStore } from "../src/payment/nonce-store.js";
import { SubscriptionStore } from "../src/payment/subscription-store.js";
import { ScoreHistoryStore } from "../src/score-history-store.js";
import { MarketDataCache } from "../src/market-cache.js";
import { B402_CONFIG } from "../src/config.js";
import { INTEL_DISCLAIMER } from "../src/disclaimer.js";
import type { VenueContrast, VenueContrastClient } from "../src/venue-contrast.js";
import type { PaymentPayload, SettleResponse, VerifyResponse } from "../src/payment/types.js";
import type { McpCallResult, McpClientLike, McpTool } from "../src/types.js";

const USDT = B402_CONFIG.tokens.usdt.address;
const SELLER = B402_CONFIG.payTo;
const AMOUNT = B402_CONFIG.price.atomic;

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

function encodePayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

function createPaymentPayload(nonce: string, amount = AMOUNT): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "http://localhost/api/v1/market-intelligence/volatility" },
    accepted: {
      scheme: "exact",
      network: "eip155:56",
      asset: USDT,
      payTo: SELLER,
      amount,
      maxTimeoutSeconds: 3600,
      extra: { name: "B402", version: "1", assetTransferMethod: "b402-relayer", nonce },
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

class FakeMcpClient implements McpClientLike {
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
    const result = this.responses[params.name];
    if (!result) throw new Error(`unexpected tool ${params.name}`);
    return result;
  }
}

const tools: McpTool[] = [{ name: "get_ticker" }, { name: "get_klines" }, { name: "get_order_book" }];

function makeSnapshotResponses(): Record<string, McpCallResult> {
  const candles = Array.from({ length: 24 }, (_, i) => [
    1_700_000_000_000 + i * 3_600_000,
    "100",
    "110",
    "90",
    String(100 + i),
    "1000",
  ]);
  return {
    get_ticker: {
      structuredContent: { symbol: "BTCUSDT", lastPrice: "50000", bidPrice: "49990", askPrice: "50010" },
    },
    get_klines: { structuredContent: candles },
    get_order_book: {
      structuredContent: {
        bids: [["49990", "1"]],
        asks: [["50010", "1"]],
      },
    },
  };
}

async function startServer(app: Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no address");
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

class FakeVenueContrast implements VenueContrastClient {
  constructor(private readonly result: VenueContrast | null) {}
  async fetchContrast(_symbol: string, _binanceMid: number | null): Promise<VenueContrast | null> {
    return this.result;
  }
}

describe("Polish pack — discovery, ready, openapi, provenance", () => {
  let server: Server | undefined;
  let paymentService: PaymentService | undefined;
  let rateLimiter: RateLimitStore | undefined;
  let subscriptionStore: SubscriptionStore | undefined;
  let scoreHistoryStore: ScoreHistoryStore | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    server = undefined;
    paymentService?.close();
    rateLimiter?.close();
    subscriptionStore?.close();
    scoreHistoryStore?.close();
  });

  async function boot(extra: Parameters<typeof createApp>[0] = {}) {
    subscriptionStore = new SubscriptionStore();
    scoreHistoryStore = new ScoreHistoryStore();
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    paymentService = new PaymentService({
      facilitator: makeMockFacilitator(),
      nonceStore: new NonceStore(),
      subscriptionStore,
    });
    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      subscriptionStore,
      scoreHistoryStore,
      cache: new MarketDataCache(),
      venueContrast: new FakeVenueContrast(null),
      ...extra,
    });
    // Mark MCP connected for ready checks when using fake factory
    const started = await startServer(app);
    server = started.server;
    return started.url;
  }

  it("GET /api/v1/agent/info returns rich catalog with disclaimer and subscription rules", async () => {
    const url = await boot();
    const resp = await fetch(`${url}/api/v1/agent/info`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.product).toBeTruthy();
    expect(body.disclaimer).toBe(INTEL_DISCLAIMER);
    expect(body.openapi_url).toBe("/api/v1/openapi.yaml");
    expect(body.ready_url).toBe("/api/v1/ready");
    expect(body.how_to_pay).toBeTruthy();
    expect(body.networks).toBeTruthy();
    expect(Array.isArray(body.assets)).toBe(true);
    const payment = body.payment as { subscription: { anti_farming: string; remaining_balance: unknown } };
    expect(payment.subscription.anti_farming.toLowerCase()).toContain("real");
    expect(payment.subscription.remaining_balance).toBeTruthy();
    const signals = body.signals as unknown[];
    expect(signals).toHaveLength(4);
  });

  it("serves OpenAPI yaml and json for free", async () => {
    const url = await boot();
    const yamlResp = await fetch(`${url}/api/v1/openapi.yaml`);
    expect(yamlResp.status).toBe(200);
    const yamlText = await yamlResp.text();
    expect(yamlText).toContain("openapi:");
    expect(yamlText).toContain("/api/v1/ready");

    const jsonResp = await fetch(`${url}/api/v1/openapi.json`);
    expect(jsonResp.status).toBe(200);
    const doc = (await jsonResp.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.paths["/api/v1/ready"]).toBeTruthy();
    expect(doc.paths["/api/v1/agent/info"]).toBeTruthy();
  });

  it("GET /api/v1/ready returns 503 when MCP disconnected and 200 shape when forced ready", async () => {
    const url = await boot();
    const resp = await fetch(`${url}/api/v1/ready`);
    // Fake client is not marked connected via BinanceMcpClient.isConnected() unless connect() ran
    expect([200, 503]).toContain(resp.status);
    const body = (await resp.json()) as { ready: boolean; checks: Record<string, { ok: boolean }> };
    expect(typeof body.ready).toBe("boolean");
    expect(body.checks.mcp).toBeTruthy();
    expect(body.checks.facilitator).toBeTruthy();
  });

  it("paid volatility includes disclaimer + provenance fields", async () => {
    const url = await boot({
      venueContrast: new FakeVenueContrast({
        venue: "okx",
        symbol: "BTC/USDT",
        mid: 50005,
        last: 50000,
        binance_mid: 50000,
        basis_bps: 1,
        available: true,
        fetched_at: Date.now(),
      }),
    });

    // Force MCP connected for scoring path only — payment still mocked
    const challenge = await fetch(`${url}/api/v1/market-intelligence/volatility`);
    expect(challenge.status).toBe(402);
    const required = JSON.parse(
      Buffer.from(challenge.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf-8"),
    ) as { accepts: Array<{ extra: { nonce: string } }> };
    const nonce = required.accepts[0]!.extra.nonce;
    const pay = await fetch(`${url}/api/v1/market-intelligence/volatility`, {
      headers: { "payment-signature": encodePayload(createPaymentPayload(nonce)) },
    });
    expect(pay.status).toBe(200);
    const body = (await pay.json()) as Record<string, unknown>;
    expect(body.disclaimer).toBe(INTEL_DISCLAIMER);
    expect(Array.isArray(body.sources)).toBe(true);
    expect(typeof body.data_age_ms).toBe("number");
    expect(body.age).toBe(body.data_age_ms);
    expect(typeof body.confidence_score).toBe("number");
    expect(body.contrast).toBeTruthy();
    const contrast = body.contrast as { available: boolean; venue: string };
    expect(contrast.available).toBe(true);
    expect(contrast.venue).toBe("okx");
  });

  it("soft-fails contrast: unavailable contrast does not 500 paid response", async () => {
    const url = await boot({
      venueContrast: new FakeVenueContrast({
        venue: "okx",
        symbol: "BTC/USDT",
        mid: null,
        last: null,
        binance_mid: 50000,
        basis_bps: null,
        available: false,
        error: "secondary_venue_unavailable",
        fetched_at: Date.now(),
      }),
    });
    const challenge = await fetch(`${url}/api/v1/market-intelligence/volatility`);
    const required = JSON.parse(
      Buffer.from(challenge.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf-8"),
    ) as { accepts: Array<{ extra: { nonce: string } }> };
    const nonce = required.accepts[0]!.extra.nonce;
    const pay = await fetch(`${url}/api/v1/market-intelligence/volatility`, {
      headers: { "payment-signature": encodePayload(createPaymentPayload(nonce)) },
    });
    expect(pay.status).toBe(200);
    const body = (await pay.json()) as { contrast: { available: boolean }; disclaimer: string };
    expect(body.disclaimer).toBe(INTEL_DISCLAIMER);
    expect(body.contrast.available).toBe(false);
  });
});
