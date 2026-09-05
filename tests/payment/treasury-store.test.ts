import { afterEach, describe, expect, it } from "vitest";
import { TreasuryStore } from "../../src/payment/treasury-store.js";

describe("TreasuryStore", () => {
  let store: TreasuryStore;

  afterEach(() => {
    store?.close();
  });

  it("returns 0 daily total for a day with no withdrawals", () => {
    store = new TreasuryStore();
    expect(store.getDailyTotal("2026-09-03", "0xabc").toString()).toBe("0");
  });

  it("records and sums withdrawals per day and token", () => {
    store = new TreasuryStore();
    store.recordWithdrawal("2026-09-03", "0xtoken", "1000000000000000000", "0xdest", 1_000);
    store.recordWithdrawal("2026-09-03", "0xtoken", "500000000000000000", "0xdest", 2_000);
    expect(store.getDailyTotal("2026-09-03", "0xtoken").toString()).toBe("1500000000000000000");
  });

  it("does not sum withdrawals for different tokens", () => {
    store = new TreasuryStore();
    store.recordWithdrawal("2026-09-03", "0xtokenA", "100", "0xdest", 1_000);
    store.recordWithdrawal("2026-09-03", "0xtokenB", "200", "0xdest", 2_000);
    expect(store.getDailyTotal("2026-09-03", "0xtokenA").toString()).toBe("100");
    expect(store.getDailyTotal("2026-09-03", "0xtokenB").toString()).toBe("200");
  });

  it("does not sum withdrawals for different days", () => {
    store = new TreasuryStore();
    store.recordWithdrawal("2026-09-03", "0xtoken", "100", "0xdest", 1_000);
    store.recordWithdrawal("2026-09-04", "0xtoken", "200", "0xdest", 2_000);
    expect(store.getDailyTotal("2026-09-03", "0xtoken").toString()).toBe("100");
    expect(store.getDailyTotal("2026-09-04", "0xtoken").toString()).toBe("200");
  });

  it("returns all withdrawals ordered by timestamp descending", () => {
    store = new TreasuryStore();
    store.recordWithdrawal("2026-09-03", "0xtoken", "100", "0xdest1", 1_000, "sig1");
    store.recordWithdrawal("2026-09-03", "0xtoken", "200", "0xdest2", 3_000, "sig2");

    const all = store.getAllWithdrawals();
    expect(all).toHaveLength(2);
    expect(all[0]!.timestamp).toBe(3_000);
    expect(all[1]!.timestamp).toBe(1_000);
    expect(all[0]!.signature).toBe("sig2");
    expect(all[1]!.signature).toBe("sig1");
  });

  it("tracks withdrawal count", () => {
    store = new TreasuryStore();
    expect(store.getWithdrawalCount()).toBe(0);
    store.recordWithdrawal("2026-09-03", "0xtoken", "100", "0xdest", 1_000);
    expect(store.getWithdrawalCount()).toBe(1);
    store.recordWithdrawal("2026-09-03", "0xtoken", "200", "0xdest", 2_000);
    expect(store.getWithdrawalCount()).toBe(2);
  });

  it("reset() clears all withdrawals", () => {
    store = new TreasuryStore();
    store.recordWithdrawal("2026-09-03", "0xtoken", "100", "0xdest", 1_000);
    store.reset();
    expect(store.getWithdrawalCount()).toBe(0);
    expect(store.getDailyTotal("2026-09-03", "0xtoken").toString()).toBe("0");
  });

  it("handles large atomic amounts with BigInt precision", () => {
    store = new TreasuryStore();
    const large = "1000000000000000000000"; // 1000 tokens with 18 decimals
    store.recordWithdrawal("2026-09-03", "0xtoken", large, "0xdest", 1_000);
    expect(store.getDailyTotal("2026-09-03", "0xtoken").toString()).toBe(large);
  });
});
