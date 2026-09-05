import { describe, expect, it } from "vitest";
import {
  CvmsScorer,
  DEFAULT_CVMS_CONFIG,
  computeRealizedVolatility,
  computeOrderBookImbalance,
  computeMomentumScore,
  computeCompositeScore,
  computeFundingScore,
  intervalsPerDay,
  normalizeVolatility,
} from "../src/cvms.js";
import type { Candle, MarketSnapshot } from "../src/types.js";

const makeCandle = (close: number, volume = 10, openTime = 0): Candle => ({
  openTime,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

describe("intervalsPerDay", () => {
  it.each([
    ["1m", 1440],
    ["5m", 288],
    ["15m", 96],
    ["1h", 24],
    ["1d", 1],
    ["3m", 480],
    ["2h", 12],
    ["1w", 1440 / (7 * 24 * 60)],
  ])("returns correct intervals per day for %s", (interval, expected) => {
    if (interval === "1w") {
      expect(intervalsPerDay(interval)).toBeCloseTo(expected, 5);
    } else {
      expect(intervalsPerDay(interval)).toBe(expected);
    }
  });

  it("defaults to 24 for unrecognized intervals", () => {
    expect(intervalsPerDay("garbage")).toBe(24);
  });
});

describe("computeRealizedVolatility", () => {
  it("returns 0 for fewer than 2 candles", () => {
    expect(computeRealizedVolatility([], 24)).toBe(0);
    expect(computeRealizedVolatility([makeCandle(100)], 24)).toBe(0);
  });

  it("returns 0 when all closes are equal", () => {
    const candles = [makeCandle(100), makeCandle(100), makeCandle(100)];
    expect(computeRealizedVolatility(candles, 24)).toBe(0);
  });

  it("returns 0 when close prices are zero", () => {
    const candles = [makeCandle(0), makeCandle(0), makeCandle(0)];
    expect(computeRealizedVolatility(candles, 24)).toBe(0);
  });

  it("computes positive volatility for varying returns", () => {
    const candles = [makeCandle(100), makeCandle(110), makeCandle(95), makeCandle(105)];
    const vol = computeRealizedVolatility(candles, 24);
    expect(vol).toBeGreaterThan(0);
    // With large swings, daily vol should be substantial
    expect(vol).toBeGreaterThan(0.1);
  });

  it("scales volatility by sqrt of intervals per day", () => {
    const candles = [makeCandle(100), makeCandle(105), makeCandle(95)];
    const vol1h = computeRealizedVolatility(candles, 24);
    const vol1m = computeRealizedVolatility(candles, 1440);
    // More intervals per day means more scaling
    expect(vol1m).toBeGreaterThan(vol1h);
    // Ratio should be sqrt(1440/24) = sqrt(60)
    expect(vol1m / vol1h).toBeCloseTo(Math.sqrt(60), 5);
  });
});

describe("normalizeVolatility", () => {
  it("maps 0 volatility to score 0", () => {
    expect(normalizeVolatility(0, 0.1)).toBe(0);
  });

  it("maps volatility at threshold to score 100", () => {
    expect(normalizeVolatility(0.1, 0.1)).toBe(100);
  });

  it("maps volatility above threshold to 100 (clamped)", () => {
    expect(normalizeVolatility(0.5, 0.1)).toBe(100);
  });

  it("maps volatility below threshold proportionally", () => {
    expect(normalizeVolatility(0.05, 0.1)).toBe(50);
    expect(normalizeVolatility(0.01, 0.1)).toBe(10);
  });

  it("clamps negative volatility to 0", () => {
    expect(normalizeVolatility(-0.05, 0.1)).toBe(0);
  });
});

describe("computeOrderBookImbalance", () => {
  it("returns 0 for empty order book", () => {
    expect(computeOrderBookImbalance({ bids: [], asks: [] }, 5)).toBe(0);
  });

  it("returns 0 for balanced book", () => {
    const book = {
      bids: [{ price: 100, quantity: 10 }],
      asks: [{ price: 101, quantity: 10 }],
    };
    expect(computeOrderBookImbalance(book, 5)).toBe(0);
  });

  it("returns 1 for all-bid book", () => {
    const book = {
      bids: [{ price: 100, quantity: 10 }],
      asks: [],
    };
    expect(computeOrderBookImbalance(book, 5)).toBe(1);
  });

  it("returns -1 for all-ask book", () => {
    const book = {
      bids: [],
      asks: [{ price: 100, quantity: 10 }],
    };
    expect(computeOrderBookImbalance(book, 5)).toBe(-1);
  });

  it("computes ratio for mixed book", () => {
    const book = {
      bids: [{ price: 100, quantity: 7 }],
      asks: [{ price: 100, quantity: 3 }],
    };
    expect(computeOrderBookImbalance(book, 5)).toBeCloseTo(0.4, 5);
  });

  it("respects depth limit", () => {
    const book = {
      bids: [
        { price: 99, quantity: 100 },
        { price: 98, quantity: 1 },
      ],
      asks: [
        { price: 101, quantity: 100 },
        { price: 102, quantity: 1 },
      ],
    };
    expect(computeOrderBookImbalance(book, 1)).toBeCloseTo(0, 5);
    expect(computeOrderBookImbalance(book, 2)).toBeCloseTo(0, 5);
  });
});

describe("computeMomentumScore", () => {
  it("returns neutral 50 for empty candles with balanced book", () => {
    expect(computeMomentumScore([], 0, 0.02)).toBe(50);
  });

  it("returns >50 for uptrend with positive imbalance", () => {
    const candles = [makeCandle(100), makeCandle(110)];
    expect(computeMomentumScore(candles, 0.3, 2)).toBeGreaterThan(50);
  });

  it("returns <50 for downtrend with negative imbalance", () => {
    const candles = [makeCandle(100), makeCandle(90)];
    expect(computeMomentumScore(candles, -0.3, 2)).toBeLessThan(50);
  });

  it("saturates at 100 for extreme uptrend", () => {
    const candles = [makeCandle(100), makeCandle(200)];
    expect(computeMomentumScore(candles, 1, 0.02)).toBe(100);
  });

  it("saturates at 0 for extreme downtrend", () => {
    const candles = [makeCandle(200), makeCandle(100)];
    expect(computeMomentumScore(candles, -1, 0.02)).toBe(0);
  });

  it("returns 50 + 25*imbalance when only one candle", () => {
    const result = computeMomentumScore([makeCandle(100)], 0.4, 0.02);
    expect(result).toBeCloseTo(60, 1);
  });

  it("is bounded between 0 and 100 for any input", () => {
    const candles = [makeCandle(100), makeCandle(1_000_000)];
    expect(computeMomentumScore(candles, 1, 0.02)).toBe(100);
    expect(computeMomentumScore(candles, -1, 0.02)).toBeGreaterThanOrEqual(0);
    expect(computeMomentumScore(candles, -1, 0.02)).toBeLessThanOrEqual(100);
  });
});

describe("computeFundingScore", () => {
  it("returns neutral 50 when no open interest data", () => {
    expect(computeFundingScore(0, false)).toBe(50);
  });

  it("returns 50 for zero or negative open interest", () => {
    expect(computeFundingScore(0, true)).toBe(50);
    expect(computeFundingScore(-1, true)).toBe(50);
  });

  it("returns 50 for NaN open interest", () => {
    expect(computeFundingScore(NaN, true)).toBe(50);
  });

  it("scales open interest on a log scale (does not saturate)", () => {
    // OI=1M → log10(1M)=6, normalized=0.6, score=50+50*0.6=80
    expect(computeFundingScore(1_000_000, true)).toBe(80);
    // OI=100M → log10(100M)=8, normalized=0.8, score=50+50*0.8=90
    expect(computeFundingScore(100_000_000, true)).toBe(90);
    // OI=10B → log10(10B)=10, normalized=1, score=50+50*1=100 (capped)
    expect(computeFundingScore(10_000_000_000, true)).toBe(100);
  });
});

describe("computeCompositeScore", () => {
  const weights = { volatility: 0.4, momentum: 0.4, openInterest: 0.2 };

  it("uses all weights when open interest is available", () => {
    const result = computeCompositeScore(80, 60, 50, true, weights);
    expect(result).toBeCloseTo(0.4 * 80 + 0.4 * 60 + 0.2 * 50, 5);
  });

  it("redistributes weights when open interest is unavailable", () => {
    const result = computeCompositeScore(80, 60, 50, false, weights);
    // Only vol and mom count: (0.4*80 + 0.4*60) / 0.8
    expect(result).toBeCloseTo((0.4 * 80 + 0.4 * 60) / 0.8, 5);
  });

  it("clamps to 100", () => {
    expect(computeCompositeScore(100, 100, 100, true, weights)).toBe(100);
  });

  it("clamps to 0", () => {
    expect(computeCompositeScore(0, 0, 0, true, weights)).toBe(0);
  });

  it("returns 50 for zero total weight", () => {
    expect(computeCompositeScore(0, 0, 0, false, { volatility: 0, momentum: 0, openInterest: 1 })).toBe(50);
  });
});

describe("CvmsScorer", () => {
  function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
    const candles: Candle[] = [];
    for (let i = 0; i < 24; i++) {
      candles.push(makeCandle(100 + i, 10 + i, i * 3_600_000));
    }
    return {
      symbol: "BTCUSDT",
      interval: "1h",
      fetchedAt: 1_700_000_000,
      ticker: { lastPrice: "64000" },
      klines: candles,
      orderBook: {
        bids: [
          { price: 63999, quantity: 10 },
          { price: 63998, quantity: 5 },
        ],
        asks: [
          { price: 64001, quantity: 8 },
          { price: 64002, quantity: 3 },
        ],
      },
      sources: ["ticker", "klines", "orderBook"],
      ...overrides,
    };
  }

  it("produces a correctly structured CvmsScore", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(makeSnapshot());

    expect(score).toMatchObject({
      symbol: "BTCUSDT",
      timestamp: 1_700_000_000,
      data_ttl_seconds: DEFAULT_CVMS_CONFIG.dataTtlSeconds,
    });
    expect(score.volatility_score).toBeGreaterThanOrEqual(0);
    expect(score.volatility_score).toBeLessThanOrEqual(100);
    expect(score.momentum_score).toBeGreaterThanOrEqual(0);
    expect(score.momentum_score).toBeLessThanOrEqual(100);
    expect(score.composite_score).toBeGreaterThanOrEqual(0);
    expect(score.composite_score).toBeLessThanOrEqual(100);
    expect(score.realized_volatility_24h).toBeGreaterThanOrEqual(0);
    expect(score.order_book_imbalance).toBeGreaterThanOrEqual(-1);
    expect(score.order_book_imbalance).toBeLessThanOrEqual(1);
  });

  it("includes open interest signal when available", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(makeSnapshot({ openInterest: 123_456 }));
    expect(score.open_interest).toBeCloseTo(123456, 1);
  });

  it("defaults open interest to 0 when open interest absent", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(makeSnapshot());
    expect(score.open_interest).toBe(0);
  });

  it("rounds output values", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(makeSnapshot());
    // No value should have more than 2 decimal places (except open_interest and realized_volatility)
    expect(String(score.volatility_score).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(String(score.momentum_score).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(String(score.composite_score).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("uses custom config weights", () => {
    const scorer = new CvmsScorer({
      ...DEFAULT_CVMS_CONFIG,
      weights: { volatility: 1.0, momentum: 0, openInterest: 0 },
    });
    const snapshot = makeSnapshot();
    const score = scorer.score(snapshot);
    const volScore = normalizeVolatility(
      computeRealizedVolatility(snapshot.klines, intervalsPerDay(snapshot.interval)),
      DEFAULT_CVMS_CONFIG.volatilityMax,
    );
    // With momentum weight = 0 and no open interest, composite should equal vol score
    expect(score.composite_score).toBeCloseTo(volScore, 1);
  });

  it("handles empty klines gracefully", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(
      makeSnapshot({
        klines: [],
        orderBook: { bids: [], asks: [] },
        sources: ["ticker", "klines", "orderBook"],
      }),
    );
    expect(score.realized_volatility_24h).toBe(0);
    expect(score.volatility_score).toBe(0);
    expect(score.momentum_score).toBe(50);
    expect(score.order_book_imbalance).toBe(0);
  });

  it("handles empty order book gracefully", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(
      makeSnapshot({
        orderBook: { bids: [], asks: [] },
        sources: ["ticker", "klines", "orderBook"],
      }),
    );
    expect(score.order_book_imbalance).toBe(0);
  });

  it("returns sources from the input snapshot", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(
      makeSnapshot({ sources: ["ticker", "klines", "orderBook", "openInterest"], openInterest: 100 }),
    );
    expect(score.sources).toEqual(["ticker", "klines", "orderBook", "openInterest"]);
  });

  it("returns non-negative data_age_ms", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(makeSnapshot());
    expect(score.data_age_ms).toBeGreaterThanOrEqual(0);
  });

  it("confidence_score is bounded 0-100", () => {
    const scorer = new CvmsScorer();
    const score = scorer.score(makeSnapshot());
    expect(score.confidence_score).toBeGreaterThanOrEqual(0);
    expect(score.confidence_score).toBeLessThanOrEqual(100);
  });

  it("confidence_score is higher when open interest is present", () => {
    const scorer = new CvmsScorer();
    const freshSnapshot = makeSnapshot({ fetchedAt: Date.now() });
    const withOi = scorer.score({
      ...freshSnapshot,
      openInterest: 100,
      sources: ["ticker", "klines", "orderBook", "openInterest"],
    });
    const withoutOi = scorer.score(freshSnapshot);
    expect(withOi.confidence_score).toBe(100);
    expect(withoutOi.confidence_score).toBe(90); // fresh but incomplete (missing open interest)
    expect(withOi.confidence_score).toBeGreaterThan(withoutOi.confidence_score);
  });

  it("confidence_score drops to 0 for stale data", () => {
    const scorer = new CvmsScorer({ ...DEFAULT_CVMS_CONFIG, dataTtlSeconds: 30 });
    const staleSnapshot = makeSnapshot({ fetchedAt: Date.now() - 60_000 });
    const score = scorer.score(staleSnapshot);
    expect(score.data_age_ms).toBeCloseTo(60_000, -2);
    expect(score.confidence_score).toBeLessThan(60);
  });
});
