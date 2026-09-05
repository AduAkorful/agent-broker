import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express, { type Express } from "express";
import { B402_CONFIG, type TreasuryConfig } from "../src/config.js";
import { TreasuryService } from "../src/payment/treasury-service.js";
import { TreasuryStore } from "../src/payment/treasury-store.js";

const USDT = B402_CONFIG.tokens.usdt.address;
const COLD_WALLET = B402_CONFIG.treasury.withdrawalWhitelist[0]!;
const ADMIN_API_KEY = "test-secret-key";
const UNKNOWN_TOKEN = "0x0000000000000000000000000000000000000002";
const UNAUTHORIZED_DEST = "0x0000000000000000000000000000000000000003";

function createTreasuryApp(treasuryConfig: TreasuryConfig, store: TreasuryStore): Express {
  const treasuryService = new TreasuryService({ store, config: { ...B402_CONFIG, treasury: treasuryConfig } });
  const app = express();
  app.use(express.json());

  app.post("/api/v1/treasury/withdraw", async (_request, response) => {
    const apiKey = _request.get("x-api-key");
    if (apiKey !== ADMIN_API_KEY) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { amount, token, destination, signature } = _request.body as {
      amount?: string;
      token?: string;
      destination?: string;
      signature?: string;
    };
    if (!amount || !token || !destination) {
      response.status(400).json({ error: "Missing required fields: amount, token, destination" });
      return;
    }

    const check = treasuryService.checkWithdrawal(amount, token, destination);
    if (!check.allowed) {
      response.status(403).json({ error: "Withdrawal rejected", reason: check.reason, message: check.message });
      return;
    }

    treasuryService.recordWithdrawal(amount, token, destination, signature);

    response.json({
      status: "pending",
      amount,
      token,
      destination,
      daily_spent: treasuryService.getDailySpent(token).toString(),
    });
  });

  app.get("/api/v1/treasury/balance", (_request, response) => {
    const apiKey = _request.get("x-api-key");
    if (apiKey !== ADMIN_API_KEY) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const withdrawals = treasuryService.getAllWithdrawals();
    response.json({
      active: treasuryConfig.active,
      daily_limit_atomic: treasuryConfig.dailyLimitAtomic,
      single_limit_atomic: treasuryConfig.singleLimitAtomic,
      total_withdrawals: withdrawals.length,
    });
  });

  return app;
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://localhost:${port}`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

describe("Treasury API Integration", () => {
  let server: { url: string; close: () => Promise<void> };
  let store: TreasuryStore;

  afterEach(async () => {
    store?.close();
    if (server) await server.close();
  });

  it("returns 401 without API key on withdraw endpoint", async () => {
    store = new TreasuryStore();
    server = await startServer(createTreasuryApp(B402_CONFIG.treasury, store));

    const response = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      body: JSON.stringify({ amount: "10", token: USDT, destination: COLD_WALLET }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(401);
  });

  it("returns 400 for missing required fields", async () => {
    store = new TreasuryStore();
    server = await startServer(createTreasuryApp(B402_CONFIG.treasury, store));

    const response = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "1000000000000000000", token: USDT }),
    });
    expect(response.status).toBe(400);
  });

  it("allows a valid withdrawal with API key", async () => {
    store = new TreasuryStore();
    server = await startServer(createTreasuryApp(B402_CONFIG.treasury, store));

    const response = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "500000000000000000", token: USDT, destination: COLD_WALLET, signature: "0xsig" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; daily_spent: string };
    expect(body.status).toBe("pending");
    expect(body.daily_spent).toBe("500000000000000000");
  });

  it("returns 403 when daily limit is exceeded", async () => {
    store = new TreasuryStore();
    const treasuryConfig: TreasuryConfig = {
      ...B402_CONFIG.treasury,
      dailyLimitAtomic: "1000000000000000000",
      singleLimitAtomic: "2000000000000000000",
    };
    server = await startServer(createTreasuryApp(treasuryConfig, store));

    const reqBody = (amount: string) => JSON.stringify({ amount, token: USDT, destination: COLD_WALLET });
    const headers = { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" };

    const r1 = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers,
      body: reqBody("1000000000000000000"),
    });
    expect(r1.status).toBe(200);

    const r2 = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers,
      body: reqBody("1000000000000000000"),
    });
    expect(r2.status).toBe(403);
    const body = (await r2.json()) as { reason: string };
    expect(body.reason).toBe("exceeds_daily_limit");
  });

  it("returns 403 for unauthorized destination", async () => {
    store = new TreasuryStore();
    server = await startServer(createTreasuryApp(B402_CONFIG.treasury, store));

    const response = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "500000000000000000", token: USDT, destination: UNAUTHORIZED_DEST }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { reason: string };
    expect(body.reason).toBe("destination_not_whitelisted");
  });

  it("returns 403 for unauthorized token", async () => {
    store = new TreasuryStore();
    server = await startServer(createTreasuryApp(B402_CONFIG.treasury, store));

    const response = await fetch(`${server.url}/api/v1/treasury/withdraw`, {
      method: "POST",
      headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "500000000000000000", token: UNKNOWN_TOKEN, destination: COLD_WALLET }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { reason: string };
    expect(body.reason).toBe("token_not_whitelisted");
  });

  it("returns treasury config on balance endpoint with API key", async () => {
    store = new TreasuryStore();
    server = await startServer(createTreasuryApp(B402_CONFIG.treasury, store));

    const response = await fetch(`${server.url}/api/v1/treasury/balance`, {
      headers: { "x-api-key": ADMIN_API_KEY },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { active: boolean; total_withdrawals: number };
    expect(body.active).toBe(true);
    expect(body.total_withdrawals).toBe(0);
  });

  it("returns 401 without API key on balance endpoint", async () => {
    store = new TreasuryStore();
    server = await startServer(createTreasuryApp(B402_CONFIG.treasury, store));

    const response = await fetch(`${server.url}/api/v1/treasury/balance`);
    expect(response.status).toBe(401);
  });
});
