import { describe, expect, it, vi } from "vitest";
import { B402FacilitatorClient, B402FacilitatorError, toFacilitatorRequest } from "../../src/payment/b402-client.js";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "../../src/payment/types.js";

const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const RELAYER = "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171";
const SELLER = "0x0000000000000000000000000000000000000001";
const AMOUNT = "50000000000000000";

function makePayload(nonce = "0xpending"): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "http://example.com/test", description: "test", mimeType: "application/json" },
    accepted: {
      scheme: "exact",
      network: "eip155:56",
      asset: USDT_ADDRESS,
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

function makeRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:56",
    asset: USDT_ADDRESS,
    payTo: SELLER,
    amount: AMOUNT,
    maxTimeoutSeconds: 3600,
    extra: { name: "B402", version: "1", assetTransferMethod: "b402-relayer" },
  };
}

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("B402FacilitatorClient", () => {
  it("calls /verify with correct request body and returns VerifyResponse", async () => {
    const payload = makePayload();
    const requirements = makeRequirements();
    const expectedVerifyResponse: VerifyResponse = { isValid: true, payer: "0x1234" };

    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, expectedVerifyResponse)) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({
      fetchFn,
      baseUrl: "https://facilitator.example.com",
      relayerContract: RELAYER,
    });

    const result = await client.verify(payload, requirements);

    expect(result).toEqual(expectedVerifyResponse);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://facilitator.example.com/api/v1/verify",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPayload: {
            token: USDT_ADDRESS,
            payload: {
              signature: "0xsig",
              authorization: {
                token: USDT_ADDRESS,
                from: "0x1234567890123456789012345678901234567890",
                to: SELLER,
                value: AMOUNT,
                validAfter: 1,
                validBefore: 9999999999,
                nonce: "0xpending",
              },
            },
          },
          paymentRequirements: {
            network: "bsc",
            relayerContract: RELAYER,
          },
        }),
      }),
    );
  });

  it("calls /settle with correct request body and returns SettleResponse", async () => {
    const payload = makePayload();
    const requirements = makeRequirements();
    const expectedSettleResponse: SettleResponse = {
      success: true,
      transaction: "0xtxhash",
      network: "eip155:56",
      payer: "0x1234",
    };

    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, expectedSettleResponse)) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({
      fetchFn,
      baseUrl: "https://facilitator.example.com",
      relayerContract: RELAYER,
    });

    const result = await client.settle(payload, requirements);

    expect(result).toEqual(expectedSettleResponse);
    expect(fetchFn).toHaveBeenCalledWith("https://facilitator.example.com/api/v1/settle", expect.any(Object));
  });

  it("throws B402FacilitatorError on HTTP error", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        mockResponse(500, { error: { code: "internal", message: "oops" } }),
      ) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({
      fetchFn,
      baseUrl: "https://facilitator.example.com",
      timeoutMs: 5000,
      maxRetries: 0,
    });

    await expect(client.verify(makePayload(), makeRequirements())).rejects.toThrow(B402FacilitatorError);
  });

  it("includes status code in B402FacilitatorError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(400, { error: "bad request" })) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({
      fetchFn,
      baseUrl: "https://facilitator.example.com",
      timeoutMs: 5000,
      maxRetries: 0,
    });

    try {
      await client.verify(makePayload(), makeRequirements());
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(B402FacilitatorError);
      expect((error as B402FacilitatorError).statusCode).toBe(400);
    }
  });

  it("throws timeout error on fetch that never resolves", async () => {
    const fetchFn = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      return new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          (error as { name: string }).name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({
      fetchFn,
      baseUrl: "https://facilitator.example.com",
      timeoutMs: 100,
      maxRetries: 0,
    });

    await expect(client.verify(makePayload(), makeRequirements())).rejects.toThrow(B402FacilitatorError);
    await expect(client.verify(makePayload(), makeRequirements())).rejects.toThrow(/timed out/);
  });

  it("uses default facilitator URL when no baseUrl provided", () => {
    const client = new B402FacilitatorClient();
    expect(client["baseUrl"]).toBe("https://facilitatorv3.b402.ai");
  });

  it("strips trailing slash from baseUrl", () => {
    const client = new B402FacilitatorClient({ baseUrl: "https://facilitator.example.com/" });
    expect(client["baseUrl"]).toBe("https://facilitator.example.com");
  });

  it("uses default timeout of 30 seconds", () => {
    const client = new B402FacilitatorClient();
    expect(client["timeoutMs"]).toBe(30_000);
  });

  it("defaults maxRetries to 3", () => {
    const client = new B402FacilitatorClient();
    expect(client["maxRetries"]).toBe(3);
  });

  it("does not retry on 4xx client errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(400, { error: "bad request" })) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({ fetchFn, baseUrl: "https://facilitator.example.com", timeoutMs: 5000 });

    await expect(client.verify(makePayload(), makeRequirements())).rejects.toThrow(B402FacilitatorError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx server errors and eventually throws", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(500, { error: "server error" })) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({
      fetchFn,
      baseUrl: "https://facilitator.example.com",
      timeoutMs: 5000,
      maxRetries: 1,
    });

    await expect(client.verify(makePayload(), makeRequirements())).rejects.toThrow(B402FacilitatorError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 and succeeds on second attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(500, { error: "server error" }))
      .mockResolvedValueOnce(mockResponse(200, { isValid: true, payer: "0x1234" })) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({
      fetchFn,
      baseUrl: "https://facilitator.example.com",
      timeoutMs: 5000,
      maxRetries: 1,
    });

    const result = await client.verify(makePayload(), makeRequirements());
    expect(result).toEqual({ isValid: true, payer: "0x1234" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("checkHealth returns true on 200", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, { status: "ok" })) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({ fetchFn, baseUrl: "https://facilitator.example.com", maxRetries: 0 });

    const result = await client.checkHealth();
    expect(result).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://facilitator.example.com/api/v1/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("checkHealth returns false on 500", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(500, { error: "internal" })) as unknown as typeof fetch;
    const client = new B402FacilitatorClient({ fetchFn, baseUrl: "https://facilitator.example.com", maxRetries: 0 });

    const result = await client.checkHealth();
    expect(result).toBe(false);
  });

  it("verify uses /api/v1/verify path (not /verify)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(200, { isValid: true }));
    const client = new B402FacilitatorClient({
      fetchFn: mockFetch as unknown as typeof fetch,
      baseUrl: "https://facilitator.example.com",
      maxRetries: 0,
    });

    await client.verify(makePayload(), makeRequirements());

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://facilitator.example.com/api/v1/verify");
    expect(calledUrl).not.toBe("https://facilitator.example.com/verify");
  });

  it("settle uses /api/v1/settle path (not /settle)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { success: true, transaction: "0x123", network: "eip155:56" }));
    const client = new B402FacilitatorClient({
      fetchFn: mockFetch as unknown as typeof fetch,
      baseUrl: "https://facilitator.example.com",
      maxRetries: 0,
    });

    await client.settle(makePayload(), makeRequirements());

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://facilitator.example.com/api/v1/settle");
    expect(calledUrl).not.toBe("https://facilitator.example.com/settle");
  });

  it("settle includes Idempotency-Key header from EIP-3009 nonce", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { success: true, transaction: "0x123", network: "eip155:56" }));
    const client = new B402FacilitatorClient({
      fetchFn: mockFetch as unknown as typeof fetch,
      baseUrl: "https://facilitator.example.com",
      maxRetries: 0,
    });

    await client.settle(makePayload(), makeRequirements());

    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toHaveProperty("Idempotency-Key", "0xpending");
  });

  it("checkHealth probes /api/v1/health (not root)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(200, { status: "ok" }));
    const client = new B402FacilitatorClient({
      fetchFn: mockFetch as unknown as typeof fetch,
      baseUrl: "https://facilitator.example.com",
      maxRetries: 0,
    });

    await client.checkHealth();

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://facilitator.example.com/api/v1/health");
    expect(calledUrl).not.toBe("https://facilitator.example.com");
  });
});

describe("toFacilitatorRequest B402 mapping", () => {
  it("maps x402 envelope to token + bsc + relayerContract", () => {
    const body = toFacilitatorRequest(makePayload("0xabc"), makeRequirements(), RELAYER);
    expect(body.paymentPayload.token).toBe(USDT_ADDRESS);
    expect(body.paymentPayload.payload.authorization.token).toBe(USDT_ADDRESS);
    expect(body.paymentPayload.payload.authorization.to).toBe(SELLER);
    expect(body.paymentRequirements).toEqual({ network: "bsc", relayerContract: RELAYER });
    expect(body).not.toHaveProperty("x402Version");
  });
});
