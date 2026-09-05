import type { Candle, CvmsScore, MarketSnapshot, OrderBookLevel } from "./types.js";

export interface CvmsWeights {
  volatility: number;
  momentum: number;
  /** Open-interest contribution (honestly named; not a funding rate). */
  openInterest: number;
}

export interface CvmsConfig {
  weights: CvmsWeights;
  volatilityMax: number;
  priceChangeThreshold: number;
  orderBookDepthLevels: number;
  dataTtlSeconds: number;
}

export const DEFAULT_CVMS_CONFIG: CvmsConfig = {
  weights: {
    volatility: 0.4,
    momentum: 0.4,
    openInterest: 0.2,
  },
  volatilityMax: 0.1,
  priceChangeThreshold: 0.02,
  orderBookDepthLevels: 5,
  dataTtlSeconds: 30,
};

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_WEEK = 604_800_000;

function clamp(min: number, max: number, value: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function intervalsPerDay(interval: string): number {
  const match = interval.match(/^(\d+)([mhdw])$/i);
  if (!match) return 24;
  const value = Number(match[1]!);
  if (!Number.isFinite(value) || value < 1) return 24;
  const unit = match[2]!.toLowerCase();
  let ms: number;
  if (unit === "m") ms = MS_PER_MINUTE;
  else if (unit === "h") ms = MS_PER_HOUR;
  else if (unit === "w") ms = MS_PER_WEEK;
  else ms = MS_PER_DAY;
  return MS_PER_DAY / (value * ms);
}

export function computeRealizedVolatility(candles: Candle[], ipd: number): number {
  if (candles.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    if (prev.close > 0 && curr.close > 0) {
      returns.push(Math.log(curr.close / prev.close));
    }
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  return stdDev * Math.sqrt(ipd);
}

export function normalizeVolatility(realizedVol: number, volatilityMax: number): number {
  if (volatilityMax <= 0) return 0;
  return clamp(0, 100, (realizedVol / volatilityMax) * 100);
}

export function computeOrderBookImbalance(
  orderBook: { bids: OrderBookLevel[]; asks: OrderBookLevel[] },
  depthLevels: number,
): number {
  const bids = orderBook.bids.slice(0, depthLevels);
  const asks = orderBook.asks.slice(0, depthLevels);
  const bidQty = bids.reduce((sum, level) => sum + level.quantity, 0);
  const askQty = asks.reduce((sum, level) => sum + level.quantity, 0);
  const total = bidQty + askQty;
  if (total === 0) return 0;
  return (bidQty - askQty) / total;
}

export function computeMomentumScore(
  candles: Candle[],
  orderBookImbalance: number,
  priceChangeThreshold: number,
): number {
  let priceDirection = 0;
  if (candles.length >= 2) {
    const firstClose = candles[0]!.close;
    const lastClose = candles[candles.length - 1]!.close;
    if (firstClose > 0) {
      const priceChange = (lastClose - firstClose) / firstClose;
      priceDirection = clamp(-1, 1, priceChange / priceChangeThreshold);
    }
  }
  const clampedImbalance = clamp(-1, 1, orderBookImbalance);
  return clamp(0, 100, 50 + 25 * clampedImbalance + 25 * priceDirection);
}

/** Raw open-interest signal (not funding rate). */
export function computeOpenInterestSignal(openInterest: number | undefined): number {
  return openInterest ?? 0;
}

/** @deprecated Use computeOpenInterestSignal */
export const computeFundingSignal = computeOpenInterestSignal;

export function computeOpenInterestScore(oiSignal: number, hasOiData: boolean): number {
  if (!hasOiData) return 50;
  // oiSignal is raw open interest (can be in millions/billions).
  // Normalize on a log scale so large OI values don't saturate to 100.
  if (!Number.isFinite(oiSignal) || oiSignal <= 0) return 50;
  const normalized = Math.min(Math.log10(oiSignal) / 10, 1);
  return clamp(0, 100, 50 + 50 * normalized);
}

/** @deprecated Use computeOpenInterestScore */
export const computeFundingScore = computeOpenInterestScore;

export function computeCompositeScore(
  volScore: number,
  momScore: number,
  oiScore: number,
  hasOpenInterest: boolean,
  weights: CvmsWeights,
): number {
  if (hasOpenInterest) {
    return clamp(0, 100, weights.volatility * volScore + weights.momentum * momScore + weights.openInterest * oiScore);
  }
  const totalWeight = weights.volatility + weights.momentum;
  if (totalWeight === 0) return 50;
  return clamp(0, 100, (weights.volatility * volScore + weights.momentum * momScore) / totalWeight);
}

export class CvmsScorer {
  constructor(private readonly config: CvmsConfig = DEFAULT_CVMS_CONFIG) {}

  score(snapshot: MarketSnapshot): CvmsScore {
    const ipd = intervalsPerDay(snapshot.interval);
    const realizedVol = computeRealizedVolatility(snapshot.klines, ipd);
    const volScore = normalizeVolatility(realizedVol, this.config.volatilityMax);
    const orderBookImbalance = computeOrderBookImbalance(snapshot.orderBook, this.config.orderBookDepthLevels);
    const momentumScore = computeMomentumScore(snapshot.klines, orderBookImbalance, this.config.priceChangeThreshold);
    const oiSignal = computeOpenInterestSignal(snapshot.openInterest);
    const hasOi = snapshot.openInterest !== undefined;
    const oiScore = computeOpenInterestScore(oiSignal, hasOi);
    const compositeScore = computeCompositeScore(volScore, momentumScore, oiScore, hasOi, this.config.weights);

    const dataAgeMs = Date.now() - snapshot.fetchedAt;
    const ttlMs = this.config.dataTtlSeconds * 1000;
    const freshnessRatio = clamp(0, 1, ttlMs > 0 ? 1 - dataAgeMs / ttlMs : 0);
    const fieldCount = 3 + (hasOi ? 1 : 0);
    const completenessRatio = fieldCount / 4;
    const confidenceScore = clamp(0, 100, freshnessRatio * 60 + completenessRatio * 40);

    return {
      symbol: snapshot.symbol,
      timestamp: snapshot.fetchedAt,
      volatility_score: round(volScore),
      momentum_score: round(momentumScore),
      composite_score: round(compositeScore),
      open_interest: round(Number.isFinite(oiSignal) ? oiSignal : 0, 6),
      open_interest_signal: round(Number.isFinite(oiSignal) ? oiSignal : 0, 6),
      ...(snapshot.fundingRate !== undefined ? { funding_rate: round(snapshot.fundingRate, 8) } : {}),
      order_book_imbalance: round(orderBookImbalance, 4),
      realized_volatility_24h: round(realizedVol, 6),
      data_ttl_seconds: this.config.dataTtlSeconds,
      sources: snapshot.sources,
      data_age_ms: dataAgeMs,
      confidence_score: round(confidenceScore),
    };
  }
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
