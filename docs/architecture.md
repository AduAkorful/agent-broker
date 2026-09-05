# Architecture

Agent Broker is an HTTP service that turns Binance market data into paid Composite Volatility & Momentum Scores (CVMS) for trading agents. It sits between a market-data source (Binance MCP) and downstream trading agents that need priced, provenance-tagged intelligence.

## Component diagram

```mermaid
graph TD
  subgraph Agent["Trading Agent (Client)"]
    AGT[agent]
  end

  subgraph Express["Express HTTP API (src/index.ts)"]
    API[Route handlers]
    MW[paymentMiddleware]
    HEALTH[/health, /ready, /agent/info/]
    OPENAPI[/openapi.yaml/.json/]
    VOL[/volatility/]
    HIST[/volatility/history/]
    BATCH[/volatility/batch/]
    PORT[/portfolio/risk/]
    SUB[/subscription/]
    TREAS[//treasury/withdraw, /balance/]

    API --> VOL
    API --> HIST
    API --> BATCH
    API --> PORT
    API --> SUB
    API --> TREAS
  end

  subgraph Payment["Payment edge (src/payment/)"]
    MW --> PMW[paymentMiddleware]
    PMW --> PS[PaymentService]
    PS --> NS[NonceStore]
    PS --> SS[SubscriptionStore]
    PS --> FC[B402FacilitatorClient]
    NS -.->|SQLite| DB[(SQLite)]
    SS -.->|SQLite| DB
  end

  subgraph Data["Data layer (src/)"]
    VOL --> MCP[BinanceMcpClient]
    HIST --> SHS[ScoreHistoryStore]
    BATCH --> MCP
    PORT --> MCP
    MCP --> MCP_SERVER[agent.binance.com/mcp/agentic]
    MCP -.->|Streamable HTTP| MCP_SERVER
    MCP --> CVMS[CvmsScorer]
    CVMS --> SHS
    MCP --> CACHE[MarketDataCache]
    BATCH --> VC[CCXT VenueContrast]
    PORT --> VC
  end

  subgraph Ext["External services"]
    MCP_SERVER
    FC --> FAC[B402 Facilitator<br/>facilitatorv3.b402.ai]
    FAC
  end

  AGT <--|x402 headers| API
  API --> MW
```

## Layer responsibilities

| Layer              | Role                                                                       | Key files                                              |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| Express routes     | Discovery, readiness, paid intelligence, admin treasury                    | `src/index.ts`                                         |
| Payment middleware | x402 V2 header I/O; rate-limit before challenge; subscription bypass       | `src/payment/middleware.ts`                            |
| Payment service    | Challenge creation, payment verification (field binding), settlement       | `src/payment/payment-service.ts`                       |
| B402 facilitator   | REST client: `/api/v1/verify`, `/api/v1/settle`, `/api/v1/health`          | `src/payment/b402-client.ts`                           |
| MCP client         | Streamable HTTP to Binance MCP (ticker, klines, book, optional OI/funding) | `src/mcp-client.ts`                                    |
| CVMS scorer        | Volatility, momentum/imbalance, open-interest contribution                 | `src/cvms.ts`                                          |
| Market cache       | Soft TTL (30s) + hard max-stale age (900s), 100-entry LRU eviction         | `src/market-cache.ts`                                  |
| Venue contrast     | Optional CCXT mid vs Binance basis                                         | `src/venue-contrast.ts`                                |
| SQLite stores      | Nonces, subscriptions, history, treasury, rate limits                      | `src/payment/*`-store.ts, `src/score-history-store.ts` |

## Data flow

```mermaid
sequenceDiagram
    participant C as Client Agent
    participant A as Express API
    participant MW as Payment Middleware
    participant PS as PaymentService
    participant N as NonceStore
    participant F as B402 Facilitator
    participant M as Binance MCP
    participant S as CvmsScorer

    C->>A: GET /market-intelligence/volatility?symbol=BTCUSDT
    Note over MW: paymentsEnabled && price > 0
    MW->>PS: createPaymentChallenge()
    PS->>N: generateNonce()
    MW-->>C: 402 + PAYMENT-REQUIRED (base64)
    C->>MW: Retry + payment-signature (base64 x402 payload)
    Note over PS: validate fields (payTo, to, value, token, network, scheme, validAfter/Before, amount)
    PS->>N: isNonceValid() — check existence + expiry
    PS->>F: POST /api/v1/verify (B402 translated body)
    F-->>PS: { isValid: true, payer }
    PS->>N: consumeNonce() — atomic UPDATE claims nonce
    Note over PS: nonce consumed AFTER verify success (TOCTOU prevention)
    PS->>F: POST /api/v1/settle (Idempotency-Key: nonce)
    MW-->>C: PAYMENT-RESPONSE (base64)
    MW->>M: getMarketSnapshot()
    M-->>MW: MarketSnapshot (ticker, klines, orderBook, OI, funding)
    MW->>S: score()
    S-->>MW: CvmsScore (+sources, data_age_ms, confidence_score)
    MW->>A: cache.set()
    A->>A: ScoreHistoryStore.recordScore()
    A->>C: JSON { ...score, contrast?, disclaimer }
```

### Batch/portfolio concurrency

```mermaid
graph LR
  subgraph "Batch handler"
    BATCH["batch symbols"]
    POOL["mapPool concurrency=5"]
    VALID["filter null snapshots"]
    SCORE["mapPool concurrency=3: score + history + contrast"]
    RESP["response JSON"]
  end
  BATCH --> POOL
  POOL --> VALID
  VALID --> SCORE
  SCORE --> RESP
```

## Data models

### MarketSnapshot

```mermaid
erDiagram
    MarketSnapshot {
        string symbol
        string interval
        integer fetchedAt
        json ticker
        Candle[] klines
        OrderBook orderBook
        number openInterest
        number fundingRate
        string[] sources
    }
    Candle {
        integer openTime
        number open
        number high
        number low
        number close
        number volume
    }
    OrderBook {
        OrderBookLevel[] bids
        OrderBookLevel[] asks
    }
    OrderBookLevel {
        number price
        number quantity
    }
    MarketSnapshot ||--o{ Candle : contains
    MarketSnapshot ||--o{ OrderBook : contains
    OrderBook ||--o{ OrderBookLevel : has
```

### CvmsScore

```mermaid
erDiagram
    CvmsScore {
        string symbol
        integer timestamp
        number volatility_score
        number momentum_score
        number composite_score
        number open_interest
        number funding_rate
        number order_book_imbalance
        number realized_volatility_24h
        integer data_ttl_seconds
        boolean stale
        string[] sources
        integer data_age_ms
        integer confidence_score
    }
```

## SQLite store schemas

```mermaid
erDiagram
    nonces {
        string nonce PK
        integer used
        integer created_at
        integer used_at
    }
    rate_limits {
        string ip PK
        integer count
        integer window_start
        integer updated_at
    }
    subscriptions {
        string nonce PK
        integer initial_balance
        integer remaining_balance
        integer expires_at
        integer created_at
        string payer
    }
    score_history {
        integer id PK
        string symbol
        integer fetched_at
        string score_json
        string sources
        integer confidence
        integer data_age_ms
        integer created_at
    }
    treasury_withdrawals {
        string date
        string token
        string amount
        string destination
        integer timestamp
        string signature
    }
```

## Seller vs relayer

- **`B402_PAY_TO`** — seller wallet address. Challenge `payTo` and authorization `to` must match this. Required in production when payments are enabled.
- **`B402_RELAYER`** — relayer contract address (`0xE91b564EB8DFF305Ff8efA332f84c487b9da5171`). Used only as the EIP-712 `verifyingContract` / `relayerContract`. Never used as `payTo`.

## Free mode

`PAYMENTS_ENABLED=false` or atomic price `0` skips 402 entirely and the facilitator is never called. The middleware issues a free-mode `PAYMENT-RESPONSE` receipt and calls `next()`. `agent/info` reports `payments_enabled: false` and zero prices.
