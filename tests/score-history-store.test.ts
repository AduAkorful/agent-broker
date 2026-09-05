import { afterEach, describe, expect, it } from "vitest";
import { ScoreHistoryStore } from "../src/score-history-store.js";
import type { CvmsScore } from "../src/types.js";

function makeScore(overrides: Partial<CvmsScore> = {}): CvmsScore {
  return {
    symbol: "BTCUSDT",
    timestamp: 1_700_000_000,
    volatility_score: 50,
    momentum_score: 55,
    composite_score: 52,
    open_interest: 0,
    order_book_imbalance: 0.1,
    realized_volatility_24h: 0.05,
    data_ttl_seconds: 30,
    sources: ["ticker", "klines", "orderBook"],
    data_age_ms: 100,
    confidence_score: 85,
    ...overrides,
  };
}

describe("ScoreHistoryStore", () => {
  let store: ScoreHistoryStore;

  afterEach(() => {
    store?.close();
  });

  it("records and retrieves historical scores", () => {
    store = new ScoreHistoryStore();
    const score = makeScore();
    store.recordScore("BTCUSDT", score, score.sources, score.confidence_score, score.data_age_ms);

    const history = store.getHistory("BTCUSDT", 10);
    expect(history).toHaveLength(1);
    expect(history[0]!.symbol).toBe("BTCUSDT");
    expect(history[0]!.sources).toBe(JSON.stringify(["ticker", "klines", "orderBook"]));
    expect(history[0]!.confidence).toBe(85);
    expect(history[0]!.data_age_ms).toBe(100);
  });

  it("returns multiple records ordered by fetched_at descending", () => {
    store = new ScoreHistoryStore();
    const score1 = makeScore({ timestamp: 1_000, sources: ["ticker", "klines", "orderBook"] });
    const score2 = makeScore({ timestamp: 2_000, sources: ["ticker", "klines", "orderBook", "openInterest"] });
    store.recordScore("BTCUSDT", score1, score1.sources, 80, 50);
    store.recordScore("BTCUSDT", score2, score2.sources, 90, 25);

    const history = store.getHistory("BTCUSDT", 10);
    expect(history).toHaveLength(2);
    expect(history[0]!.fetched_at).toBe(2_000);
    expect(history[1]!.fetched_at).toBe(1_000);
  });

  it("respects the limit parameter", () => {
    store = new ScoreHistoryStore();
    for (let i = 0; i < 5; i++) {
      const score = makeScore({ timestamp: i });
      store.recordScore("BTCUSDT", score, score.sources, 80, 100);
    }

    const history = store.getHistory("BTCUSDT", 3);
    expect(history).toHaveLength(3);
  });

  it("separates history by symbol", () => {
    store = new ScoreHistoryStore();
    const btcScore = makeScore({ symbol: "BTCUSDT" });
    const ethScore = makeScore({ symbol: "ETHUSDT" });
    store.recordScore("BTCUSDT", btcScore, btcScore.sources, 80, 100);
    store.recordScore("ETHUSDT", ethScore, ethScore.sources, 85, 50);

    expect(store.getHistory("BTCUSDT", 10)).toHaveLength(1);
    expect(store.getHistory("ETHUSDT", 10)).toHaveLength(1);
  });

  it("returns empty array for unknown symbol", () => {
    store = new ScoreHistoryStore();
    expect(store.getHistory("SOLUSDT", 10)).toEqual([]);
  });

  it("stores score_json that can be parsed back", () => {
    store = new ScoreHistoryStore();
    const score = makeScore();
    store.recordScore("BTCUSDT", score, score.sources, score.confidence_score, score.data_age_ms);

    const history = store.getHistory("BTCUSDT", 10);
    const parsed = JSON.parse(history[0]!.score_json) as CvmsScore;
    expect(parsed.symbol).toBe("BTCUSDT");
    expect(parsed.composite_score).toBe(52);
    expect(parsed.sources).toEqual(["ticker", "klines", "orderBook"]);
  });

  it("clearSymbol removes all records for a symbol", () => {
    store = new ScoreHistoryStore();
    const score = makeScore();
    store.recordScore("BTCUSDT", score, score.sources, 80, 100);
    store.recordScore("ETHUSDT", score, score.sources, 85, 50);

    expect(store.clearSymbol("BTCUSDT")).toBe(1);
    expect(store.getHistory("BTCUSDT", 10)).toHaveLength(0);
    expect(store.getHistory("ETHUSDT", 10)).toHaveLength(1);
  });

  it("getHistoryCount returns total records", () => {
    store = new ScoreHistoryStore();
    expect(store.getHistoryCount()).toBe(0);

    const score = makeScore();
    store.recordScore("BTCUSDT", score, score.sources, 80, 100);
    store.recordScore("ETHUSDT", score, score.sources, 85, 50);

    expect(store.getHistoryCount()).toBe(2);
  });

  it("cleanupExpired preserves recent records and deletes old ones (seconds-based)", () => {
    store = new ScoreHistoryStore();
    const score = makeScore();
    store.recordScore("BTCUSDT", score, score.sources, 80, 100);
    expect(store.getHistoryCount()).toBe(1);

    const nowSeconds = Math.floor(Date.now() / 1000);

    // Cutoff 1 day in the past (seconds) — recent record should survive
    const pastCutoff = nowSeconds - 86_400;
    const deletedPast = store.cleanupExpired(pastCutoff);
    expect(deletedPast).toBe(0);
    expect(store.getHistoryCount()).toBe(1);

    // Cutoff 1 day in the future (seconds) — record created now should be deleted
    const futureCutoff = nowSeconds + 86_400;
    const deletedFuture = store.cleanupExpired(futureCutoff);
    expect(deletedFuture).toBe(1);
    expect(store.getHistoryCount()).toBe(0);
  });

  it("scheduleCleanup does not wipe all records on each tick", () => {
    store = new ScoreHistoryStore();
    const score = makeScore();
    store.recordScore("BTCUSDT", score, score.sources, 80, 100);
    store.recordScore("ETHUSDT", score, score.sources, 85, 50);

    const cleanup = store.scheduleCleanup(100);
    // Wait for one cleanup tick (100ms)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(store.getHistoryCount()).toBe(2);
        cleanup.stop();
        store.close();
        resolve();
      }, 200);
    });
  });
});
