import { B402FacilitatorClient } from "./b402-client.js";
import { B402_CONFIG, type B402Config } from "../config.js";
import { NonceStore } from "./nonce-store.js";
import { SubscriptionStore } from "./subscription-store.js";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  TokenConfig,
  VerifyResponse,
} from "./types.js";
import { isTransferWithAuthorizationPayload, normalizeAddress } from "./types.js";
import { logger } from "../logger.js";

export interface PaymentChallenge {
  paymentRequired: PaymentRequired;
  nonce: string;
}

export interface PaymentServiceOptions {
  facilitator?: B402FacilitatorClient;
  nonceStore?: NonceStore;
  subscriptionStore?: SubscriptionStore | null;
  config?: B402Config;
}

export class PaymentService {
  private readonly facilitator: B402FacilitatorClient;
  private readonly nonceStore: NonceStore;
  private readonly subscriptionStore: SubscriptionStore | null;
  private readonly config: B402Config;

  constructor(options: PaymentServiceOptions = {}) {
    this.config = options.config ?? B402_CONFIG;
    this.facilitator =
      options.facilitator ??
      new B402FacilitatorClient({
        baseUrl: this.config.facilitatorUrl,
        relayerContract: this.config.relayer,
      });
    this.nonceStore = options.nonceStore ?? new NonceStore();
    this.subscriptionStore = options.subscriptionStore ?? null;
  }

  getConfig(): B402Config {
    return this.config;
  }

  getNonceStore(): NonceStore {
    return this.nonceStore;
  }

  getSubscriptionStore(): SubscriptionStore | null {
    return this.subscriptionStore;
  }

  /** Seller payee — never the relayer. Fail closed when payments enabled and unset. */
  getSellerPayTo(): string {
    const payTo = this.config.payTo?.trim() ?? "";
    if (!payTo) {
      throw new Error("B402_PAY_TO (seller payee) is not configured");
    }
    if (normalizeAddress(payTo) === normalizeAddress(this.config.relayer)) {
      throw new Error("B402_PAY_TO must not equal the relayer contract");
    }
    return payTo;
  }

  createSubscription(nonce: string, initialBalance: number, ttlSeconds: number, payer?: string): void {
    if (!this.subscriptionStore) throw new Error("SubscriptionStore is not configured");
    this.subscriptionStore.createSubscription(nonce, initialBalance, ttlSeconds, payer);
  }

  verifySubscription(nonce: string, payer?: string): { valid: boolean; remaining: number } {
    if (!this.subscriptionStore) return { valid: false, remaining: 0 };
    const sub = this.subscriptionStore.getSubscription(nonce);
    if (!sub) return { valid: false, remaining: 0 };
    if (Date.now() > sub.expires_at) return { valid: false, remaining: 0 };
    if (sub.remaining_balance <= 0) return { valid: false, remaining: 0 };
    if (payer && sub.payer && normalizeAddress(sub.payer) !== normalizeAddress(payer)) {
      return { valid: false, remaining: 0 };
    }
    return { valid: true, remaining: sub.remaining_balance };
  }

  deductSubscription(nonce: string): { success: boolean; remaining: number } {
    if (!this.subscriptionStore) return { success: false, remaining: 0 };
    return this.subscriptionStore.deduct(nonce);
  }

  verifyAndDeductSubscription(nonce: string, payer?: string): { valid: boolean; remaining: number } {
    if (!this.subscriptionStore) return { valid: false, remaining: 0 };
    if (payer) {
      const sub = this.subscriptionStore.getSubscription(nonce);
      if (sub?.payer && normalizeAddress(sub.payer) !== normalizeAddress(payer)) {
        return { valid: false, remaining: 0 };
      }
    }
    return this.subscriptionStore.verifyAndDeduct(nonce);
  }

  scheduleSubscriptionCleanup(intervalMs: number): { stop: () => void } {
    if (!this.subscriptionStore) {
      return { stop: () => undefined };
    }
    const interval = setInterval(() => {
      const cutoff = Date.now();
      this.subscriptionStore!.cleanupExpired(cutoff);
    }, intervalMs);
    interval.unref();
    return { stop: () => clearInterval(interval) };
  }

  scheduleNonceCleanup(intervalMs: number): { stop: () => void } {
    const interval = setInterval(() => {
      const cutoff = Date.now() - this.config.validityWindowSeconds * 1000;
      this.nonceStore.cleanupExpired(cutoff);
    }, intervalMs);
    interval.unref();
    return { stop: () => clearInterval(interval) };
  }

  createPaymentChallenge(resourceUrl: string, description: string, expectedAmount: string): PaymentChallenge {
    const seller = this.getSellerPayTo();
    const nonce = this.nonceStore.generateNonce();
    const now = Math.floor(Date.now() / 1000);
    const validBefore = now + this.config.validityWindowSeconds;

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: {
        url: resourceUrl,
        description,
        mimeType: "application/json",
      },
      accepts: [
        this.buildRequirements(this.config.tokens.usdt, expectedAmount, seller),
        this.buildRequirements(this.config.tokens.usdc, expectedAmount, seller),
      ],
    };

    paymentRequired.accepts[0]!.extra = {
      ...paymentRequired.accepts[0]!.extra,
      nonce,
      validAfter: 0,
      validBefore,
    };
    paymentRequired.accepts[1]!.extra = {
      ...paymentRequired.accepts[1]!.extra,
      nonce,
      validAfter: 0,
      validBefore,
    };

    return { paymentRequired, nonce };
  }

  private buildRequirements(token: TokenConfig, amount: string, seller: string): PaymentRequirements {
    return {
      scheme: "exact",
      network: this.config.network,
      asset: token.address,
      payTo: seller,
      amount,
      maxTimeoutSeconds: this.config.validityWindowSeconds,
      extra: {
        // B402 Relayer EIP-712 domain — NOT token EIP-3009
        name: "B402",
        version: "1",
        chainId: this.config.chainId,
        verifyingContract: this.config.relayer,
        relayerContract: this.config.relayer,
        assetTransferMethod: token.assetTransferMethod,
        token: token.address,
        typedDataIncludesToken: true,
      },
    };
  }

  async verifyPayment(payload: PaymentPayload, expectedAmount: string): Promise<VerifyResponse> {
    if (payload.x402Version !== 2) {
      return {
        isValid: false,
        invalidReason: "invalid_x402_version",
        invalidMessage: `Unsupported x402 version ${payload.x402Version}, expected 2`,
      };
    }

    let seller: string;
    try {
      seller = this.getSellerPayTo();
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "seller_not_configured",
        invalidMessage: error instanceof Error ? error.message : "Seller payTo not configured",
      };
    }

    if (!payload.accepted || typeof payload.accepted !== "object") {
      return {
        isValid: false,
        invalidReason: "missing_payment_requirements",
        invalidMessage: "Payment payload missing accepted requirements",
      };
    }

    const accepted = this.validateAcceptedToken(payload.accepted);
    if (!accepted) {
      return {
        isValid: false,
        invalidReason: "token_not_accepted",
        invalidMessage: `Token ${payload.accepted.asset ?? "unknown"} is not accepted by this server`,
      };
    }

    if (payload.accepted.amount !== expectedAmount) {
      return {
        isValid: false,
        invalidReason: "invalid_amount",
        invalidMessage: `Payment amount ${payload.accepted.amount} does not match required amount ${expectedAmount}`,
      };
    }

    if (normalizeAddress(payload.accepted.payTo) !== normalizeAddress(seller)) {
      return {
        isValid: false,
        invalidReason: "payTo_mismatch",
        invalidMessage: `Payment payTo ${payload.accepted.payTo} does not match seller ${seller}`,
      };
    }

    if (payload.accepted.network !== this.config.network) {
      return {
        isValid: false,
        invalidReason: "network_mismatch",
        invalidMessage: `Payment network ${payload.accepted.network} does not match required network ${this.config.network}`,
      };
    }

    if (payload.accepted.scheme !== "exact") {
      return {
        isValid: false,
        invalidReason: "invalid_scheme",
        invalidMessage: `Payment scheme ${payload.accepted.scheme} is not supported (expected "exact")`,
      };
    }

    if (!isTransferWithAuthorizationPayload(payload.payload)) {
      return {
        isValid: false,
        invalidReason: "invalid_payment_payload",
        invalidMessage: "Payment payload must be a valid B402 TransferWithAuthorization",
      };
    }

    const auth = payload.payload.authorization;
    const now = Math.floor(Date.now() / 1000);
    const validAfter = Number(auth.validAfter);
    const validBefore = Number(auth.validBefore);
    if (!Number.isFinite(validAfter) || now < validAfter) {
      return {
        isValid: false,
        invalidReason: "authorization_not_yet_valid",
        invalidMessage: "Authorization is not yet valid (validAfter has not passed)",
      };
    }
    if (!Number.isFinite(validBefore) || now > validBefore) {
      return {
        isValid: false,
        invalidReason: "authorization_expired",
        invalidMessage: "Authorization has expired (validBefore has passed)",
      };
    }

    // PAY-C4: bind authorization.value / to / token before facilitator
    try {
      if (BigInt(auth.value) !== BigInt(expectedAmount)) {
        return {
          isValid: false,
          invalidReason: "authorization_value_mismatch",
          invalidMessage: `Authorization value ${auth.value} does not match expected amount ${expectedAmount}`,
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: "authorization_value_invalid",
        invalidMessage: "Authorization value is not a valid integer amount",
      };
    }

    if (normalizeAddress(auth.to) !== normalizeAddress(seller)) {
      return {
        isValid: false,
        invalidReason: "authorization_to_mismatch",
        invalidMessage: `Authorization to ${auth.to} does not match seller ${seller}`,
      };
    }

    const asset = payload.accepted.asset;
    if (auth.token && normalizeAddress(auth.token) !== normalizeAddress(asset)) {
      return {
        isValid: false,
        invalidReason: "authorization_token_mismatch",
        invalidMessage: `Authorization token ${auth.token} does not match accepted asset ${asset}`,
      };
    }

    const nonce = this.extractNonce(payload);
    if (nonce !== undefined) {
      const maxAgeMs = this.config.validityWindowSeconds * 1000;
      if (!this.nonceStore.isNonceValid(nonce, maxAgeMs)) {
        let reason: string;
        let message: string;
        if (!this.nonceStore.hasNonce(nonce)) {
          reason = "nonce_unknown";
          message = "Nonce was not generated by this server";
        } else if (this.nonceStore.isNonceUsed(nonce)) {
          reason = "nonce_reused";
          message = "Nonce has already been used";
        } else {
          reason = "nonce_expired";
          message = "Nonce has expired";
        }
        return {
          isValid: false,
          invalidReason: reason,
          invalidMessage: message,
        };
      }
    }

    const response = await this.facilitator.verify(payload, payload.accepted);

    if (response.isValid !== true) {
      logger.info(`Facilitator verification failed; nonce not consumed: ${nonce?.substring(0, 10) ?? "none"}...`);
      return { ...response, isValid: false };
    }

    if (nonce !== undefined) {
      const maxAgeMs = this.config.validityWindowSeconds * 1000;
      const consumeResult = this.nonceStore.consumeNonce(nonce, maxAgeMs);
      if (!consumeResult.success) {
        logger.warn(`Nonce consumed by concurrent request: ${nonce.substring(0, 10)}...`);
        return {
          isValid: false,
          invalidReason: "nonce_reused",
          invalidMessage: "Nonce was consumed by a concurrent request",
        };
      }
      logger.info(`Nonce consumed after successful verification: ${nonce.substring(0, 10)}...`);
    }

    return { ...response, isValid: true };
  }

  async settlePayment(payload: PaymentPayload): Promise<SettleResponse> {
    // Fail closed if seller unset when settling
    this.getSellerPayTo();
    return this.facilitator.settle(payload, payload.accepted);
  }

  async checkFacilitatorHealth(): Promise<boolean> {
    return this.facilitator.checkHealth();
  }

  close(): void {
    this.nonceStore.close();
    this.subscriptionStore?.close();
  }

  private extractNonce(payload: PaymentPayload): string | undefined {
    if (!isTransferWithAuthorizationPayload(payload.payload)) return undefined;
    return payload.payload.authorization.nonce;
  }

  private validateAcceptedToken(requirements: PaymentRequirements): boolean {
    if (!requirements.asset || typeof requirements.asset !== "string") return false;
    const acceptedTokens = [
      this.config.tokens.usdt.address.toLowerCase(),
      this.config.tokens.usdc.address.toLowerCase(),
    ];
    return acceptedTokens.includes(requirements.asset.toLowerCase());
  }
}
