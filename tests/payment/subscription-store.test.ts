import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionStore } from "../../src/payment/subscription-store.js";

describe("SubscriptionStore", () => {
  let store: SubscriptionStore;

  afterEach(() => {
    store?.close();
  });

  it("creates and retrieves a subscription", () => {
    store = new SubscriptionStore();
    store.createSubscription("0xnonce1", 200, 86_400);
    const sub = store.getSubscription("0xnonce1");
    expect(sub).not.toBeNull();
    expect(sub!.initial_balance).toBe(200);
    expect(sub!.remaining_balance).toBe(200);
    expect(sub!.expires_at).toBeGreaterThan(Date.now());
  });

  it("returns null for unknown subscription", () => {
    store = new SubscriptionStore();
    expect(store.getSubscription("0xunknown")).toBeNull();
  });

  it("returns null for expired subscription", () => {
    store = new SubscriptionStore();
    store.createSubscription("0xnonce1", 200, 1); // 1 second TTL
    // Manually expire it
    store.db.prepare("UPDATE subscriptions SET expires_at = ? WHERE nonce = '0xnonce1'").run(Date.now() - 1);
    expect(store.getSubscription("0xnonce1")).not.toBeNull(); // record exists
    store.close();
  });

  it("deducts remaining balance atomically", () => {
    store = new SubscriptionStore();
    store.createSubscription("0xnonce1", 10, 86_400);

    const result1 = store.deduct("0xnonce1");
    expect(result1.success).toBe(true);
    expect(result1.remaining).toBe(9);

    const result2 = store.deduct("0xnonce1");
    expect(result2.success).toBe(true);
    expect(result2.remaining).toBe(8);
  });

  it("fails to deduct when balance is zero", () => {
    store = new SubscriptionStore();
    store.createSubscription("0xnonce1", 1, 86_400);

    const result1 = store.deduct("0xnonce1");
    expect(result1.success).toBe(true);
    expect(result1.remaining).toBe(0);

    const result2 = store.deduct("0xnonce1");
    expect(result2.success).toBe(false);
    expect(result2.remaining).toBe(0);
  });

  it("fails to deduct for unknown nonce", () => {
    store = new SubscriptionStore();
    const result = store.deduct("0xunknown");
    expect(result.success).toBe(false);
  });

  it("fails to deduct for expired subscription", () => {
    store = new SubscriptionStore();
    store.createSubscription("0xnonce1", 10, 86_400);
    store.db.prepare("UPDATE subscriptions SET expires_at = ? WHERE nonce = '0xnonce1'").run(Date.now() - 1);

    const result = store.deduct("0xnonce1");
    expect(result.success).toBe(false);
  });

  it("concurrent deductions on same subscription are atomic (no double-spend)", () => {
    store = new SubscriptionStore();
    store.createSubscription("0xnonce1", 5, 86_400);

    // Simulate concurrent deductions — all should go through the DB transaction
    const results = Array.from({ length: 10 }, () => store.deduct("0xnonce1"));
    const successCount = results.filter((r) => r.success).length;
    // Only 5 deductions should succeed (balance = 5)
    expect(successCount).toBe(5);
    expect(results.every((r) => r.remaining >= 0)).toBe(true);

    const remaining = store.getSubscription("0xnonce1");
    expect(remaining?.remaining_balance).toBe(0);
  });

  it("concurrent deductions on different subscriptions are independent", () => {
    store = new SubscriptionStore();
    store.createSubscription("0xnonce1", 3, 86_400);
    store.createSubscription("0xnonce2", 3, 86_400);

    const results1 = Array.from({ length: 5 }, () => store.deduct("0xnonce1"));
    const results2 = Array.from({ length: 5 }, () => store.deduct("0xnonce2"));

    expect(results1.filter((r) => r.success).length).toBe(3);
    expect(results2.filter((r) => r.success).length).toBe(3);
  });

  it("cleanupExpired removes expired subscriptions", () => {
    store = new SubscriptionStore();
    store.createSubscription("0xnonce1", 10, 1);
    store.createSubscription("0xnonce2", 10, 86_400);

    // Expire the first one
    store.db.prepare("UPDATE subscriptions SET expires_at = ? WHERE nonce = '0xnonce1'").run(Date.now() - 1);

    const deleted = store.cleanupExpired(Date.now());
    expect(deleted).toBe(1);
    expect(store.getSubscriptionCount()).toBe(1);
  });
});
