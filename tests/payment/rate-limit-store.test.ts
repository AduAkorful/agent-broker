import { afterEach, describe, expect, it } from "vitest";
import { RateLimitStore } from "../../src/payment/rate-limit-store.js";

describe("RateLimitStore", () => {
  let store: RateLimitStore;

  afterEach(() => {
    store?.close();
  });

  it("allows requests up to the limit", () => {
    store = new RateLimitStore({ config: { maxRequests: 3, windowSeconds: 60 } });
    for (let i = 0; i < 3; i++) {
      const result = store.check("1.2.3.4");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2 - i);
    }
  });

  it("blocks requests beyond the limit", () => {
    store = new RateLimitStore({ config: { maxRequests: 3, windowSeconds: 60 } });
    for (let i = 0; i < 3; i++) store.check("1.2.3.4");

    const result = store.check("1.2.3.4");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("isolates rate limits per IP", () => {
    store = new RateLimitStore({ config: { maxRequests: 2, windowSeconds: 60 } });
    expect(store.check("1.1.1.1").allowed).toBe(true);
    expect(store.check("1.1.1.1").allowed).toBe(true);
    expect(store.check("1.1.1.1").allowed).toBe(false);

    expect(store.check("2.2.2.2").allowed).toBe(true);
    expect(store.check("2.2.2.2").allowed).toBe(true);
    expect(store.check("2.2.2.2").allowed).toBe(false);
  });

  it("resets the window for an IP after expiration (real time)", async () => {
    store = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 1 } });
    expect(store.check("10.0.0.1").allowed).toBe(true);
    expect(store.check("10.0.0.1").allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const result = store.check("10.0.0.1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("returns correct resetAt pointing to window end", () => {
    store = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 60 } });
    const result = store.check("1.2.3.4");
    expect(result.resetAt).toBeCloseTo(Date.now() + 60_000, -2);
  });

  it("reset() with an IP removes that IP's entry", () => {
    store = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 60 } });
    store.check("1.2.3.4");
    expect(store.getRemaining("1.2.3.4")).toBe(0);

    store.reset("1.2.3.4");
    expect(store.getRemaining("1.2.3.4")).toBe(1);
  });

  it("reset() with no arguments removes all entries", () => {
    store = new RateLimitStore({ config: { maxRequests: 1, windowSeconds: 60 } });
    store.check("1.1.1.1");
    store.check("2.2.2.2");

    store.reset();
    expect(store.getRemaining("1.1.1.1")).toBe(1);
    expect(store.getRemaining("2.2.2.2")).toBe(1);
  });

  it("getRemaining returns maxRequests for unseen IP", () => {
    store = new RateLimitStore({ config: { maxRequests: 5, windowSeconds: 60 } });
    expect(store.getRemaining("8.8.8.8")).toBe(5);
  });

  it("getRateLimitCount tracks the number of IPs in the store", () => {
    store = new RateLimitStore({ config: { maxRequests: 10, windowSeconds: 60 } });
    store.check("1.1.1.1");
    store.check("2.2.2.2");
    expect(store.getRateLimitCount()).toBe(2);
    store.reset();
    expect(store.getRateLimitCount()).toBe(0);
  });

  it("uses default config of 10 requests / 60 seconds", () => {
    store = new RateLimitStore();
    for (let i = 0; i < 10; i++) {
      expect(store.check("1.2.3.4").allowed).toBe(true);
    }
    expect(store.check("1.2.3.4").allowed).toBe(false);
  });
});
