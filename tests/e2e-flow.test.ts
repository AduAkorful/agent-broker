import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { Express } from "express";
import { createApp, safeApiKeyCompare } from "../src/index.js";
import { BinanceMcpClient } from "../src/mcp-client.js";
import { B402FacilitatorClient } from "../src/payment/b402-client.js";
import { PaymentService } from "../src/payment/payment-service.js";
import { RateLimitStore } from "../src/payment/rate-limit-store.js";
import { TreasuryService } from "../src/payment/treasury-service.js";
import { MarketDataCache } from "../src/market-cache.js";
import { B402_CONFIG } from "../src/config.js";
import { logger } from "../src/logger.js";
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

function decodeHeader(headerValue: string | null): unknown {
  if (!headerValue) return null;
  return JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
}

function encodePayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

function createPaymentPayload(nonce: string): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "http://localhost/api/v1/market-intelligence/volatility" },
    accepted: {
      scheme: "exact",
      network: "eip155:56",
      asset: USDT,
      payTo: SELLER,
      amount: AMOUNT,
      maxTimeoutSeconds: 3600,
      extra: { name: "B402", version: "1", assetTransferMethod: "b402-relayer", nonce },
    },
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0x1234567890123456789012345678901234567890",
        to: SELLER,
        value: AMOUNT,
        validAfter: "1",
        validBefore: "9999999999",
        nonce,
      },
    },
  };
}

class FakeMcpClient implements McpClientLike {
  readonly calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  private callCount = 0;

  constructor(
    private readonly tools: McpTool[],
    private readonly responses: Record<string, McpCallResult>,
    private readonly shouldFailAfter = 0,
  ) {}

  async connect() {}
  async close() {}
  async listTools() {
    return { tools: this.tools };
  }
  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    this.callCount++;
    if (this.shouldFailAfter > 0 && this.callCount > this.shouldFailAfter) {
      throw new Error("MCP connection failed");
    }
    this.calls.push(params);
    return this.responses[params.name] ?? { isError: true };
  }
  setDisconnectHandler?(_handler: () => void): void {}
}

class AlwaysFailMcpClient implements McpClientLike {
  async connect() {}
  async close() {}
  async listTools(): Promise<{ tools: McpTool[] }> {
    throw new Error("MCP server unreachable");
  }
  async callTool(): Promise<McpCallResult> {
    throw new Error("MCP server unreachable");
  }
  setDisconnectHandler?(_handler: () => void): void {}
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

describe("End-to-End Payment + Market Data Flow", () => {
  let server: { url: string; close: () => Promise<void> };
  let paymentService: PaymentService;
  let rateLimiter: RateLimitStore;
  let treasuryService: TreasuryService;
  let cache: MarketDataCache;

  afterEach(async () => {
    paymentService?.close();
    rateLimiter?.close();
    treasuryService?.close();
    if (server) await server.close();
  });

  async function get402Challenge(path = "/api/v1/market-intelligence/volatility"): Promise<string> {
    const response = await fetch(`${server.url}${path}`);
    expect(response.status).toBe(402);
    const header = response.headers.get("payment-required");
    expect(header).toBeTruthy();
    const parsed = decodeHeader(header) as { accepts: Array<{ extra: { nonce: string } }> };
    return parsed.accepts[0]!.extra.nonce;
  }

  async function payRequest(nonce: string, path = "/api/v1/market-intelligence/volatility"): Promise<Response> {
    const payload = createPaymentPayload(nonce);
    return fetch(`${server.url}${path}`, { headers: { "payment-signature": encodePayload(payload) } });
  }

  it("serves market data (CVMS score) after successful payment", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();
    cache = new MarketDataCache();

    const fakeMcp = new FakeMcpClient(tools, makeSnapshotResponses());
    const mcpClient = new BinanceMcpClient({ clientFactory: () => fakeMcp, requestTimeoutMs: 100 });

    const app = createApp({ client: mcpClient, paymentService, rateLimiter, treasuryService, cache });
    server = await startServer(app);

    const nonce = await get402Challenge();
    const response = await payRequest(nonce);

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();

    const body = (await response.json()) as { symbol: string; composite_score: number };
    expect(body.symbol).toBe("BTCUSDT");
    expect(body.composite_score).toBeGreaterThanOrEqual(0);
    expect(body.composite_score).toBeLessThanOrEqual(100);
  });

  it("serves stale cached data when MCP fails after a successful payment", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();
    cache = new MarketDataCache();

    const fakeMcp = new FakeMcpClient(tools, makeSnapshotResponses(), 3);
    const mcpClient = new BinanceMcpClient({ clientFactory: () => fakeMcp, requestTimeoutMs: 100 });

    const app = createApp({ client: mcpClient, paymentService, rateLimiter, treasuryService, cache });
    server = await startServer(app);

    // First request: pays and succeeds, caches the snapshot
    const nonce1 = await get402Challenge();
    const r1 = await payRequest(nonce1);
    expect(r1.status).toBe(200);

    // Second request: pays, but MCP now fails — should serve cached data with stale flag
    const nonce2 = await get402Challenge();
    const r2 = await payRequest(nonce2);
    expect(r2.status).toBe(200);

    const body = (await r2.json()) as { stale: boolean; composite_score: number };
    expect(body.stale).toBe(true);
    expect(body.composite_score).toBeGreaterThanOrEqual(0);
  });

  it("returns 503 when MCP fails and no cached data exists", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();
    cache = new MarketDataCache();

    const alwaysFailMcp = new AlwaysFailMcpClient();
    const mcpClient = new BinanceMcpClient({ clientFactory: () => alwaysFailMcp, requestTimeoutMs: 100 });

    const app = createApp({ client: mcpClient, paymentService, rateLimiter, treasuryService, cache });
    server = await startServer(app);

    const nonce = await get402Challenge();
    const response = await payRequest(nonce);

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  it("returns 429 when rate limit is exceeded before payment challenge", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 60 } });
    treasuryService = new TreasuryService();
    cache = new MarketDataCache();

    const fakeMcp = new FakeMcpClient(tools, makeSnapshotResponses());
    const mcpClient = new BinanceMcpClient({ clientFactory: () => fakeMcp, requestTimeoutMs: 100 });

    const app = createApp({ client: mcpClient, paymentService, rateLimiter, treasuryService, cache });
    server = await startServer(app);

    // First request gets a 402 (counted against rate limit)
    expect((await fetch(`${server.url}/api/v1/market-intelligence/volatility`)).status).toBe(402);
    // Second request is rate-limited
    expect((await fetch(`${server.url}/api/v1/market-intelligence/volatility`)).status).toBe(429);
  });

  it("does not call the facilitator when payment signature is missing", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();
    cache = new MarketDataCache();

    const fakeMcp = new FakeMcpClient(tools, makeSnapshotResponses());
    const mcpClient = new BinanceMcpClient({ clientFactory: () => fakeMcp, requestTimeoutMs: 100 });

    const app = createApp({ client: mcpClient, paymentService, rateLimiter, treasuryService, cache });
    server = await startServer(app);

    const response = await fetch(`${server.url}/api/v1/market-intelligence/volatility`);
    expect(response.status).toBe(402);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("returns 503 on treasury endpoints when adminApiKey is not configured", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();
    cache = new MarketDataCache();

    const fakeMcp = new FakeMcpClient(tools, makeSnapshotResponses());
    const mcpClient = new BinanceMcpClient({ clientFactory: () => fakeMcp, requestTimeoutMs: 100 });

    // No adminApiKey option provided — should fail closed
    const app = createApp({ client: mcpClient, paymentService, rateLimiter, treasuryService, cache });
    server = await startServer(app);

    const withdrawResponse = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": "changeme", "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "100", token: "0xabc", destination: "0xdef" }),
    });
    expect(withdrawResponse.status).toBe(503);

    const balanceResponse = await fetch(`${server.url}/api/v1/treasury/balance`, {
      headers: { "x-api-key": "changeme" },
    });
    expect(balanceResponse.status).toBe(503);
  });
});

describe("Production Hardening — Error Handling (P0.1)", () => {
  let server: { url: string; close: () => Promise<void> };
  let paymentService: PaymentService;
  let rateLimiter: RateLimitStore;
  let treasuryService: TreasuryService;

  afterEach(async () => {
    paymentService?.close();
    rateLimiter?.close();
    treasuryService?.close();
    if (server) await server.close();
  });

  it("returns JSON 500 (not HTML) on unhandled async errors in route handlers", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();
    vi.spyOn(treasuryService, "checkWithdrawal").mockImplementation(() => {
      throw new Error("Unexpected treasury failure");
    });

    const fakeMcp = new FakeMcpClient(tools, makeSnapshotResponses());
    const mcpClient = new BinanceMcpClient({ clientFactory: () => fakeMcp, requestTimeoutMs: 100 });

    const app = createApp({
      client: mcpClient,
      paymentService,
      rateLimiter,
      treasuryService,
      cache: new MarketDataCache(),
      adminApiKey: "test-key",
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": "test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: "100",
        token: B402_CONFIG.tokens.usdt.address,
        destination: "0x0000000000000000000000000000000000000001",
      }),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Internal server error");

    errorSpy.mockRestore();
  });

  it("returns 400 for malformed JSON body", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      treasuryService,
      cache: new MarketDataCache(),
      adminApiKey: "test-key",
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": "test-key", "Content-Type": "application/json" },
      body: "{ invalid json !!!",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Malformed JSON in request body");

    errorSpy.mockRestore();
  });

  it("returns 413 for request body exceeding size limit", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      treasuryService,
      cache: new MarketDataCache(),
      adminApiKey: "test-key",
    });
    server = await startServer(app);

    const hugeBody = JSON.stringify({ data: "x".repeat(20000) });
    const response = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": "test-key", "Content-Type": "application/json" },
      body: hugeBody,
    });

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("request entity too large");

    errorSpy.mockRestore();
  });
});

describe("Production Hardening — P1 Security & Observability", () => {
  let server: { url: string; close: () => Promise<void> };
  let paymentService: PaymentService;
  let rateLimiter: RateLimitStore;
  let treasuryService: TreasuryService;

  afterEach(async () => {
    paymentService?.close();
    rateLimiter?.close();
    treasuryService?.close();
    if (server) await server.close();
  });

  async function makeApp(extra: Parameters<typeof createApp>[0] = {}) {
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();
    const client = new BinanceMcpClient({
      clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
      requestTimeoutMs: 100,
    });
    await client.connect();
    return createApp({
      client,
      paymentService,
      rateLimiter,
      treasuryService,
      cache: new MarketDataCache(),
      ...extra,
    });
  }

  it("P1.1: sets security headers on all responses", async () => {
    const app = await makeApp();
    server = await startServer(app);

    const response = await fetch(`${server.url}/health`);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
  });

  it("P1.4: health endpoint returns only { ok: true } (no service field)", async () => {
    const app = await makeApp();
    server = await startServer(app);

    const response = await fetch(`${server.url}/health`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBeUndefined();
  });

  it("P2.6: returns 503 with dependency checks when MCP client is not connected", async () => {
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      cache: new MarketDataCache(),
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; checks: Array<{ name: string; status: string }> };
    expect(body.ok).toBe(false);
    expect(body.checks).toContainEqual(expect.objectContaining({ name: "mcp", status: "fail" }));
  });

  it("P1.2: rate-limits by X-Forwarded-For when trustProxy is enabled", async () => {
    rateLimiter = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 60 } });
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    const app = await makeApp({ rateLimiter, paymentService, trustProxy: true });
    server = await startServer(app);

    // First request from IP 1.2.3.4 → 402 (first request, rate limit OK)
    const r1 = await fetch(`${server.url}/api/v1/market-intelligence/volatility`, {
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });
    expect(r1.status).toBe(402);

    // Second request from different X-Forwarded-For → 402 (different IP, not rate limited)
    const r2 = await fetch(`${server.url}/api/v1/market-intelligence/volatility`, {
      headers: { "X-Forwarded-For": "5.6.7.8" },
    });
    expect(r2.status).toBe(402);

    // Third request from same X-Forwarded-For as first → 429 (rate limited)
    const r3 = await fetch(`${server.url}/api/v1/market-intelligence/volatility`, {
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });
    expect(r3.status).toBe(429);
  });

  it("P1.2: ignores X-Forwarded-For when trustProxy is disabled", async () => {
    rateLimiter = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 60 } });
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    const app = await makeApp({ rateLimiter, paymentService, trustProxy: false });
    server = await startServer(app);

    // First request → 402
    const r1 = await fetch(`${server.url}/api/v1/market-intelligence/volatility`, {
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });
    expect(r1.status).toBe(402);

    // Second request with different X-Forwarded-For → 429 (same actual IP, X-Forwarded-For ignored)
    const r2 = await fetch(`${server.url}/api/v1/market-intelligence/volatility`, {
      headers: { "X-Forwarded-For": "5.6.7.8" },
    });
    expect(r2.status).toBe(429);
  });

  it("P1.3: logs request method, URL, status code, and response time", async () => {
    const logSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    const app = await makeApp();
    server = await startServer(app);

    await fetch(`${server.url}/health`);

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^GET \/health 200 \d+ms$/));

    logSpy.mockRestore();
  });

  it("P1.6: rate-limits admin treasury endpoints", async () => {
    const rateLimitStore = new RateLimitStore({ config: { maxRequests: 2, windowSeconds: 60 } });
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    const app = await makeApp({
      rateLimiter: rateLimitStore,
      paymentService,
      adminApiKey: "test-key",
    });
    server = await startServer(app);

    // First two requests: 200
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${server.url}/api/v1/treasury/balance`, {
        headers: { "x-api-key": "test-key" },
      });
      expect(res.status).toBe(200);
    }

    // Third request: 429
    const res3 = await fetch(`${server.url}/api/v1/treasury/balance`, {
      headers: { "x-api-key": "test-key" },
    });
    expect(res3.status).toBe(429);
  });

  it("P1.6: logs audit trail for treasury withdrawals", async () => {
    const logSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    treasuryService = new TreasuryService();

    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      treasuryService,
      cache: new MarketDataCache(),
      adminApiKey: "test-key",
    });
    server = await startServer(app);

    const res = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": "test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: "100",
        token: B402_CONFIG.tokens.usdt.address,
        destination: "0x0000000000000000000000000000000000000001",
      }),
    });

    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Treasury withdrawal recorded/));
  });
});

describe("Production Hardening — P1.5 Config Env Overrides", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("B402_CONFIG supports env var overrides for facilitator URL, price, and rate limits", async () => {
    process.env.B402_FACILITATOR_URL = "https://custom.facilitator.example";
    process.env.B402_PRICE_ATOMIC = "999";
    process.env.B402_RATE_LIMIT_MAX = "42";
    process.env.B402_RATE_LIMIT_WINDOW = "120";

    vi.resetModules();
    const { B402_CONFIG } = await import("../src/config.js");

    expect(B402_CONFIG.facilitatorUrl).toBe("https://custom.facilitator.example");
    expect(B402_CONFIG.price.atomic).toBe("999");
    expect(B402_CONFIG.rateLimit.maxRequests).toBe(42);
    expect(B402_CONFIG.rateLimit.windowSeconds).toBe(120);
  });

  it("B402_CONFIG falls back to defaults when env vars are not set", async () => {
    delete process.env.B402_FACILITATOR_URL;
    delete process.env.B402_PRICE_ATOMIC;
    delete process.env.B402_RATE_LIMIT_MAX;
    delete process.env.B402_RATE_LIMIT_WINDOW;

    vi.resetModules();
    const { B402_CONFIG } = await import("../src/config.js");

    expect(B402_CONFIG.facilitatorUrl).toBe("https://facilitatorv3.b402.ai");
    expect(B402_CONFIG.price.atomic).toBe("50000000000000000");
    expect(B402_CONFIG.rateLimit.maxRequests).toBe(10);
    expect(B402_CONFIG.rateLimit.windowSeconds).toBe(60);
  });
});

describe("CORS and Security Headers", () => {
  let server: { url: string; close: () => Promise<void> };
  let paymentService: PaymentService;
  let rateLimiter: RateLimitStore;

  afterEach(async () => {
    paymentService?.close();
    rateLimiter?.close();
    if (server) await server.close();
  });

  it("sets CORS headers when origin matches allowlist", async () => {
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      cache: new MarketDataCache(),
      corsOrigins: ["https://example.com"],
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/health`, { headers: { origin: "https://example.com" } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, payment-signature, x-api-key");
  });

  it("does not set CORS headers when origin is not in allowlist", async () => {
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      cache: new MarketDataCache(),
      corsOrigins: ["https://example.com"],
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/health`, { headers: { origin: "https://evil.com" } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not set CORS headers when corsOrigins is not configured", async () => {
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      cache: new MarketDataCache(),
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/health`, { headers: { origin: "https://example.com" } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("responds 204 to OPTIONS preflight when CORS is configured", async () => {
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    const app = createApp({
      client: new BinanceMcpClient({
        clientFactory: () => new FakeMcpClient(tools, makeSnapshotResponses()),
        requestTimeoutMs: 100,
      }),
      paymentService,
      rateLimiter,
      cache: new MarketDataCache(),
      corsOrigins: ["https://example.com"],
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/health`, {
      method: "OPTIONS",
      headers: { origin: "https://example.com" },
    });
    expect(response.status).toBe(204);
  });
});

describe("safeApiKeyCompare", () => {
  it("returns true for matching keys", () => {
    expect(safeApiKeyCompare("secret-key", "secret-key")).toBe(true);
  });

  it("returns false for non-matching keys", () => {
    expect(safeApiKeyCompare("secret-key", "different-key")).toBe(false);
  });

  it("returns false when both keys are undefined", () => {
    expect(safeApiKeyCompare(undefined, undefined)).toBe(false);
  });

  it("returns false when one key is undefined", () => {
    expect(safeApiKeyCompare("secret-key", undefined)).toBe(false);
    expect(safeApiKeyCompare(undefined, "secret-key")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(safeApiKeyCompare("", "secret-key")).toBe(false);
    expect(safeApiKeyCompare("", "")).toBe(false);
  });

  it("returns false for different-length keys", () => {
    expect(safeApiKeyCompare("short", "a-much-longer-key")).toBe(false);
  });
});

describe("Swagger UI", () => {
  let server: { url: string; close: () => Promise<void> };
  let paymentService: PaymentService;
  let rateLimiter: RateLimitStore;

  afterEach(async () => {
    paymentService?.close();
    rateLimiter?.close();
    if (server) await server.close();
  });

  it("GET /docs returns 200 HTML (Swagger UI)", async () => {
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    const app = createApp({ paymentService, rateLimiter, cache: new MarketDataCache() });
    server = await startServer(app);

    const response = await fetch(`${server.url}/docs`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("swagger-ui");
    expect(html).toContain("<title>Agent Broker API</title>");
  });

  it("agent/info includes docs_url", async () => {
    paymentService = new PaymentService({ facilitator: makeMockFacilitator() });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 100, windowSeconds: 60 } });
    const app = createApp({ paymentService, rateLimiter, cache: new MarketDataCache() });
    server = await startServer(app);

    const response = await fetch(`${server.url}/api/v1/agent/info`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { docs_url?: string };
    expect(body.docs_url).toBe("/docs");
  });
});
