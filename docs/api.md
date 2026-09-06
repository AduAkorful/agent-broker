# API Reference

Machine contract: [`openapi.yaml`](./openapi.yaml) (also available at `GET /api/v1/openapi.yaml` and `GET /api/v1/openapi.json`).

## Free routes

All free routes are unauthenticated and return immediately without payment checks.

### GET `/health`

Liveness probe for host platforms. Returns immediately with process status. Deep dependency checks are served on `GET /api/v1/ready`.

**Response 200:**

```json
{
  "ok": true,
  "status": "alive"
}
```

### GET `/api/v1/ready`

Readiness probe: MCP connection + B402 facilitator reachability. No secrets exposed.

**Response 200:**

```json
{
  "ready": true,
  "checks": {
    "mcp": { "ok": true, "detail": "connected" },
    "facilitator": { "ok": true, "detail": "reachable" }
  },
  "checked_at": 1234567890
}
```

**Response 503:**

```json
{ "ready": false, "checks": { ... }, "checked_at": 1234567890 }
```

### GET `/api/v1/agent/info`

Machine-readable product catalog. Lists free and paid routes, pricing, network config, accepted assets, payment instructions, and subscription UX.

```json
{
  "name": "agent-to-agent-data-broker",
  "version": "0.1.0",
  "product": "Binance MCP + B402 CVMS intelligence broker for agent-to-agent micropayments",
  "routes": { "free": [...], "paid": [...] },
  "signals": [...],
  "networks": { "caip2": "eip155:56", "facilitator_network": "bsc", ... },
  "assets": [{ "symbol": "USDT", ... }, { "symbol": "USDC", ... }],
  "how_to_pay": { "protocol": "B402 / x402 V2", ... },
  "payment": { "payments_enabled": true, "accepts": ["USDT", "USDC"], ... },
  "secondary_venue": { "enabled": true, "venue": "binance_futures", ... }
}
```

### GET `/api/v1/openapi.yaml` / `.json`

Serves the OpenAPI 3 specification. YAML is raw text; JSON is parsed via the `yaml` package.

## Paid intelligence

All paid routes enforce x402 V2 payment via `paymentMiddleware`. Unauthenticated calls receive `402 Payment Required` with a base64 `PAYMENT-REQUIRED` header. Authenticated calls with valid payment receive `200` with a base64 `PAYMENT-RESPONSE` header and intelligence JSON including a disclaimer.

### GET `/api/v1/market-intelligence/volatility`

Single-symbol CVMS volatility & momentum score.

**Query parameters:**

| Param      | Type   | Default | Constraints           |
| ---------- | ------ | ------- | --------------------- |
| `symbol`   | string | BTCUSDT | `^[A-Za-z0-9]{3,20}$` |
| `interval` | string | `1h`    | `\d+[mhdw]`, qty >= 1 |
| `limit`    | string | 24      | 1–1000                |

**Price:** 0.05 USDT (`50000000000000000` atomic, 18 decimals)

**Response 200:**

```json
{
  "disclaimer": "Informational only; not investment advice...",
  "symbol": "BTCUSDT",
  "timestamp": 1234567890,
  "volatility_score": 45.2,
  "momentum_score": 62.8,
  "composite_score": 54.0,
  "open_interest": 12500000000,
  "order_book_imbalance": 0.15,
  "realized_volatility_24h": 0.0523,
  "data_ttl_seconds": 30,
  "sources": ["ticker", "klines", "orderBook"],
  "data_age_ms": 150,
  "confidence_score": 93,
  "age": 150,
  "contrast": { "venue": "binance_futures", "symbol": "BTC/USDT", "mid": 50010, "available": true, ... }
}
```

### GET `/api/v1/market-intelligence/volatility/history`

Historical CVMS time series for a symbol.

**Query parameters:**

| Param    | Type   | Default | Constraints           |
| -------- | ------ | ------- | --------------------- |
| `symbol` | string | BTCUSDT | `^[A-Za-z0-9]{3,20}$` |
| `limit`  | string | 100     | 1–1000                |

**Price:** 0.01 USDT per record, minimum 1 USDT. Price is computed as `max(limit * 0.01, 1.0)`.

**Response 200:**

```json
{
  "disclaimer": "Informational only...",
  "symbol": "BTCUSDT",
  "count": 24,
  "scores": [
    {
      "symbol": "BTCUSDT",
      "timestamp": 1234567890,
      "volatility_score": 45.2,
      "composite_score": 54.0,
      "sources": ["ticker", "klines", "orderBook"],
      "data_age_ms": 150,
      "age": 150,
      "confidence_score": 93
    }
  ]
}
```

### POST `/api/v1/market-intelligence/volatility/batch`

Batch CVMS scores for multiple symbols.

**Body:**

```json
{
  "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  "interval": "1h",
  "limit": 24
}
```

- `symbols`: array of 1–100 strings matching `^[A-Za-z0-9]{3,20}$`
- Empty or invalid symbols array returns `400` before payment
- Symbols are deduplicated and capped at 100

**Price:** 0.04 USDT per symbol. Computed as `min(max(count, 1), 100) * 0.04`.

**Response 200:**

```json
{
  "disclaimer": "Informational only...",
  "count": 3,
  "scores": [ ...CvmsScore objects, each with disclaimer]
}
```

### POST `/api/v1/market-intelligence/portfolio/risk`

Portfolio-level risk metrics.

**Body:**

```json
{
  "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  "weights": [0.5, 0.3, 0.2],
  "interval": "1h",
  "limit": 24
}
```

- `symbols` and `weights` arrays must have equal length
- Weights must be finite non-negative numbers
- Symbols are uppercased, deduplicated (weights merged), and capped at 100
- Symbols are validated **before** payment (validate-before-pay)

**Price:** 0.04 USDT per symbol (based on unique symbol count).

**Response 200:**

```json
{
  "disclaimer": "Informational only...",
  "portfolio": {
    "symbol": "PORTFOLIO",
    "volatility_score": ...,
    "momentum_score": ...,
    "composite_score": ...,
    "open_interest": ...,
    "order_book_imbalance": ...,
    "realized_volatility_24h": ...,
    "data_ttl_seconds": 30,
    "sources": [...],
    "data_age_ms": ...,
    "age": ...,
    "confidence_score": ...
  },
  "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  "weights": [0.5, 0.3, 0.2],
  "correlation_matrix": [[1, 0.45, -0.12], [0.45, 1, 0.33], [-0.12, 0.33, 1]],
  "correlation_basis": "log_returns",
  "concentration_warnings": [
    { "symbol": "BTCUSDT", "weight": 0.5, "message": "..." }
  ],
  "diversification_headroom": {
    "current_diversified_positions": 2,
    "recommended_minimum": 10,
    "headroom": 8
  }
}
```

### POST `/api/v1/subscription`

Purchase request credits (subscription). Requires real x402 payment — existing subscription balance **cannot** be used here (`skipSubscriptionCheck: true`).

**Price:** 10 USDT (`10000000000000000000` atomic, 18 decimals), configurable via `B402_PRICING_SUBSCRIPTION`.

**Response 200:**

```json
{
  "status": "active",
  "subscription_nonce": "0xabc...",
  "initial_balance": 200,
  "remaining_balance": 200,
  "expires_at": 1234567890,
  "network": "eip155:56"
}
```

## Admin

### POST `/api/v1/treasury/withdraw`

Withdraw funds from the treasury. Requires `x-api-key` header matching `ADMIN_API_KEY`.

**Body:**

```json
{
  "amount": "500000000000000000",
  "token": "0x55d398326f99059fF775485246999027B3197955",
  "destination": "0xYourAddressHere",
  "signature": "0xsig"
}
```

**Response 200:**

```json
{
  "status": "pending",
  "amount": "500000000000000000",
  "token": "0x55...",
  "destination": "0xYourAddress...",
  "daily_spent": "10000000000000000000"
}
```

### GET `/api/v1/treasury/balance`

Get treasury configuration and withdrawal history summary. Requires `x-api-key`.

**Response 200:**

```json
{
  "active": true,
  "daily_limit_atomic": "10000000000000000000",
  "single_limit_atomic": "1000000000000000000",
  "withdrawal_whitelist": ["0x..."],
  "token_whitelist": ["0x...", "0x..."],
  "total_withdrawals": 5
}
```

## HTTP headers

| Header              | Direction | Description                                         |
| ------------------- | --------- | --------------------------------------------------- |
| `payment-signature` | Request   | base64-encoded x402 V2 `PaymentPayload`             |
| `PAYMENT-REQUIRED`  | Response  | base64-encoded `PaymentRequired` challenge (on 402) |
| `PAYMENT-RESPONSE`  | Response  | base64-encoded settle receipt or free-mode receipt  |
| `x-api-key`         | Request   | Admin treasury auth (timing-safe comparison)        |
| `Retry-After`       | Response  | Seconds until rate-limit window resets (on 429)     |

## Error responses

| Status | Scenario                                         |
| ------ | ------------------------------------------------ |
| 400    | Malformed JSON, invalid interval/symbols/weights |
| 401    | Missing or wrong `x-api-key` on admin routes     |
| 402    | Payment required — see `PAYMENT-REQUIRED` header |
| 403    | Payment invalid, treasury withdrawal rejected    |
| 413    | Request body exceeds 10kb                        |
| 429    | Rate limit exceeded — see `Retry-After` header   |
| 500    | Internal server error (JSON, never HTML)         |
| 503    | MCP unavailable + no cache, or service not ready |
