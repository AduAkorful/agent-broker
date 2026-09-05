import type {
  B402FacilitatorRequest,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  TransferWithAuthorizationPayload,
  VerifyResponse,
} from "./types.js";
import { isTransferWithAuthorizationPayload, mapCaip2NetworkToB402, normalizeAddress } from "./types.js";

export class B402FacilitatorError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = "B402FacilitatorError";
  }
}

export interface B402FacilitatorClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  maxRetries?: number;
  /** Relayer contract address sent as paymentRequirements.relayerContract */
  relayerContract?: string;
}

/**
 * Translate client x402 PaymentPayload into the live B402 facilitator body.
 * Keeps x402 headers toward HTTP clients; translation happens only at this edge.
 */
export function toFacilitatorRequest(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  relayerContract: string,
): B402FacilitatorRequest {
  if (!isTransferWithAuthorizationPayload(payload.payload)) {
    throw new B402FacilitatorError("Payment payload must be TransferWithAuthorization", 400);
  }
  const authPayload = payload.payload as TransferWithAuthorizationPayload;
  const token = requirements.asset || payload.accepted?.asset;
  if (!token || typeof token !== "string") {
    throw new B402FacilitatorError("Payment requirements missing token asset address", 400);
  }
  const authToken =
    typeof authPayload.authorization.token === "string" && authPayload.authorization.token.length > 0
      ? authPayload.authorization.token
      : token;

  return {
    paymentPayload: {
      token,
      payload: {
        signature: authPayload.signature,
        authorization: {
          token: authToken,
          from: authPayload.authorization.from,
          to: authPayload.authorization.to,
          value: authPayload.authorization.value,
          validAfter: Number(authPayload.authorization.validAfter),
          validBefore: Number(authPayload.authorization.validBefore),
          nonce: authPayload.authorization.nonce,
        },
      },
    },
    paymentRequirements: {
      network: mapCaip2NetworkToB402(requirements.network),
      relayerContract,
    },
  };
}

export class B402FacilitatorClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly relayerContract: string;

  constructor(options: B402FacilitatorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://facilitatorv3.b402.ai").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.relayerContract = options.relayerContract ?? "0xE91b564EB8DFF305Ff8efA332f84c487b9da5171";
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const request = toFacilitatorRequest(payload, requirements, this.relayerContract);
    return this.request<VerifyResponse>("/api/v1/verify", request);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const request = toFacilitatorRequest(payload, requirements, this.relayerContract);
    const idempotencyKey = isTransferWithAuthorizationPayload(payload.payload)
      ? payload.payload.authorization.nonce
      : undefined;
    return this.request<SettleResponse>("/api/v1/settle", request, idempotencyKey);
  }

  async checkHealth(): Promise<boolean> {
    const maxRetries = this.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);
        try {
          const response = await this.fetchFn(`${this.baseUrl}/api/v1/health`, {
            method: "GET",
            signal: controller.signal,
          });
          return response.ok;
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        if (attempt >= maxRetries) return false;
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return false;
  }

  /** Expose for tests — assert facilitator JSON shape. */
  buildFacilitatorBody(payload: PaymentPayload, requirements: PaymentRequirements): B402FacilitatorRequest {
    return toFacilitatorRequest(payload, requirements, this.relayerContract);
  }

  getRelayerContract(): string {
    return this.relayerContract;
  }

  private async request<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const maxRetries = this.maxRetries;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.singleRequest<T>(path, body, idempotencyKey);
      } catch (error) {
        lastError = error;
        if (error instanceof B402FacilitatorError) {
          if (error.statusCode !== 408 && error.statusCode < 500) throw error;
        }
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  private async singleRequest<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text();
        }
        throw new B402FacilitatorError(
          `Facilitator ${path} returned HTTP ${response.status}`,
          response.status,
          errorBody,
        );
      }

      const data = (await response.json()) as T;
      return data;
    } catch (error) {
      if (error instanceof B402FacilitatorError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new B402FacilitatorError(`Facilitator ${path} timed out after ${this.timeoutMs}ms`, 408);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export { normalizeAddress };
