import type { NextFunction, Request, Response } from "express";
import { B402FacilitatorError } from "./b402-client.js";
import { B402_CONFIG, type B402Config } from "../config.js";
import type { PaymentService } from "./payment-service.js";
import type { RateLimitStore } from "./rate-limit-store.js";
import type { SubscriptionStore } from "./subscription-store.js";
import type { PaymentPayload, VerifyResponse, SettleResponse } from "./types.js";
import { logger } from "../logger.js";

export type PriceResolver = string | ((req: Request) => string);

export interface PaymentMiddlewareOptions {
  description?: string;
  price?: PriceResolver;
  config?: B402Config;
  rateLimiter?: RateLimitStore;
  subscriptionStore?: SubscriptionStore;
  trustProxy?: boolean;
  skipSubscriptionCheck?: boolean;
  /** Override: when false, skip 402 entirely. Defaults to config.paymentsEnabled. */
  paymentsEnabled?: boolean;
}

export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

function encodeBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

function decodeBase64<T>(headerValue: string): T {
  const decoded = Buffer.from(headerValue, "base64").toString("utf-8");
  return JSON.parse(decoded) as T;
}

function extractNonceFromPayload(payload: PaymentPayload): string | undefined {
  const extraNonce = (payload.accepted as { extra?: { nonce?: string } } | undefined)?.extra?.nonce;
  if (typeof extraNonce === "string" && extraNonce.length > 0) return extraNonce;
  const auth = payload.payload?.authorization;
  if (auth && typeof auth === "object" && typeof (auth as { nonce?: string }).nonce === "string") {
    return (auth as { nonce: string }).nonce;
  }
  return undefined;
}

function extractPayerHint(payload: PaymentPayload): string | undefined {
  const auth = payload.payload?.authorization;
  if (auth && typeof auth === "object" && typeof (auth as { from?: string }).from === "string") {
    return (auth as { from: string }).from;
  }
  return undefined;
}

export function getClientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.get("x-forwarded-for");
    if (forwarded) {
      return forwarded.split(",")[0]!.trim();
    }
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function buildResourceUrl(req: Request): string {
  const host = req.get("host") ?? "localhost:3000";
  const protocol = req.protocol ?? "http";
  return `${protocol}://${host}${req.originalUrl}`;
}

function isFreePrice(price: string): boolean {
  try {
    return BigInt(price) === 0n;
  } catch {
    return price === "0" || price === "";
  }
}

function send402(
  req: Request,
  res: Response,
  paymentService: PaymentService,
  description: string,
  price: string,
  error?: string,
): void {
  const resourceUrl = buildResourceUrl(req);
  const challenge = paymentService.createPaymentChallenge(resourceUrl, description, price);
  logger.info(
    `402 challenge issued: path=${req.originalUrl} ip=${getClientIp(req, false)}`,
    error ? { error } : undefined,
  );
  res.setHeader("Content-Type", "application/json");
  res.setHeader(PAYMENT_REQUIRED_HEADER, encodeBase64(challenge.paymentRequired));
  if (error) {
    res.status(402).json({
      error,
      payment_required: challenge.paymentRequired,
    });
  } else {
    res.status(402).json(challenge.paymentRequired);
  }
}

export function paymentMiddleware(paymentService: PaymentService, options: PaymentMiddlewareOptions = {}) {
  const description = options.description ?? "Market intelligence volatility feed";
  const priceResolver: PriceResolver = options.price ?? B402_CONFIG.price.atomic;
  const rateLimiter = options.rateLimiter;
  const subscriptionStore = options.subscriptionStore ?? paymentService.getSubscriptionStore();
  const trustProxy = options.trustProxy ?? false;
  const skipSubscriptionCheck = options.skipSubscriptionCheck ?? false;
  const config = options.config ?? paymentService.getConfig();
  const paymentsEnabled = options.paymentsEnabled ?? config.paymentsEnabled;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const price = typeof priceResolver === "function" ? priceResolver(req) : priceResolver;

    // Payments disabled or price atomic 0: skip 402 entirely.
    // Do NOT attempt facilitator settle with amount 0.
    if (!paymentsEnabled || isFreePrice(price)) {
      logger.info(
        `Payment skipped (free mode): path=${req.originalUrl} paymentsEnabled=${paymentsEnabled} price=${price}`,
      );
      res.setHeader(
        PAYMENT_RESPONSE_HEADER,
        encodeBase64({
          success: true,
          free_mode: true,
          payments_enabled: paymentsEnabled,
          amount: "0",
          network: config.network,
        }),
      );
      next();
      return;
    }

    if (rateLimiter) {
      const ip = getClientIp(req, trustProxy);
      const result = rateLimiter.check(ip);
      if (!result.allowed) {
        logger.warn(`Rate limited: ip=${ip}`);
        const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
        res.setHeader("Retry-After", Math.max(0, retryAfter).toString());
        res.setHeader("Content-Type", "application/json");
        res.status(429).json({
          error: "Too Many Requests",
          message: "Rate limit exceeded. Please retry later.",
          retry_after_seconds: Math.max(0, retryAfter),
        });
        return;
      }
    }

    const signatureHeader = req.get(PAYMENT_SIGNATURE_HEADER);

    if (!signatureHeader) {
      send402(req, res, paymentService, description, price);
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = decodeBase64<PaymentPayload>(signatureHeader);
    } catch {
      send402(req, res, paymentService, description, price, "Invalid payment signature format");
      return;
    }

    if (subscriptionStore && !skipSubscriptionCheck) {
      const subNonce = extractNonceFromPayload(payload);
      if (subNonce) {
        const payerHint = extractPayerHint(payload);
        const subResult = paymentService.verifyAndDeductSubscription(subNonce, payerHint);
        if (subResult.valid) {
          logger.info(`Subscription used: nonce=${subNonce.substring(0, 10)}... remaining=${subResult.remaining}`);
          res.setHeader(
            PAYMENT_RESPONSE_HEADER,
            encodeBase64({
              success: true,
              subscription_nonce: subNonce,
              remaining_balance: subResult.remaining,
              network: config.network,
            }),
          );
          next();
          return;
        }
      }
    }

    let verifyResponse: VerifyResponse;
    try {
      verifyResponse = await paymentService.verifyPayment(payload, price);
    } catch (error) {
      if (error instanceof B402FacilitatorError) {
        logger.warn(`Payment verification error: ${error.message}`, {
          statusCode: error.statusCode,
          response: error.response,
        });
      } else {
        logger.warn(`Payment verification error: ${error instanceof Error ? error.message : String(error)}`);
      }
      send402(req, res, paymentService, description, price, "Payment verification failed");
      return;
    }

    if (verifyResponse.isValid !== true) {
      send402(req, res, paymentService, description, price, verifyResponse.invalidReason ?? "Payment invalid");
      return;
    }

    let settleResponse: SettleResponse;
    try {
      settleResponse = await paymentService.settlePayment(payload);
    } catch (error) {
      if (error instanceof B402FacilitatorError) {
        logger.warn(`Payment settlement error: ${error.message}`, {
          statusCode: error.statusCode,
          response: error.response,
        });
      } else {
        logger.warn(`Payment settlement error: ${error instanceof Error ? error.message : String(error)}`);
      }
      send402(req, res, paymentService, description, price, "Payment settlement failed");
      return;
    }

    if (settleResponse.success !== true) {
      send402(
        req,
        res,
        paymentService,
        description,
        price,
        settleResponse.errorMessage ?? settleResponse.errorReason ?? "Payment settlement failed",
      );
      return;
    }

    res.setHeader(PAYMENT_RESPONSE_HEADER, encodeBase64(settleResponse));

    next();
  };
}
