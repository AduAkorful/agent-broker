import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentService } from "../../src/payment/payment-service.js";
import { B402FacilitatorClient } from "../../src/payment/b402-client.js";
import { NonceStore } from "../../src/payment/nonce-store.js";
import { B402_CONFIG } from "../../src/config.js";
import type { PaymentPayload, SettleResponse, VerifyResponse } from "../../src/payment/types.js";
import { isEip3009Payload } from "../../src/payment/types.js";

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

describe("PaymentService", () => {
  let nonceStore: NonceStore;
  let paymentService: PaymentService;
  let facilitator: B402FacilitatorClient;

  afterEach(() => {
    paymentService?.close();
  });

  describe("createPaymentChallenge", () => {
    it("generates a payment challenge with a nonce", () => {
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api?symbol=BTCUSDT",
        "volatility feed",
        B402_CONFIG.price.atomic,
      );

      expect(challenge.nonce).toMatch(/^0x[a-f0-9]{64}$/);
      expect(nonceStore.hasNonce(challenge.nonce)).toBe(true);
    });

    it("builds PaymentRequired with x402Version 2", () => {
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );

      expect(challenge.paymentRequired.x402Version).toBe(2);
      expect(challenge.paymentRequired.resource.url).toBe("http://example.com/api");
      expect(challenge.paymentRequired.resource.description).toBe("test");
    });

    it("includes USDT and USDC as accepted tokens", () => {
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );

      expect(challenge.paymentRequired.accepts).toHaveLength(2);
      expect(challenge.paymentRequired.accepts[0]!.asset).toBe(B402_CONFIG.tokens.usdt.address);
      expect(challenge.paymentRequired.accepts[1]!.asset).toBe(B402_CONFIG.tokens.usdc.address);
    });

    it("includes nonce, validAfter, and validBefore in extra", () => {
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );

      for (const accept of challenge.paymentRequired.accepts) {
        expect(accept.extra.nonce).toBe(challenge.nonce);
        expect(accept.extra.validAfter).toBe(0);
        expect(accept.extra.validBefore).toBeTypeOf("number");
        const skew = (accept.extra.validBefore as number) - Math.floor(Date.now() / 1000);
        expect(skew).toBeGreaterThanOrEqual(3590);
        expect(skew).toBeLessThanOrEqual(3610);
      }
    });

    it("includes EIP-712 domain info in extra", () => {
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );

      expect(challenge.paymentRequired.accepts[0]!.extra.name).toBe("B402");
      expect(challenge.paymentRequired.accepts[0]!.extra.version).toBe("1");
      expect(challenge.paymentRequired.accepts[0]!.extra.verifyingContract).toBe(B402_CONFIG.relayer);
      expect(challenge.paymentRequired.accepts[0]!.extra.assetTransferMethod).toBe("b402-relayer");
    });

    it("includes correct price, payTo, and network", () => {
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );

      for (const accept of challenge.paymentRequired.accepts) {
        expect(accept.scheme).toBe("exact");
        expect(accept.network).toBe("eip155:56");
        expect(accept.amount).toBe(B402_CONFIG.price.atomic);
        expect(accept.payTo).toBe(B402_CONFIG.payTo);
        expect(accept.maxTimeoutSeconds).toBe(3600);
      }
    });
  });

  describe("verifyPayment", () => {
    it("verifies successfully when nonce is valid and facilitator returns isValid", async () => {
      facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: String(challenge.paymentRequired.accepts[0]!.extra.validAfter),
            validBefore: String(challenge.paymentRequired.accepts[0]!.extra.validBefore),
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

      expect(result.isValid).toBe(true);
      expect(facilitator.verify).toHaveBeenCalledTimes(1);
      expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(true);
    });

    it("returns nonce_unknown for nonces not generated by the server", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: {
          scheme: "exact",
          network: "eip155:56",
          asset: B402_CONFIG.tokens.usdt.address,
          payTo: B402_CONFIG.payTo,
          amount: B402_CONFIG.price.atomic,
          maxTimeoutSeconds: 3600,
          extra: {},
        },
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: "0xunknown",
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("nonce_unknown");
      expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it("returns nonce_reused for nonces already used", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      nonceStore.markNonceUsed(challenge.nonce);

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("nonce_reused");
      expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it("returns token_not_accepted for unaccepted token", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: {
          ...challenge.paymentRequired.accepts[0]!,
          asset: "0xunacceptedtoken",
        },
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("token_not_accepted");
      expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it("propagates facilitator verify response when isValid is false", async () => {
      facilitator = makeMockFacilitator({
        isValid: false,
        invalidReason: "signature_invalid",
        invalidMessage: "Bad signature",
      });
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xbadsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("signature_invalid");
      // With post-verification consumption, a failed verification should NOT consume the nonce
      expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
    });

    it("propagates errors from facilitator verify", async () => {
      const errorFacilitator = {
        verify: vi.fn().mockRejectedValue(new Error("Network error")),
        settle: vi.fn().mockResolvedValue({}),
      };
      facilitator = errorFacilitator as unknown as B402FacilitatorClient;
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      await expect(paymentService.verifyPayment(payload, B402_CONFIG.price.atomic)).rejects.toThrow("Network error");
      // When the facilitator throws, the nonce must NOT be consumed so the buyer can retry
      expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
    });

    it("rejects payload without EIP-3009 authorization before calling facilitator", async () => {
      facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: {
          scheme: "exact",
          network: "eip155:56",
          asset: B402_CONFIG.tokens.usdt.address,
          payTo: B402_CONFIG.payTo,
          amount: B402_CONFIG.price.atomic,
          maxTimeoutSeconds: 3600,
          extra: {},
        },
        payload: {
          signature: "0xsig",
          authorization: "not-an-object",
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_payment_payload");
      expect(facilitator.verify).not.toHaveBeenCalled();
    });
  });

  describe("settlePayment", () => {
    it("returns settle response from facilitator", async () => {
      const settleResponse: SettleResponse = {
        success: true,
        transaction: "0xabc123",
        network: "eip155:56",
        payer: "0x1234",
      };
      facilitator = makeMockFacilitator(undefined, settleResponse);
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: {
          scheme: "exact",
          network: "eip155:56",
          asset: B402_CONFIG.tokens.usdt.address,
          payTo: B402_CONFIG.payTo,
          amount: B402_CONFIG.price.atomic,
          maxTimeoutSeconds: 3600,
          extra: {},
        },
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: "0xabc",
          },
        },
      };

      const result = await paymentService.settlePayment(payload);

      expect(result).toEqual(settleResponse);
    });

    it("propagates errors from facilitator settle", async () => {
      const errorFacilitator = {
        verify: vi.fn(),
        settle: vi.fn().mockRejectedValue(new Error("Settle failed")),
      };
      facilitator = errorFacilitator as unknown as B402FacilitatorClient;
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: {
          scheme: "exact",
          network: "eip155:56",
          asset: B402_CONFIG.tokens.usdt.address,
          payTo: B402_CONFIG.payTo,
          amount: B402_CONFIG.price.atomic,
          maxTimeoutSeconds: 3600,
          extra: {},
        },
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: "0xabc",
          },
        },
      };

      await expect(paymentService.settlePayment(payload)).rejects.toThrow("Settle failed");
    });
  });

  describe("amount validation", () => {
    it("rejects payments with wrong amount", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: {
          ...challenge.paymentRequired.accepts[0]!,
          amount: "1", // wrong amount
        },
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: "1",
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_amount");
    });

    it("does not consume nonce when amount is invalid", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: {
          ...challenge.paymentRequired.accepts[0]!,
          amount: "1",
        },
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: "1",
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
    });
  });

  describe("nonce expiry", () => {
    it("rejects expired nonces", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const oldTimestamp = Date.now() - 7_200_000; // 2 hours ago
      nonceStore.db.exec(`UPDATE nonces SET created_at = ${oldTimestamp} WHERE nonce = '${challenge.nonce}'`);

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("nonce_expired");
      expect(facilitator.verify).not.toHaveBeenCalled();
    });
  });

  describe("concurrent nonce reuse prevention", () => {
    it("only one of two concurrent requests with the same nonce can consume it", async () => {
      facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      // Both calls use the same nonce — with post-verification consumption,
      // both validate the nonce and call facilitator.verify, but the atomic
      // consumeNonce after success means only one can claim it.
      const [resultA, resultB] = await Promise.all([
        paymentService.verifyPayment(payload, B402_CONFIG.price.atomic),
        paymentService.verifyPayment(payload, B402_CONFIG.price.atomic),
      ]);

      const validCount = [resultA, resultB].filter((r) => r.isValid).length;
      expect(validCount).toBe(1);
      expect(facilitator.verify).toHaveBeenCalledTimes(2);
    });
  });

  describe("strict isValid normalization", () => {
    it("treats truthy non-boolean isValid as false", async () => {
      const fakeFacilitator = {
        verify: vi.fn().mockResolvedValue({ isValid: "true", payer: "0x1234" }),
        settle: vi.fn().mockResolvedValue({ success: true, transaction: "0xtx", network: "eip155:56" }),
      };
      facilitator = fakeFacilitator as unknown as B402FacilitatorClient;
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
    });

    it("rejects EIP-3009 authorization with validBefore in the past", async () => {
      facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "1", // epoch — expired
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("authorization_expired");
      expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
      expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it("rejects non-numeric validBefore (bypass prevention)", async () => {
      facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "garbage",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("authorization_expired");
      expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
      expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it("rejects future-dated validAfter", async () => {
      facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const futureTimestamp = String(Math.floor(Date.now() / 1000) + 3600);
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: futureTimestamp,
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("authorization_not_yet_valid");
      expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
      expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it("rejects non-numeric validAfter", async () => {
      facilitator = makeMockFacilitator({ isValid: true, payer: "0x1234" });
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "not-a-timestamp",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("authorization_not_yet_valid");
      expect(nonceStore.isNonceUsed(challenge.nonce)).toBe(false);
      expect(facilitator.verify).not.toHaveBeenCalled();
    });
  });

  describe("x402Version validation", () => {
    it("rejects payloads with wrong x402Version", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      const payload: PaymentPayload = {
        x402Version: 1,
        resource: { url: "http://example.com/api" },
        accepted: challenge.paymentRequired.accepts[0]!,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: challenge.nonce,
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_x402_version");
      expect(facilitator.verify).not.toHaveBeenCalled();
    });
  });

  describe("payload.accepted validation", () => {
    it("rejects missing accepted requirements field", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const payload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: undefined,
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: "0xnonexistent",
          },
        },
      } as unknown as PaymentPayload;

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_payment_requirements");
      expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it("rejects null accepted requirements", async () => {
      facilitator = makeMockFacilitator();
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const payload: PaymentPayload = {
        x402Version: 2,
        resource: { url: "http://example.com/api" },
        accepted: null as unknown as PaymentPayload["accepted"],
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234",
            to: B402_CONFIG.payTo,
            value: B402_CONFIG.price.atomic,
            validAfter: "1",
            validBefore: "9999999999",
            nonce: "0xnonexistent",
          },
        },
      };

      const result = await paymentService.verifyPayment(payload, B402_CONFIG.price.atomic);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("missing_payment_requirements");
      expect(facilitator.verify).not.toHaveBeenCalled();
    });
  });

  describe("isEip3009Payload", () => {
    it("accepts a complete EIP-3009 payload", () => {
      const payload = {
        signature: "0xsig",
        authorization: {
          from: "0x1234",
          to: "0x5678",
          value: "1000",
          validAfter: "1",
          validBefore: "9999999999",
          nonce: "0xnonce",
        },
      };
      expect(isEip3009Payload(payload)).toBe(true);
    });

    it("rejects payload missing signature", () => {
      expect(
        isEip3009Payload({
          authorization: { from: "0x1", to: "0x2", value: "1", validAfter: "1", validBefore: "2", nonce: "0x3" },
        }),
      ).toBe(false);
    });

    it("rejects payload missing authorization", () => {
      expect(isEip3009Payload({ signature: "0xsig" })).toBe(false);
    });

    it("rejects authorization missing value", () => {
      expect(
        isEip3009Payload({
          signature: "0xsig",
          authorization: { from: "0x1", to: "0x2", validAfter: "1", validBefore: "2", nonce: "0x3" },
        }),
      ).toBe(false);
    });

    it("rejects authorization missing validAfter", () => {
      expect(
        isEip3009Payload({
          signature: "0xsig",
          authorization: { from: "0x1", to: "0x2", value: "1", validBefore: "2", nonce: "0x3" },
        }),
      ).toBe(false);
    });

    it("rejects authorization missing validBefore", () => {
      expect(
        isEip3009Payload({
          signature: "0xsig",
          authorization: { from: "0x1", to: "0x2", value: "1", validAfter: "1", nonce: "0x3" },
        }),
      ).toBe(false);
    });

    it("rejects non-object payload", () => {
      expect(isEip3009Payload(null)).toBe(false);
      expect(isEip3009Payload("string")).toBe(false);
      expect(isEip3009Payload(42)).toBe(false);
    });
  });

  describe("scheduleNonceCleanup", () => {
    it("cleans up expired nonces on interval", async () => {
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ nonceStore, config: B402_CONFIG });

      const challenge = paymentService.createPaymentChallenge(
        "http://example.com/api",
        "test",
        B402_CONFIG.price.atomic,
      );
      expect(nonceStore.hasNonce(challenge.nonce)).toBe(true);

      // Set nonce creation time to 2 hours ago (expired)
      nonceStore.db.exec(`UPDATE nonces SET created_at = ${Date.now() - 7_200_000} WHERE nonce = '${challenge.nonce}'`);

      const cleanup = paymentService.scheduleNonceCleanup(100); // 100ms interval

      // Wait for cleanup to run
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(nonceStore.hasNonce(challenge.nonce)).toBe(false);
      cleanup.stop();
    });
  });

  describe("checkFacilitatorHealth", () => {
    it("returns true when facilitator is healthy", async () => {
      const mockFacilitator = {
        checkHealth: vi.fn().mockResolvedValue(true),
      };
      facilitator = mockFacilitator as unknown as B402FacilitatorClient;
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const result = await paymentService.checkFacilitatorHealth();
      expect(result).toBe(true);
      expect(facilitator.checkHealth).toHaveBeenCalledTimes(1);
    });

    it("returns false when facilitator is unhealthy", async () => {
      const mockFacilitator = {
        checkHealth: vi.fn().mockResolvedValue(false),
      };
      facilitator = mockFacilitator as unknown as B402FacilitatorClient;
      nonceStore = new NonceStore();
      paymentService = new PaymentService({ facilitator, nonceStore, config: B402_CONFIG });

      const result = await paymentService.checkFacilitatorHealth();
      expect(result).toBe(false);
    });
  });
});
