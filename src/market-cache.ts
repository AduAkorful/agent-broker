import type { MarketSnapshot } from "./types.js";

export interface CachedSnapshot {
  snapshot: MarketSnapshot;
  cachedAt: number;
  stale: boolean;
}

export class MarketDataCache {
  private readonly cache = new Map<string, { snapshot: MarketSnapshot; cachedAt: number }>();
  private readonly ttlSeconds: number;
  private readonly maxSize: number;
  /** Hard cap — never serve cache older than this (INTEL-C5). */
  private readonly maxStaleAgeSeconds: number;

  constructor(ttlSeconds = 30, maxSize = 100, maxStaleAgeSeconds = 900) {
    this.ttlSeconds = ttlSeconds;
    this.maxSize = maxSize;
    this.maxStaleAgeSeconds = Math.max(ttlSeconds, maxStaleAgeSeconds);
  }

  set(symbol: string, snapshot: MarketSnapshot): void {
    const key = symbol.toLowerCase();
    this.cache.set(key, { snapshot, cachedAt: Date.now() });
    this.evictStale();
    this.evictOverflow();
  }

  private evictStale(): void {
    const cutoff = Date.now() - this.maxStaleAgeSeconds * 1000;
    for (const [symbol, entry] of this.cache) {
      if (entry.cachedAt <= cutoff) {
        this.cache.delete(symbol);
      }
    }
  }

  private evictOverflow(): void {
    while (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);
    }
  }

  get(symbol: string): CachedSnapshot | null {
    const key = symbol.toLowerCase();
    const entry = this.cache.get(key);
    if (!entry) return null;
    const ageMs = Date.now() - entry.cachedAt;
    if (ageMs >= this.maxStaleAgeSeconds * 1000) {
      this.cache.delete(key);
      return null;
    }
    const stale = ageMs > this.ttlSeconds * 1000;
    return { snapshot: entry.snapshot, cachedAt: entry.cachedAt, stale };
  }

  getFreshOrStale(symbol: string): CachedSnapshot | null {
    return this.get(symbol);
  }

  has(symbol: string): boolean {
    return this.get(symbol) !== null;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  get maxStaleAge(): number {
    return this.maxStaleAgeSeconds;
  }
}
