import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import {
  paymentMiddleware,
  PAYMENT_SIGNATURE_HEADER,
  PAYMENT_REQUIRED_HEADER,
  getClientIp,
} from "../../src/payment/middleware.js";
import { PaymentService } from "../../src/payment/payment-service.js";
import { RateLimitStore } from "../../src/payment/rate-limit-store.js";
import { B402FacilitatorClient, B402FacilitatorError } from "../../src/payment/b402-client.js";
import { B402_CONFIG } from "../../src/config.js";
import { logger } from "../../src/logger.js";
import type { PaymentPayload, SettleResponse, VerifyResponse } from "../../src/payment/types.js";

function makeMockFacilitator(
  verifyResponse: VerifyResponse = { isValid: true, payer: "0x1234" },
  settleResponse: SettleResponse = { success: true, transaction: "0xtx", network: "eip155:56", payer: "0x1234" },
): B402FacilitatorClient {
  const mock = {
    verify: vi.fn().mockResolvedValue(verifyResponse),
    settle: vi.fn().mockResolvedValue(settleResponse),
  };
  return mock as unknown as B402FacilitatorClient;
}

function createPaymentPayload(nonce: string): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "http://localhost/api/v1/market-intelligence/volatility" },
    accepted: {
      scheme: "exact",
      network: "eip155:56",
      asset: B402_CONFIG.tokens.usdt.address,
      payTo: B402_CONFIG.payTo,
      amount: B402_CONFIG.price.atomic,
      maxTimeoutSeconds: 3600,
      extra: { name: "B402", version: "1", assetTransferMethod: "b402-relayer" },
    },
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0x1234567890123456789012345678901234567890",
        to: B402_CONFIG.payTo,
        value: B402_CONFIG.price.atomic,
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

function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("paymentMiddleware", () => {
  let server: { url: string; close: () => Promise<void> };
  let paymentService: PaymentService;
  let rateLimiter: RateLimitStore;

  afterEach(async () => {
    paymentService?.close();
    rateLimiter?.close();
    if (server) await server.close();
  });

  it("returns 402 with PAYMENT-REQUIRED header when no payment signature", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/api/v1/test`);

    expect(response.status).toBe(402);
    expect(response.headers.get(PAYMENT_REQUIRED_HEADER.toLowerCase())).toBeTruthy();

    const body = (await response.json()) as { x402Version: number; accepts: unknown[] };
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(2);
  });

  it("returns 402 when payment signature is invalid base64", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: "not-valid-base64!!!" },
    });

    expect(response.status).toBe(402);
    expect(response.headers.get(PAYMENT_REQUIRED_HEADER.toLowerCase())).toBeTruthy();
  });

  it("returns 402 when payment verification fails", async () => {
    const facilitator = makeMockFacilitator({
      isValid: false,
      invalidReason: "signature_invalid",
      invalidMessage: "Bad sig",
    });
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    // First get a nonce
    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    // Send payment with that nonce
    const payload = createPaymentPayload(nonce);
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBeTruthy();
  });

  it("returns 402 when payment verification throws", async () => {
    const errorFacilitator = {
      verify: vi.fn().mockRejectedValue(new Error("Facilitator unreachable")),
      settle: vi.fn(),
    };
    paymentService = new PaymentService({ facilitator: errorFacilitator as unknown as B402FacilitatorClient });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    // Get a nonce
    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    const payload = createPaymentPayload(nonce);
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(402);
  });

  it("returns 402 when settlement fails", async () => {
    const facilitator = makeMockFacilitator(
      { isValid: true, payer: "0x1234" },
      {
        success: false,
        transaction: "",
        network: "eip155:56",
        errorReason: "insufficient_balance",
        errorMessage: "Not enough tokens",
      },
    );
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    // Get a nonce
    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    const payload = createPaymentPayload(nonce);
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(402);
  });

  it("returns 402 when settlement throws", async () => {
    const throwFacilitator = {
      verify: vi.fn().mockResolvedValue({ isValid: true, payer: "0x1234" }),
      settle: vi.fn().mockRejectedValue(new Error("Transaction failed")),
    };
    paymentService = new PaymentService({ facilitator: throwFacilitator as unknown as B402FacilitatorClient });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    // Get a nonce
    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    const payload = createPaymentPayload(nonce);
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(402);
  });

  it("returns 200 with PAYMENT-RESPONSE header when payment is valid", async () => {
    const facilitator = makeMockFacilitator(
      { isValid: true, payer: "0x1234" },
      { success: true, transaction: "0xtxhash", network: "eip155:56", payer: "0x1234" },
    );
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected resource" });
    });
    server = await startServer(app);

    // Get a nonce
    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    // Send payment
    const payload = createPaymentPayload(nonce);
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();

    const body = (await response.json()) as { data: string };
    expect(body.data).toBe("protected resource");

    const paymentResponse = decodeHeader(response.headers.get("payment-response"));
    expect((paymentResponse as SettleResponse).success).toBe(true);
    expect((paymentResponse as SettleResponse).transaction).toBe("0xtxhash");
  });

  it("does not settle when verification fails", async () => {
    const facilitator = makeMockFacilitator(
      { isValid: false, invalidReason: "test_failure" },
      { success: true, transaction: "0xshouldnotbesent", network: "eip155:56" },
    );
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    // Get a nonce
    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    const payload = createPaymentPayload(nonce);
    await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 2, windowSeconds: 60 } });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService, { rateLimiter }), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    const r1 = await fetch(`${server.url}/api/v1/test`);
    expect(r1.status).toBe(402);

    const r2 = await fetch(`${server.url}/api/v1/test`);
    expect(r2.status).toBe(402);

    const r3 = await fetch(`${server.url}/api/v1/test`);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBeTruthy();

    const body = (await r3.json()) as { error: string };
    expect(body.error).toBe("Too Many Requests");
  });

  it("allows requests once the rate limit resets after the window", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 1 } });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService, { rateLimiter }), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    expect((await fetch(`${server.url}/api/v1/test`)).status).toBe(402);
    expect((await fetch(`${server.url}/api/v1/test`)).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect((await fetch(`${server.url}/api/v1/test`)).status).toBe(402);
  });

  it("does not apply rate limiting when no rateLimiter is provided", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    for (let i = 0; i < 15; i++) {
      const response = await fetch(`${server.url}/api/v1/test`);
      expect(response.status).toBe(402);
    }
  });

  it("isolated rate limits per IP", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    rateLimiter = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 60 } });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService, { rateLimiter, trustProxy: true }), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    const r1 = await fetch(`${server.url}/api/v1/test`, { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(r1.status).toBe(402);

    const r2 = await fetch(`${server.url}/api/v1/test`, { headers: { "x-forwarded-for": "2.2.2.2" } });
    expect(r2.status).toBe(402);
  });

  it("rejects payments when facilitator returns truthy non-boolean isValid", async () => {
    const truthyFacilitator = {
      verify: vi.fn().mockResolvedValue({ isValid: "true", payer: "0x1234" }),
      settle: vi.fn().mockResolvedValue({ success: true, transaction: "0xtx", network: "eip155:56" }),
    };
    paymentService = new PaymentService({ facilitator: truthyFacilitator as unknown as B402FacilitatorClient });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    const payload = createPaymentPayload(nonce);
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(402);
    expect(truthyFacilitator.settle).not.toHaveBeenCalled();
  });

  it("rejects payments with wrong amount", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    const payload = createPaymentPayload(nonce);
    payload.accepted.amount = "1"; // wrong amount
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(402);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("does not serve data when nonce is expired", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    // Expire the nonce manually
    const nonceStore = paymentService.getNonceStore();
    const oldTimestamp = Date.now() - 7_200_000;
    nonceStore.db.exec(`UPDATE nonces SET created_at = ${oldTimestamp} WHERE nonce = '${nonce}'`);

    const payload = createPaymentPayload(nonce);
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(402);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("returns 402 when payment-signature header is an empty string", async () => {
    const facilitator = makeMockFacilitator();
    paymentService = new PaymentService({ facilitator });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: "" },
    });

    expect(response.status).toBe(402);
    expect(response.headers.get(PAYMENT_REQUIRED_HEADER.toLowerCase())).toBeTruthy();
  });

  it("logs B402FacilitatorError response body and status code when verify fails", async () => {
    const errorSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const errorFacilitator = {
      verify: vi
        .fn()
        .mockRejectedValue(
          new B402FacilitatorError("Facilitator /verify returned HTTP 500", 500, { error: "internal" }),
        ),
      settle: vi.fn(),
    };
    paymentService = new PaymentService({ facilitator: errorFacilitator as unknown as B402FacilitatorClient });
    const app = express();
    app.get("/api/v1/test", paymentMiddleware(paymentService), (_req, res) => {
      res.json({ data: "protected" });
    });
    server = await startServer(app);

    // Get a nonce
    const challengeResponse = await fetch(`${server.url}/api/v1/test`);
    const paymentRequired = decodeHeader(challengeResponse.headers.get("payment-required")) as {
      accepts: Array<{ extra: { nonce: string } }>;
    };
    const nonce = paymentRequired.accepts[0]!.extra.nonce;

    const payload = createPaymentPayload(nonce);
    const response = await fetch(`${server.url}/api/v1/test`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: encodePayload(payload) },
    });

    expect(response.status).toBe(402);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Payment verification error"),
      expect.objectContaining({ statusCode: 500, response: { error: "internal" } }),
    );

    errorSpy.mockRestore();
  });
});

describe("getClientIp", () => {
  it("returns X-Forwarded-For first IP when trustProxy is true", () => {
    const mockReq = {
      get: (header: string) => (header === "x-forwarded-for" ? "1.2.3.4, 5.6.7.8" : undefined),
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as import("express").Request;

    expect(getClientIp(mockReq, true)).toBe("1.2.3.4");
  });

  it("returns req.ip when trustProxy is false (ignores X-Forwarded-For)", () => {
    const mockReq = {
      get: (header: string) => (header === "x-forwarded-for" ? "1.2.3.4" : undefined),
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as import("express").Request;

    expect(getClientIp(mockReq, false)).toBe("127.0.0.1");
  });

  it("returns 'unknown' when no IP is available", () => {
    const mockReq = {
      get: () => undefined,
      ip: undefined,
      socket: { remoteAddress: undefined },
    } as unknown as import("express").Request;

    expect(getClientIp(mockReq, false)).toBe("unknown");
  });
});
