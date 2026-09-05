import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import swaggerUi from "swagger-ui-express";
import { B402_CONFIG, SECONDARY_VENUE_CONFIG, assertPaymentConfig } from "./config.js";
import { BinanceMcpClient, assertValidInterval } from "./mcp-client.js";
import { CvmsScorer, DEFAULT_CVMS_CONFIG } from "./cvms.js";
import { MarketDataCache } from "./market-cache.js";
import { PaymentService } from "./payment/payment-service.js";
import { RateLimitStore } from "./payment/rate-limit-store.js";
import { paymentMiddleware, getClientIp } from "./payment/middleware.js";
import { TreasuryService } from "./payment/treasury-service.js";
import { NonceStore } from "./payment/nonce-store.js";
import { TreasuryStore } from "./payment/treasury-store.js";
import { SubscriptionStore } from "./payment/subscription-store.js";
import { ScoreHistoryStore } from "./score-history-store.js";
import type { PricingConfig } from "./config.js";
import type { CvmsScore } from "./types.js";
import { logger } from "./logger.js";
import { INTEL_DISCLAIMER, withDisclaimer } from "./disclaimer.js";
import {
  BinanceFuturesContrastClient,
  NullVenueContrastClient,
  extractBinanceMid,
  type VenueContrastClient,
} from "./venue-contrast.js";

const MAX_BATCH_SYMBOLS = 100;

const OPENAPI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "openapi.yaml");

function loadOpenApiYaml(): string {
  return readFileSync(OPENAPI_PATH, "utf8");
}

let cachedOpenApiJson: object | null = null;
function loadOpenApiJson(): object {
  if (cachedOpenApiJson) return cachedOpenApiJson;
  cachedOpenApiJson = parseYaml(loadOpenApiYaml()) as object;
  return cachedOpenApiJson;
}

function enrichScoreProvenance(score: CvmsScore): CvmsScore & { age: number } {
  return {
    ...score,
    age: score.data_age_ms,
    sources: score.sources ?? [],
    data_age_ms: score.data_age_ms ?? 0,
    confidence_score: score.confidence_score ?? 0,
  };
}

function computeHistoryPrice(limit: number, pricing: PricingConfig): string {
  const perRecord = BigInt(pricing.historyPerRecordAtomic);
  const total = BigInt(limit) * perRecord;
  const min = BigInt(pricing.historyMinAtomic);
  return (total > min ? total : min).toString();
}

function computeBatchPrice(numSymbols: number, pricing: PricingConfig): string {
  const count = Math.max(Math.min(numSymbols, MAX_BATCH_SYMBOLS), 1);
  const perSymbol = BigInt(pricing.batchPerSymbolAtomic);
  return (BigInt(count) * perSymbol).toString();
}

function resolveBatchSymbols(req: Request): string[] {
  const raw = (req.body as { symbols?: unknown } | undefined)?.symbols;
  if (!Array.isArray(raw)) return [];
  const capped = raw.slice(0, MAX_BATCH_SYMBOLS);
  const validated: string[] = [];
  for (const s of capped) {
    if (typeof s === "string" && /^[A-Za-z0-9]{3,20}$/.test(s)) {
      validated.push(s.toUpperCase());
    }
  }
  return [...new Set(validated)];
}

function safeRecordScore(store: ScoreHistoryStore, symbol: string, score: CvmsScore): void {
  try {
    store.recordScore(symbol, score, score.sources, score.confidence_score, score.data_age_ms);
  } catch (error) {
    logger.warn(
      `Failed to record score history for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildCorrelationMatrix(scores: number[][]): number[][] {
  const n = scores.length;
  if (n === 0) return [];
  const matrix: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        row.push(1);
      } else {
        row.push(clamp(-1, 1, correlation(scores[i]!, scores[j]!)));
      }
    }
    matrix.push(row);
  }
  return matrix;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const arrA = a.slice(0, n);
  const arrB = b.slice(0, n);
  const meanA = arrA.reduce((s, v) => s + v, 0) / n;
  const meanB = arrB.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = arrA[i]! - meanA;
    const db = arrB[i]! - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denom = Math.sqrt(denA * denB);
  if (denom === 0) return 0;
  return num / denom;
}

function clamp(min: number, max: number, value: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function parseIntervalOrThrow(interval: unknown, fallback = "1h"): string {
  const value = typeof interval === "string" && interval.length > 0 ? interval : fallback;
  assertValidInterval(value);
  return value;
}

export interface CreateAppOptions {
  client?: BinanceMcpClient;
  scorer?: CvmsScorer;
  paymentService?: PaymentService;
  rateLimiter?: RateLimitStore;
  treasuryService?: TreasuryService;
  cache?: MarketDataCache;
  subscriptionStore?: SubscriptionStore;
  scoreHistoryStore?: ScoreHistoryStore;
  adminApiKey?: string;
  nonceCleanupIntervalMs?: number;
  subscriptionCleanupIntervalMs?: number;
  historyCleanupIntervalMs?: number;
  dbPath?: string;
  trustProxy?: boolean;
  corsOrigins?: string[];
  venueContrast?: VenueContrastClient;
}

export function safeApiKeyCompare(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createApp(options: CreateAppOptions = {}) {
  const dbPath = options.dbPath ?? process.env.DATABASE_PATH ?? ":memory:";
  const client = options.client ?? new BinanceMcpClient({ authToken: process.env.BINANCE_MCP_AUTH_TOKEN });
  const scorer = options.scorer ?? new CvmsScorer();
  const subscriptionStore = options.subscriptionStore ?? new SubscriptionStore(dbPath);
  const scoreHistoryStore = options.scoreHistoryStore ?? new ScoreHistoryStore(dbPath);
  const paymentService =
    options.paymentService ?? new PaymentService({ nonceStore: new NonceStore(dbPath), subscriptionStore });
  const rateLimiter = options.rateLimiter ?? new RateLimitStore({ config: B402_CONFIG.rateLimit, dbPath });
  const treasuryService = options.treasuryService ?? new TreasuryService({ store: new TreasuryStore(dbPath) });
  assertPaymentConfig(B402_CONFIG);
  const cache =
    options.cache ?? new MarketDataCache(DEFAULT_CVMS_CONFIG.dataTtlSeconds, 100, B402_CONFIG.cacheMaxStaleSeconds);
  const adminApiKey = options.adminApiKey;
  const trustProxy = options.trustProxy ?? false;
  const corsOrigins = options.corsOrigins;
  const isTestRuntime = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const venueContrast: VenueContrastClient =
    options.venueContrast ??
    (isTestRuntime
      ? new NullVenueContrastClient()
      : new BinanceFuturesContrastClient(
          {
            enabled: SECONDARY_VENUE_CONFIG.enabled,
            timeoutMs: SECONDARY_VENUE_CONFIG.timeoutMs,
          },
          client,
        ));

  const app = express();
  app.set("trust proxy", trustProxy);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    next();
  });

  if (corsOrigins) {
    app.use((req, res, next) => {
      const origin = req.get("origin");
      if (origin && corsOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, payment-signature, x-api-key");
      }
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      logger.info(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  app.use(express.json({ limit: "10kb" }));

  // Liveness only — Render (and other hosts) probe this path. Deep dependency
  // checks live on GET /api/v1/ready so a broken facilitator cannot block deploy.
  app.get("/health", (_request, response) => {
    response.status(200).json({ ok: true, status: "alive" });
  });

  app.get("/api/v1/ready", async (_request, response) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      const connected = client.isConnected();
      checks.mcp = {
        ok: connected,
        detail: connected ? "connected" : "not_connected",
      };
    } catch (e: unknown) {
      checks.mcp = { ok: false, detail: e instanceof Error ? e.message : "mcp_check_failed" };
    }

    try {
      const facilitatorOk = await paymentService.checkFacilitatorHealth();
      checks.facilitator = {
        ok: facilitatorOk,
        detail: facilitatorOk ? "reachable" : "unreachable",
      };
    } catch (e: unknown) {
      checks.facilitator = { ok: false, detail: e instanceof Error ? e.message : "facilitator_check_failed" };
    }

    const ready = Object.values(checks).every((c) => c.ok);
    response.status(ready ? 200 : 503).json({
      ready,
      checks,
      checked_at: Date.now(),
    });
  });

  app.get("/api/v1/openapi.yaml", (_request, response) => {
    try {
      const yamlText = loadOpenApiYaml();
      response.type("application/yaml").send(yamlText);
    } catch (error) {
      logger.error(error);
      response.status(500).json({ error: "OpenAPI spec unavailable" });
    }
  });

  app.get("/api/v1/openapi.json", (_request, response) => {
    try {
      const yamlText = loadOpenApiYaml();
      const doc = parseYaml(yamlText);
      response.json(doc);
    } catch (error) {
      logger.error(error);
      response.status(500).json({ error: "OpenAPI spec unavailable" });
    }
  });

  // Swagger UI — interactive docs at /docs (free, unauthenticated discovery)
  app.use("/docs", (_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    );
    next();
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(loadOpenApiJson(), { customSiteTitle: "Agent Broker API" }));

  app.get(
    "/api/v1/market-intelligence/volatility",
    (request, response, next) => {
      try {
        const interval = typeof request.query.interval === "string" ? request.query.interval : "1h";
        assertValidInterval(interval);
        const limitRaw = typeof request.query.limit === "string" ? request.query.limit : "24";
        const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 24, 1), 1_000);
        (request as Request & { validatedInterval?: string; validatedLimit?: number }).validatedInterval = interval;
        (request as Request & { validatedInterval?: string; validatedLimit?: number }).validatedLimit = limit;
        next();
      } catch (error) {
        response.status(400).json({ error: error instanceof Error ? error.message : "Invalid interval or limit" });
      }
    },
    paymentMiddleware(paymentService, { rateLimiter, subscriptionStore, trustProxy }),
    async (request, response) => {
      const symbol = typeof request.query.symbol === "string" ? request.query.symbol.toUpperCase() : "BTCUSDT";
      const interval =
        (request as Request & { validatedInterval?: string }).validatedInterval ??
        (typeof request.query.interval === "string" ? request.query.interval : "1h");
      const candleLimit =
        (request as Request & { validatedLimit?: number }).validatedLimit ??
        Math.min(
          Math.max(parseInt(typeof request.query.limit === "string" ? request.query.limit : "24", 10) || 24, 1),
          1_000,
        );
      try {
        const snapshot = await client.getMarketSnapshot(symbol, interval, candleLimit);
        cache.set(symbol, snapshot);
        const score = enrichScoreProvenance(scorer.score(snapshot));
        safeRecordScore(scoreHistoryStore, symbol, score);
        const binanceMid = extractBinanceMid(snapshot.ticker);
        const contrast = await venueContrast.fetchContrast(symbol, binanceMid);
        response.json(
          withDisclaimer({
            ...score,
            ...(contrast ? { contrast } : {}),
          }),
        );
      } catch (error) {
        const cached = cache.getFreshOrStale(symbol);
        if (cached) {
          const score = enrichScoreProvenance(scorer.score(cached.snapshot));
          safeRecordScore(scoreHistoryStore, symbol, score);
          const binanceMid = extractBinanceMid(cached.snapshot.ticker);
          const contrast = await venueContrast.fetchContrast(symbol, binanceMid);
          response.json(
            withDisclaimer({
              ...score,
              stale: true,
              ...(contrast ? { contrast } : {}),
            }),
          );
          return;
        }
        response.status(503).json({ error: error instanceof Error ? error.message : "Market data unavailable" });
      }
    },
  );

  app.post("/api/v1/treasury/withdraw", async (request: Request, response: Response) => {
    if (!adminApiKey) {
      response.status(503).json({ error: "Admin endpoints not configured" });
      return;
    }
    const apiKey = request.get("x-api-key");
    if (!safeApiKeyCompare(apiKey, adminApiKey)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (rateLimiter) {
      const ip = getClientIp(request, trustProxy);
      const result = rateLimiter.check(ip);
      if (!result.allowed) {
        logger.warn(`Admin endpoint rate limited: ip=${ip}`);
        const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
        response.setHeader("Retry-After", Math.max(0, retryAfter).toString());
        response.setHeader("Content-Type", "application/json");
        response.status(429).json({
          error: "Too Many Requests",
          message: "Rate limit exceeded.",
          retry_after_seconds: Math.max(0, retryAfter),
        });
        return;
      }
    }

    const { amount, token, destination, signature } = request.body as {
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
      response.status(403).json({
        error: "Withdrawal rejected",
        reason: check.reason,
        message: check.message,
      });
      return;
    }

    treasuryService.recordWithdrawal(amount, token, destination, signature);
    logger.info(`Treasury withdrawal recorded: amount=${amount} token=${token} destination=${destination}`);

    response.json({
      status: "pending",
      amount,
      token,
      destination,
      daily_spent: treasuryService.getDailySpent(token).toString(),
    });
  });

  app.get("/api/v1/treasury/balance", (request: Request, response: Response) => {
    if (!adminApiKey) {
      response.status(503).json({ error: "Admin endpoints not configured" });
      return;
    }
    const apiKey = request.get("x-api-key");
    if (!safeApiKeyCompare(apiKey, adminApiKey)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (rateLimiter) {
      const ip = getClientIp(request, trustProxy);
      const result = rateLimiter.check(ip);
      if (!result.allowed) {
        logger.warn(`Admin endpoint rate limited: ip=${ip}`);
        const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
        response.setHeader("Retry-After", Math.max(0, retryAfter).toString());
        response.setHeader("Content-Type", "application/json");
        response.status(429).json({
          error: "Too Many Requests",
          message: "Rate limit exceeded.",
          retry_after_seconds: Math.max(0, retryAfter),
        });
        return;
      }
    }

    const withdrawals = treasuryService.getAllWithdrawals();
    response.json({
      active: B402_CONFIG.treasury.active,
      daily_limit_atomic: B402_CONFIG.treasury.dailyLimitAtomic,
      single_limit_atomic: B402_CONFIG.treasury.singleLimitAtomic,
      withdrawal_whitelist: B402_CONFIG.treasury.withdrawalWhitelist,
      token_whitelist: B402_CONFIG.treasury.tokenWhitelist,
      total_withdrawals: withdrawals.length,
    });
  });

  app.get("/api/v1/agent/info", (_request, response) => {
    const pricing = B402_CONFIG.pricing;
    response.json({
      name: "agent-to-agent-data-broker",
      version: "0.1.0",
      product: "Binance MCP + B402 CVMS intelligence broker for agent-to-agent micropayments",
      description: "Binance MCP market intelligence broker with B402 micropayments",
      disclaimer: INTEL_DISCLAIMER,
      openapi_url: "/api/v1/openapi.yaml",
      openapi_json_url: "/api/v1/openapi.json",
      docs_url: "/docs",
      ready_url: "/api/v1/ready",
      routes: {
        free: [
          { method: "GET", path: "/health", description: "Liveness probe (process up)" },
          { method: "GET", path: "/api/v1/ready", description: "Readiness: MCP + B402 facilitator" },
          { method: "GET", path: "/api/v1/agent/info", description: "Machine-readable product catalog" },
          { method: "GET", path: "/api/v1/openapi.yaml", description: "OpenAPI 3 spec (YAML)" },
          { method: "GET", path: "/api/v1/openapi.json", description: "OpenAPI 3 spec (JSON)" },
          { method: "GET", path: "/docs", description: "Interactive Swagger UI for the API" },
        ],
        paid: [
          {
            method: "GET",
            path: "/api/v1/market-intelligence/volatility",
            price_atomic: B402_CONFIG.paymentsEnabled ? B402_CONFIG.price.atomic : "0",
            price_decimal: B402_CONFIG.paymentsEnabled ? B402_CONFIG.price.decimal : "0",
            description: "Single-symbol CVMS volatility & momentum score",
          },
          {
            method: "GET",
            path: "/api/v1/market-intelligence/volatility/history",
            price_atomic: B402_CONFIG.paymentsEnabled ? "variable" : "0",
            price_detail: "0.01 USDT per record, min 1 USDT",
            description: "Historical CVMS time series with provenance",
          },
          {
            method: "POST",
            path: "/api/v1/market-intelligence/volatility/batch",
            price_atomic: B402_CONFIG.paymentsEnabled ? "variable" : "0",
            price_detail: "0.04 USDT per symbol",
            description: "Batch CVMS scores",
          },
          {
            method: "POST",
            path: "/api/v1/market-intelligence/portfolio/risk",
            price_atomic: B402_CONFIG.paymentsEnabled ? "variable" : "0",
            price_detail: "0.04 USDT per symbol",
            description: "Portfolio risk, correlation, concentration",
          },
          {
            method: "POST",
            path: "/api/v1/subscription",
            price_atomic: B402_CONFIG.paymentsEnabled ? pricing.subscriptionAtomic : "0",
            description: "Purchase request credits (real payment only; cannot farm via existing sub balance)",
          },
        ],
      },
      signals: [
        {
          name: "cvms_volatility",
          endpoint: "GET /api/v1/market-intelligence/volatility",
          price_atomic: B402_CONFIG.paymentsEnabled ? B402_CONFIG.price.atomic : "0",
          description: "Composite Volatility & Momentum Score (CVMS) for a single symbol",
        },
        {
          name: "cvms_history",
          endpoint: "GET /api/v1/market-intelligence/volatility/history",
          price_atomic: B402_CONFIG.paymentsEnabled ? "variable" : "0",
          price_detail: "0.01 USDT per record, min 1 USDT",
          description: "Historical CVMS time series with provenance metadata",
        },
        {
          name: "cvms_batch",
          endpoint: "POST /api/v1/market-intelligence/volatility/batch",
          price_atomic: B402_CONFIG.paymentsEnabled ? "variable" : "0",
          price_detail: "0.04 USDT per symbol",
          description: "Batch CVMS scores for multiple symbols",
        },
        {
          name: "portfolio_risk",
          endpoint: "POST /api/v1/market-intelligence/portfolio/risk",
          price_atomic: B402_CONFIG.paymentsEnabled ? "variable" : "0",
          price_detail: "0.04 USDT per symbol",
          description: "Portfolio-level risk metrics including correlation matrix and concentration warnings",
        },
      ],
      networks: {
        caip2: B402_CONFIG.network,
        facilitator_network: B402_CONFIG.facilitatorNetwork,
        chain_id: B402_CONFIG.chainId,
        facilitator: B402_CONFIG.facilitatorUrl,
        relayer: B402_CONFIG.relayer,
        payTo: B402_CONFIG.payTo,
      },
      assets: [
        {
          symbol: B402_CONFIG.tokens.usdt.symbol,
          address: B402_CONFIG.tokens.usdt.address,
          decimals: B402_CONFIG.tokens.usdt.decimals,
        },
        {
          symbol: B402_CONFIG.tokens.usdc.symbol,
          address: B402_CONFIG.tokens.usdc.address,
          decimals: B402_CONFIG.tokens.usdc.decimals,
        },
      ],
      how_to_pay: {
        protocol: "B402 / x402 V2",
        scheme: "b402-relayer",
        eip712_domain: {
          name: "B402",
          version: "1",
          chainId: B402_CONFIG.chainId,
          verifyingContract: B402_CONFIG.relayer,
        },
        steps: [
          "Call a paid route without payment-signature → receive 402 with base64 PAYMENT-REQUIRED header",
          "Sign B402 Relayer EIP-712 TransferWithAuthorization (typed data includes token; domain name B402, verifyingContract=relayer)",
          "authorization.to and challenge payTo must be the seller (B402_PAY_TO), never the relayer",
          "Retry with base64 payment-signature header; server translates to B402 facilitator body and verifies + settles",
          "On success, response includes PAYMENT-RESPONSE and paid intelligence JSON (with disclaimer + provenance)",
          "Optional: POST /api/v1/subscription once, then reuse subscription_nonce as payment-signature to spend request credits (bound to payer when presented)",
        ],
      },
      payment: {
        payments_enabled: B402_CONFIG.paymentsEnabled,
        accepts: ["USDT", "USDC"],
        network: B402_CONFIG.network,
        facilitator_network: B402_CONFIG.facilitatorNetwork,
        payTo: B402_CONFIG.payTo,
        relayer: B402_CONFIG.relayer,
        scheme: "b402-relayer",
        subscription: {
          price_atomic: B402_CONFIG.paymentsEnabled ? pricing.subscriptionAtomic : "0",
          price_decimal: B402_CONFIG.paymentsEnabled ? "10" : "0",
          requests_included: pricing.subscriptionRequests,
          ttl_seconds: pricing.subscriptionTtlSeconds,
          endpoint: "POST /api/v1/subscription",
          remaining_balance: {
            presented_in: "PAYMENT-RESPONSE header as remaining_balance after each credited request",
            usage:
              "Send subscription_nonce inside payment-signature; one credit deducted per successful paid-route access",
          },
          anti_farming:
            "Buying a new subscription always requires a real x402 payment. Existing subscription balance cannot be spent on POST /api/v1/subscription (skipSubscriptionCheck). A successful purchase mints a fresh subscription_nonce with a full credit balance; prior balances are unchanged.",
          security_note:
            "Subscription credits are presented as a bearer nonce. When the purchase settle response includes payer, the nonce is bound to that address and later presentations should include authorization.from matching the payer. Treat leaked nonces as spendable credits.",
        },
      },
      secondary_venue: {
        enabled: SECONDARY_VENUE_CONFIG.enabled,
        venue: "binance_futures",
        note: "Binance USDT-M futures book-ticker mid vs spot mid (basis_bps); soft-fails unavailable if fetch fails",
      },
    });
  });

  app.get(
    "/api/v1/market-intelligence/volatility/history",
    paymentMiddleware(paymentService, {
      description: "Historical CVMS volatility records",
      price: (req) => {
        const limitParam = typeof req.query.limit === "string" ? req.query.limit : "100";
        const limit = Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 1_000);
        return computeHistoryPrice(limit, B402_CONFIG.pricing);
      },
      rateLimiter,
      subscriptionStore,
      trustProxy,
    }),
    async (request, response) => {
      const symbol = typeof request.query.symbol === "string" ? request.query.symbol.toUpperCase() : "BTCUSDT";
      const limit = Math.min(
        Math.max(parseInt(typeof request.query.limit === "string" ? request.query.limit : "100", 10) || 100, 1),
        1_000,
      );
      const history = scoreHistoryStore.getHistory(symbol, limit);
      const scores = history
        .map((record) => {
          try {
            return JSON.parse(record.score_json) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((s): s is Record<string, unknown> => s !== null);
      response.json(
        withDisclaimer({
          symbol,
          count: scores.length,
          scores: scores.map((s) => ({
            ...s,
            sources: Array.isArray(s.sources) ? s.sources : [],
            data_age_ms: typeof s.data_age_ms === "number" ? s.data_age_ms : 0,
            age: typeof s.data_age_ms === "number" ? s.data_age_ms : typeof s.age === "number" ? s.age : 0,
            confidence_score: typeof s.confidence_score === "number" ? s.confidence_score : 0,
          })),
        }),
      );
    },
  );

  app.post(
    "/api/v1/market-intelligence/volatility/batch",
    (request, response, next) => {
      const symbols = resolveBatchSymbols(request);
      if (symbols.length === 0) {
        response.status(400).json({ error: "No valid symbols provided" });
        return;
      }
      try {
        const body = request.body as { interval?: string; limit?: number };
        parseIntervalOrThrow(body?.interval ?? "1h");
        if (body?.limit !== undefined) {
          const limit = Number(body.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
            response.status(400).json({ error: "Kline limit must be an integer from 1 to 1000" });
            return;
          }
        }
      } catch (error) {
        response.status(400).json({ error: error instanceof Error ? error.message : "Invalid interval" });
        return;
      }
      (request as Request & { validatedBatchSymbols?: string[] }).validatedBatchSymbols = symbols;
      next();
    },
    paymentMiddleware(paymentService, {
      description: "Batch CVMS volatility scores",
      price: (req) => {
        const validated = (req as Request & { validatedBatchSymbols?: string[] }).validatedBatchSymbols;
        const symbols = validated ?? resolveBatchSymbols(req);
        return computeBatchPrice(symbols.length, B402_CONFIG.pricing);
      },
      rateLimiter,
      subscriptionStore,
      trustProxy,
    }),
    async (request, response) => {
      const body = request.body as { interval?: string; limit?: number };
      const symbols =
        (request as Request & { validatedBatchSymbols?: string[] }).validatedBatchSymbols ??
        resolveBatchSymbols(request);
      if (symbols.length === 0) {
        response.status(400).json({ error: "No valid symbols provided" });
        return;
      }
      let interval: string;
      try {
        interval = parseIntervalOrThrow(body?.interval ?? "1h");
      } catch (error) {
        response.status(400).json({ error: error instanceof Error ? error.message : "Invalid interval" });
        return;
      }
      const candleLimit = body?.limit ?? 24;

      // INTEL-C2: concurrency-limited MCP fan-out
      const snapshots = await mapPool(symbols, B402_CONFIG.mcpConcurrency, async (symbol) =>
        client.getMarketSnapshot(symbol, interval, candleLimit).catch((_e) => null),
      );

      const validSnapshots = snapshots.filter(
        (snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null,
      );

      // Residual: MCP outage after pay can still yield empty scores — prefer validate-before-pay above.
      // Full escrow/refund is not implemented in this pass.
      const scores = await mapPool(validSnapshots, Math.min(3, B402_CONFIG.mcpConcurrency), async (snapshot) => {
        const score = enrichScoreProvenance(scorer.score(snapshot));
        safeRecordScore(scoreHistoryStore, snapshot.symbol, score);
        const binanceMid = extractBinanceMid(snapshot.ticker);
        const contrast = await venueContrast.fetchContrast(snapshot.symbol, binanceMid);
        return withDisclaimer({
          ...score,
          ...(contrast ? { contrast } : {}),
        });
      });

      response.json(withDisclaimer({ count: scores.length, scores }));
    },
  );

  app.post(
    "/api/v1/market-intelligence/portfolio/risk",
    (request, response, next) => {
      const body = request.body as { symbols?: unknown; weights?: unknown; interval?: string; limit?: number };
      const rawSymbolsFull = Array.isArray(body?.symbols) ? body.symbols : [];
      const weightsFull: unknown[] = Array.isArray(body?.weights) ? body.weights : [];

      if (rawSymbolsFull.length === 0) {
        response.status(400).json({ error: "Missing required field: symbols" });
        return;
      }
      if (weightsFull.length !== rawSymbolsFull.length) {
        response.status(400).json({ error: "weights must have the same length as symbols" });
        return;
      }
      if (!rawSymbolsFull.every((s) => typeof s === "string")) {
        response.status(400).json({ error: "All symbols must be strings" });
        return;
      }
      if (!weightsFull.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0)) {
        response.status(400).json({ error: "weights must be finite non-negative numbers" });
        return;
      }
      const rawSymbols = rawSymbolsFull.slice(0, MAX_BATCH_SYMBOLS) as string[];
      const weights = weightsFull.slice(0, MAX_BATCH_SYMBOLS) as number[];
      const validatedStrings = rawSymbols.filter((s) => /^[A-Za-z0-9]{3,20}$/.test(s));
      if (validatedStrings.length === 0) {
        response.status(400).json({ error: "No valid symbols provided" });
        return;
      }
      try {
        parseIntervalOrThrow(body?.interval ?? "1h");
      } catch (error) {
        response.status(400).json({ error: error instanceof Error ? error.message : "Invalid interval" });
        return;
      }

      // Uppercase + dedupe before pricing
      const symbolWeightMap = new Map<string, number>();
      for (let i = 0; i < rawSymbols.length; i++) {
        const sym = (rawSymbols[i] as string).toUpperCase();
        if (!/^[A-Z0-9]{3,20}$/.test(sym)) continue;
        const w = weights[i]!;
        symbolWeightMap.set(sym, (symbolWeightMap.get(sym) ?? 0) + w);
      }
      if (symbolWeightMap.size === 0) {
        response.status(400).json({ error: "No valid symbols provided" });
        return;
      }
      (
        request as Request & { validatedPortfolio?: { symbols: string[]; weightMap: Map<string, number> } }
      ).validatedPortfolio = { symbols: [...symbolWeightMap.keys()], weightMap: symbolWeightMap };
      next();
    },
    paymentMiddleware(paymentService, {
      description: "Portfolio risk metrics",
      price: (req) => {
        const validated = (req as Request & { validatedPortfolio?: { symbols: string[] } }).validatedPortfolio;
        const count = validated?.symbols.length ?? 1;
        return computeBatchPrice(count, B402_CONFIG.pricing);
      },
      rateLimiter,
      subscriptionStore,
      trustProxy,
    }),
    async (request, response) => {
      const body = request.body as { interval?: string; limit?: number };
      const validated = (
        request as Request & {
          validatedPortfolio?: { symbols: string[]; weightMap: Map<string, number> };
        }
      ).validatedPortfolio;
      if (!validated || validated.symbols.length === 0) {
        response.status(400).json({ error: "No valid symbols provided" });
        return;
      }
      const symbols = validated.symbols;
      const symbolWeightMap = validated.weightMap;

      let interval: string;
      try {
        interval = parseIntervalOrThrow(body?.interval ?? "1h");
      } catch (error) {
        response.status(400).json({ error: error instanceof Error ? error.message : "Invalid interval" });
        return;
      }
      const candleLimit = body?.limit ?? 24;

      const snapshots = await mapPool(symbols, B402_CONFIG.mcpConcurrency, async (symbol) =>
        client.getMarketSnapshot(symbol, interval, candleLimit).catch((_e) => null),
      );

      const validSnapshots = snapshots.filter(
        (snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null,
      );
      const validSymbols = validSnapshots.map((s) => s.symbol);

      if (validSymbols.length === 0) {
        // Residual MCP outage after payment — documented; prefer validate-before-pay for empty input.
        response.status(503).json({
          error: "No market data available for any requested symbol",
          note: "Payment may have been settled before MCP failure; escrow/refund not implemented in this pass",
        });
        return;
      }

      const scores = validSnapshots.map((snapshot) => {
        const score = enrichScoreProvenance(scorer.score(snapshot));
        safeRecordScore(scoreHistoryStore, snapshot.symbol, score);
        return score;
      });

      const validWeights = validSymbols.map((s) => symbolWeightMap.get(s) ?? 0);
      const totalWeight = validWeights.reduce((sum, w) => sum + w, 0);
      const normalizedWeights = validWeights.map((w) => (totalWeight > 0 ? w / totalWeight : 0));
      const normalizedWeightBySymbol = new Map<string, number>();
      for (let i = 0; i < validSymbols.length; i++) {
        normalizedWeightBySymbol.set(validSymbols[i]!, normalizedWeights[i]!);
      }

      const portfolioScore = {
        symbol: "PORTFOLIO",
        timestamp: Date.now(),
        volatility_score: clamp(
          0,
          100,
          scores.reduce((sum, s) => sum + s.volatility_score * (normalizedWeightBySymbol.get(s.symbol) ?? 0), 0),
        ),
        momentum_score: clamp(
          0,
          100,
          scores.reduce((sum, s) => sum + s.momentum_score * (normalizedWeightBySymbol.get(s.symbol) ?? 0), 0),
        ),
        composite_score: clamp(
          0,
          100,
          scores.reduce((sum, s) => sum + s.composite_score * (normalizedWeightBySymbol.get(s.symbol) ?? 0), 0),
        ),
        open_interest: clamp(
          0,
          1_000_000_000_000,
          scores.reduce((sum, s) => sum + s.open_interest * (normalizedWeightBySymbol.get(s.symbol) ?? 0), 0),
        ),
        order_book_imbalance: clamp(
          -1,
          1,
          scores.reduce((sum, s) => sum + s.order_book_imbalance * (normalizedWeightBySymbol.get(s.symbol) ?? 0), 0),
        ),
        realized_volatility_24h: scores.reduce(
          (sum, s) => sum + s.realized_volatility_24h * (normalizedWeightBySymbol.get(s.symbol) ?? 0),
          0,
        ),
        data_ttl_seconds: DEFAULT_CVMS_CONFIG.dataTtlSeconds,
        sources: Array.from(new Set(scores.flatMap((s) => s.sources))),
        data_age_ms: Math.max(...scores.map((s) => s.data_age_ms), 0),
        confidence_score: Math.round(
          scores.reduce((sum, s) => sum + s.confidence_score * (normalizedWeightBySymbol.get(s.symbol) ?? 0), 0),
        ),
      };

      // Correlate log returns (not raw closes)
      const logReturns: number[][] = validSnapshots.map((s) => {
        const closes = s.klines.map((c) => c.close);
        const lr: number[] = [];
        for (let i = 1; i < closes.length; i++) {
          if (closes[i - 1]! > 0 && closes[i]! > 0) lr.push(Math.log(closes[i]! / closes[i - 1]!));
        }
        return lr;
      });
      const correlationMatrix = buildCorrelationMatrix(logReturns);

      const concentrationWarnings: Array<{ symbol: string; weight: number; message: string }> = [];
      let maxWeight = 0;
      let maxSymbol = "";
      for (let i = 0; i < validSymbols.length; i++) {
        const w = normalizedWeights[i] ?? 0;
        if (w > maxWeight) {
          maxWeight = w;
          maxSymbol = validSymbols[i] ?? "";
        }
      }
      if (maxWeight > 0.5) {
        concentrationWarnings.push({
          symbol: maxSymbol,
          weight: maxWeight,
          message: `Concentration warning: ${maxSymbol} represents ${(maxWeight * 100).toFixed(0)}% of portfolio, exceeding 50% threshold`,
        });
      }
      const diversifiedCount = normalizedWeights.filter((w) => w > 0.1).length;

      response.json(
        withDisclaimer({
          portfolio: { ...portfolioScore, age: portfolioScore.data_age_ms },
          symbols: validSymbols,
          weights: normalizedWeights,
          correlation_matrix: correlationMatrix,
          correlation_basis: "log_returns",
          concentration_warnings: concentrationWarnings,
          diversification_headroom: {
            current_diversified_positions: diversifiedCount,
            recommended_minimum: 10,
            headroom: Math.max(0, 10 - diversifiedCount),
          },
        }),
      );
    },
  );

  app.post(
    "/api/v1/subscription",
    paymentMiddleware(paymentService, {
      description: "Subscription purchase for bulk request access",
      price: B402_CONFIG.pricing.subscriptionAtomic,
      rateLimiter,
      trustProxy,
      skipSubscriptionCheck: true,
    }),
    async (_request, response) => {
      if (!paymentService.getSubscriptionStore()) {
        response.status(503).json({ error: "Subscription store not configured" });
        return;
      }

      const nonce = paymentService.getNonceStore().generateNonce();
      // PAY-H1: bind subscription to payer address when settle response exposes it
      let payer: string | undefined;
      const paymentResponseHeader = response.getHeader("PAYMENT-RESPONSE");
      if (typeof paymentResponseHeader === "string") {
        try {
          const decoded = JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString("utf-8")) as {
            payer?: string;
          };
          if (typeof decoded.payer === "string") payer = decoded.payer;
        } catch {
          payer = undefined;
        }
      }
      paymentService.createSubscription(
        nonce,
        B402_CONFIG.pricing.subscriptionRequests,
        B402_CONFIG.pricing.subscriptionTtlSeconds,
        payer,
      );

      const sub = paymentService.getSubscriptionStore()?.getSubscription(nonce);
      if (!sub) {
        response.status(503).json({ error: "Failed to create subscription" });
        return;
      }
      response.json({
        status: "active",
        subscription_nonce: nonce,
        initial_balance: B402_CONFIG.pricing.subscriptionRequests,
        remaining_balance: sub.remaining_balance,
        expires_at: sub.expires_at,
        network: B402_CONFIG.network,
      });
    },
  );

  if (options.nonceCleanupIntervalMs !== undefined) {
    paymentService.scheduleNonceCleanup(options.nonceCleanupIntervalMs);
  }

  if (options.subscriptionCleanupIntervalMs !== undefined) {
    paymentService.scheduleSubscriptionCleanup(options.subscriptionCleanupIntervalMs);
  }

  if (options.historyCleanupIntervalMs !== undefined && scoreHistoryStore) {
    scoreHistoryStore.scheduleCleanup(options.historyCleanupIntervalMs);
  }

  app.use((err: Error & { status?: number; expose?: boolean }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      logger.error(err);
      res.status(400).json({ error: "Malformed JSON in request body" });
      return;
    }
    if (err.status && err.expose) {
      logger.error(err);
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
const isTestEnv = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const shouldStartServer = isEntrypoint && !isTestEnv;

if (shouldStartServer) {
  const port = Number(process.env.PORT ?? 3000);
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
  if (!ADMIN_API_KEY) {
    logger.error("ADMIN_API_KEY environment variable is required. Exiting.");
    process.exit(1);
  }
  if (!process.env.BINANCE_MCP_AUTH_TOKEN) {
    logger.error("BINANCE_MCP_AUTH_TOKEN environment variable is required. Exiting.");
    process.exit(1);
  }
  const dbPath = process.env.DATABASE_PATH ?? ":memory:";
  const nonceStore = new NonceStore(dbPath);
  const subscriptionStore = new SubscriptionStore(dbPath);
  const scoreHistoryStore = new ScoreHistoryStore(dbPath);
  const rateLimiter = new RateLimitStore({ config: B402_CONFIG.rateLimit, dbPath });
  const treasuryStore = new TreasuryStore(dbPath);
  const paymentService = new PaymentService({ nonceStore, subscriptionStore });
  const treasuryService = new TreasuryService({ store: treasuryStore });
  const client = new BinanceMcpClient({ authToken: process.env.BINANCE_MCP_AUTH_TOKEN });
  const cleanupInterval = paymentService.scheduleNonceCleanup(60_000);
  const subscriptionCleanupInterval = paymentService.scheduleSubscriptionCleanup(60_000);
  const historyCleanupInterval = scoreHistoryStore.scheduleCleanup(60_000);
  const trustProxy = process.env.TRUST_PROXY === "true";
  const corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : undefined;

  const app = createApp({
    adminApiKey: ADMIN_API_KEY,
    client,
    paymentService,
    rateLimiter,
    treasuryService,
    subscriptionStore,
    scoreHistoryStore,
    dbPath,
    trustProxy,
    corsOrigins,
  });

  const server = app.listen(port, () => {
    logger.info(`Agent broker listening on http://localhost:${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`\nReceived ${signal}, shutting down gracefully...`);
    cleanupInterval.stop();
    subscriptionCleanupInterval.stop();
    historyCleanupInterval.stop();
    server.close(() => {
      try {
        client.close();
      } catch {
        /* client may not support close */
      }
      paymentService.close();
      rateLimiter.close();
      treasuryService.close();
      if (scoreHistoryStore) scoreHistoryStore.close();
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
