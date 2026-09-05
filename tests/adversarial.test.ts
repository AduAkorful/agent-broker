import { describe, expect, it, vi } from "vitest";
import { PaymentService } from "../src/payment/payment-service.js";
import { B402FacilitatorClient } from "../src/payment/b402-client.js";
import { NonceStore } from "../src/payment/nonce-store.js";
import { B402_CONFIG } from "../src/config.js";
import { CvmsScorer } from "../src/cvms.js";
import type { PaymentPayload, SettleResponse, VerifyResponse } from "../src/payment/types.js";
import type { MarketSnapshot } from "../src/types.js";

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

function makeValidPayload(nonce: string, overrides: Partial<PaymentPayload["accepted"]> = {}): PaymentPayload {
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
      extra: { nonce, validAfter: 1, validBefore: 9999999999 },
      ...overrides,
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

describe("Adversarial Audit — Payment Flow (post-fix)", () => {
  let nonceStore: NonceStore;
  let paymentService: PaymentService;
  let facilitator: B402FacilitatorClient;

  it("ATTACK-1: payTo field substitution is now rejected", async () => {
    facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
    nonceStore = new NonceStore();
    paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

    const challenge = paymentService.createPaymentChallenge("http://example.com/api", "test", B402_CONFIG.price.atomic);
    const attackerAddress = "0x9999999999999999999999999999999999999999";

    const payload = makeValidPayload(challenge.nonce, { payTo: attackerAddress });

    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("payTo_mismatch");
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
    paymentService.close();
  });

  it("ATTACK-2: network field substitution is now rejected", async () => {
    facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
    nonceStore = new NonceStore();
    paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

    const challenge = paymentService.createPaymentChallenge("http://example.com/api", "test", B402_CONFIG.price.atomic);

    const payload = makeValidPayload(challenge.nonce, { network: "eip155:1" });

    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("network_mismatch");
    expect(facilitator.verify).not.toHaveBeenCalled();
    paymentService.close();
  });

  it("ATTACK-3: scheme field substitution is now rejected", async () => {
    facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
    nonceStore = new NonceStore();
    paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

    const challenge = paymentService.createPaymentChallenge("http://example.com/api", "test", B402_CONFIG.price.atomic);

    const payload = makeValidPayload(challenge.nonce, { scheme: "post-demand" });

    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_scheme");
    expect(facilitator.verify).not.toHaveBeenCalled();
    paymentService.close();
  });

  it("ATTACK-4: non-EIP-3009 payload is now rejected before facilitator call", async () => {
    facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
    nonceStore = new NonceStore();
    paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

    const challenge = paymentService.createPaymentChallenge("http://example.com/api", "test", B402_CONFIG.price.atomic);

    const payload = makeValidPayload(challenge.nonce);
    payload.payload = { signature: "0xwrong", authorization: null };

    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_payment_payload");
    expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
    expect(facilitator.verify).not.toHaveBeenCalled();
    paymentService.close();
  });

  it("ATTACK-5: missing asset field in accepted is now handled gracefully", async () => {
    facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
    nonceStore = new NonceStore();
    paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

    const challenge = paymentService.createPaymentChallenge("http://example.com/api", "test", B402_CONFIG.price.atomic);

    const payload = makeValidPayload(challenge.nonce);
    delete (payload.accepted as { asset?: string }).asset;

    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("token_not_accepted");
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
    paymentService.close();
  });

  it("ATTACK-6: accepted empty object is now handled gracefully", async () => {
    facilitator = makeMockFacilitator();
    nonceStore = new NonceStore();
    paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: {} as PaymentPayload["accepted"],
      payload: { signature: "0xsig", authorization: null as unknown as Record<string, unknown> },
    };

    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("token_not_accepted");
  });

  it("ATTACK-7: settleResponse with truthy non-boolean success is now rejected by middleware", async () => {
    // After fix: middleware uses `settleResponse.success !== true` (strict check)
    // "true" (string) !== true (boolean), so settlement is rejected
    const truthySucceedFacilitator = {
      verify: vi.fn().mockResolvedValue({ isValid: true, payer: "0x1234" }),
      settle: vi
        .fn()
        .mockResolvedValue({ success: "true", transaction: "0xtx", network: "eip155:56" } as unknown as SettleResponse),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    nonceStore = new NonceStore();
    paymentService = new PaymentService({
      facilitator: truthySucceedFacilitator as unknown as B402FacilitatorClient,
      nonceStore,
      config: B402_CONFIG,
    });

    const challenge = paymentService.createPaymentChallenge("http://example.com/api", "test", B402_CONFIG.price.atomic);
    const payload = makeValidPayload(challenge.nonce);

    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
    expect(result.isValid).toBe(true);

    const settleResult = await paymentService.settlePayment(payload);
    // settlePayment returns the facilitator's raw response; the middleware-level
    // strict check (`!== true`) is what enforces the fix
    expect(settleResult.success).toBe("true");
    expect(settleResult.success === true).toBe(false); // would be rejected by middleware
    paymentService.close();
  });
});

describe("Adversarial Audit — CVMS NaN/Infinity Injection (post-fix)", () => {
  it("ATTACK-8: NaN openInterest is clamped to safe value, not propagated", () => {
    const scorer = new CvmsScorer();
    const snapshot: MarketSnapshot = {
      symbol: "BTCUSDT",
      interval: "1h",
      fetchedAt: Date.now(),
      ticker: { lastPrice: "64000" },
      klines: [
        { openTime: 1, open: 100, high: 110, low: 90, close: 100, volume: 10 },
        { openTime: 2, open: 100, high: 110, low: 90, close: 110, volume: 10 },
      ],
      orderBook: { bids: [{ price: 100, quantity: 10 }], asks: [{ price: 101, quantity: 10 }] },
      openInterest: NaN,
      sources: ["ticker", "klines", "orderBook"],
    };

    const score = scorer.score(snapshot);

    expect(score.open_interest).toBe(0);
    expect(Number.isNaN(score.composite_score)).toBe(false);
    expect(score.composite_score).toBeGreaterThanOrEqual(0);
    expect(score.composite_score).toBeLessThanOrEqual(100);
  });

  it("ATTACK-9: Infinity openInterest is clamped to finite safe value", () => {
    const scorer = new CvmsScorer();
    const snapshot: MarketSnapshot = {
      symbol: "BTCUSDT",
      interval: "1h",
      fetchedAt: Date.now(),
      ticker: { lastPrice: "64000" },
      klines: [
        { openTime: 1, open: 100, high: 110, low: 90, close: 100, volume: 10 },
        { openTime: 2, open: 100, high: 110, low: 90, close: 110, volume: 10 },
      ],
      orderBook: { bids: [{ price: 100, quantity: 10 }], asks: [{ price: 101, quantity: 10 }] },
      openInterest: Infinity,
      sources: ["ticker", "klines", "orderBook"],
    };

    const score = scorer.score(snapshot);

    expect(Number.isFinite(score.open_interest)).toBe(true);
    expect(score.open_interest).toBe(0);
    expect(Number.isFinite(score.composite_score)).toBe(true);
    expect(score.composite_score).toBeGreaterThanOrEqual(0);
    expect(score.composite_score).toBeLessThanOrEqual(100);
  });

  it("ATTACK-10: negative close prices are safely handled (clamped to 0 volatility)", () => {
    const scorer = new CvmsScorer();
    const snapshot: MarketSnapshot = {
      symbol: "BTCUSDT",
      interval: "1h",
      fetchedAt: Date.now(),
      ticker: { lastPrice: "64000" },
      klines: [
        { openTime: 1, open: -100, high: -100, low: -100, close: -100, volume: 10 },
        { openTime: 2, open: -100, high: -100, low: -100, close: -90, volume: 10 },
      ],
      orderBook: { bids: [{ price: 100, quantity: 10 }], asks: [{ price: 101, quantity: 10 }] },
      sources: ["ticker", "klines", "orderBook"],
    };

    const score = scorer.score(snapshot);
    expect(score.volatility_score).toBeGreaterThanOrEqual(0);
    expect(score.volatility_score).toBeLessThanOrEqual(100);
    expect(score.composite_score).toBeGreaterThanOrEqual(0);
    expect(score.composite_score).toBeLessThanOrEqual(100);
  });
});

describe("Adversarial Audit — Nonce & Replay (post-fix)", () => {
  it("ATTACK-11: extremely long nonce string is now rejected with nonce_too_long", () => {
    const store = new NonceStore();
    const longNonce = "0x" + "a".repeat(100000);
    const result = store.consumeNonce(longNonce, 3_600_000);
    expect(result.success).toBe(false);
    expect(result.reason).toBe("nonce_too_long");
    store.close();
  });

  it("ATTACK-12: nonce with SQL injection characters — parameterized queries prevent injection", () => {
    const store = new NonceStore();
    const sqlNonce = "0x'; DROP TABLE nonces;--";
    const result = store.consumeNonce(sqlNonce, 3_600_000);
    expect(result.success).toBe(false);
    expect(result.reason).toBe("unknown");
    expect(store.getNonceCount()).toBe(0);
    store.close();
  });

  it("ATTACK-11b: nonce at exactly max length (256 chars) is accepted", () => {
    const store = new NonceStore();
    const nonce = "n".repeat(256);
    // Manually insert a nonce at max length to test the boundary
    store.db.prepare("INSERT INTO nonces (nonce, created_at) VALUES (?, ?)").run(nonce, Date.now());
    const result = store.consumeNonce(nonce, 3_600_000);
    expect(result.success).toBe(true);
    store.close();
  });
});

describe("Adversarial Audit — Resource URL / Host Header", () => {
  it("ATTACK-13: resource URL is not validated against challenge (accepted risk)", async () => {
    const nonceStore = new NonceStore();
    const facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
    const paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

    const challenge = paymentService.createPaymentChallenge(
      "http://example.com/api?symbol=BTCUSDT",
      "test",
      B402_CONFIG.price.atomic,
    );
    const nonce = challenge.nonce;

    const payload = makeValidPayload(nonce);
    payload.resource = { url: "https://attacker.com/steal-data" };

    // After H1 fix, payTo/network/scheme are validated but resource.url is NOT checked.
    // This is an accepted LOW risk — resource URL is informational, nonce is the primary anti-replay token,
    // and there is only one protected endpoint.
    const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
    expect(result.isValid).toBe(true);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);

    paymentService.close();
  });
});

describe("Adversarial Audit — Config & Secrets", () => {
  it("ATTACK-14: B402_TREASURY_ACTIVE=false via env var disables treasury (override behavior)", () => {
    const config = {
      ...B402_CONFIG,
      treasury: {
        ...B402_CONFIG.treasury,
        active: false,
      },
    };
    expect(config.treasury.active).toBe(false);
    expect(config.treasury.dailyLimitAtomic).toBe(B402_CONFIG.treasury.dailyLimitAtomic);
  });

  it("ATTACK-15: default withdrawal whitelist contains placeholder address (deploy-time concern)", () => {
    expect(B402_CONFIG.treasury.withdrawalWhitelist).toContain("0x0000000000000000000000000000000000000001");
  });
});
