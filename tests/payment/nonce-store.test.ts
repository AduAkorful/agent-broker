import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NonceStore } from "../../src/payment/nonce-store.js";

describe("NonceStore", () => {
  let store: NonceStore;

  afterEach(() => {
    store?.close();
  });

  it("generates a nonce with 0x prefix and 32 bytes of entropy", () => {
    store = new NonceStore();
    const nonce = store.generateNonce();
    expect(nonce).toMatch(/^0x[a-f0-9]{64}$/);
    expect(nonce.startsWith("0x")).toBe(true);
  });

  it("generates unique nonces", () => {
    store = new NonceStore();
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      nonces.add(store.generateNonce());
    }
    expect(nonces.size).toBe(100);
  });

  it("stores generated nonce", () => {
    store = new NonceStore();
    const nonce = store.generateNonce();
    expect(store.hasNonce(nonce)).toBe(true);
  });

  it("reports unknown nonces as not present", () => {
    store = new NonceStore();
    expect(store.hasNonce("0xdeadbeef")).toBe(false);
  });

  it("marks generated nonces as unused initially", () => {
    store = new NonceStore();
    const nonce = store.generateNonce();
    expect(store.isNonceUsed(nonce)).toBe(false);
  });

  it("marks used nonces correctly after marking", () => {
    store = new NonceStore();
    const nonce = store.generateNonce();
    expect(store.isNonceUsed(nonce)).toBe(false);
    store.markNonceUsed(nonce);
    expect(store.isNonceUsed(nonce)).toBe(true);
  });

  it("returns false for unknown nonces in isNonceUsed", () => {
    store = new NonceStore();
    expect(store.isNonceUsed("0xunknown")).toBe(false);
  });

  it("isNonceValid returns true for fresh nonces, false for used/expired/unknown", () => {
    store = new NonceStore();
    const nonce = store.generateNonce();
    const maxAgeMs = 3_600_000;

    // Fresh nonce is valid
    expect(store.isNonceValid(nonce, maxAgeMs)).toBe(true);

    // Unknown nonce is invalid
    expect(store.isNonceValid("0xunknown", maxAgeMs)).toBe(false);

    // Used nonce is invalid
    store.markNonceUsed(nonce);
    expect(store.isNonceValid(nonce, maxAgeMs)).toBe(false);
  });

  it("isNonceValid rejects nonces older than maxAgeMs", () => {
    store = new NonceStore();
    // Generate a nonce and manipulate created_at to be old
    const nonce = store.generateNonce();
    store.db.prepare("UPDATE nonces SET created_at = ? WHERE nonce = ?").run(Date.now() - 4_000_000, nonce);
    expect(store.isNonceValid(nonce, 3_600_000)).toBe(false);
  });

  it("isNonceValid rejects nonces longer than 256 chars", () => {
    store = new NonceStore();
    const longNonce = "0x" + "a".repeat(300);
    expect(store.isNonceValid(longNonce, 3_600_000)).toBe(false);
  });

  it("returns all nonces via getAllNonces", () => {
    store = new NonceStore();
    const nonce1 = store.generateNonce();
    const nonce2 = store.generateNonce();
    store.markNonceUsed(nonce1);
    const all = store.getAllNonces();
    expect(all).toHaveLength(2);
    expect(all.some((n) => n.nonce === nonce1 && n.used === true)).toBe(true);
    expect(all.some((n) => n.nonce === nonce2 && n.used === false)).toBe(true);
  });

  it("cleanupExpired does not remove used nonces even if old", () => {
    store = new NonceStore();
    const nonce1 = store.generateNonce();
    const nonce2 = store.generateNonce();
    store.markNonceUsed(nonce1);

    const oldTimestamp = Date.now() - 7_200_000; // 2 hours ago
    store.db.exec(`UPDATE nonces SET created_at = ${oldTimestamp} WHERE nonce = '${nonce1}'`);

    const deleted = store.cleanupExpired(oldTimestamp + 1);
    expect(deleted).toBe(0);
    expect(store.hasNonce(nonce1)).toBe(true);
    expect(store.hasNonce(nonce2)).toBe(true);
  });

  it("cleanupExpired removes unused expired nonces and keeps recent ones", () => {
    store = new NonceStore();
    const recent = store.generateNonce();
    const expired = store.generateNonce();

    const oldTimestamp = Date.now() - 7_200_000;
    store.db.exec(`UPDATE nonces SET created_at = ${oldTimestamp} WHERE nonce = '${expired}'`);

    const deleted = store.cleanupExpired(oldTimestamp + 1);
    expect(deleted).toBe(1);
    expect(store.hasNonce(recent)).toBe(true);
    expect(store.hasNonce(expired)).toBe(false);
  });

  it("getNonceCount returns the number of stored nonces", () => {
    store = new NonceStore();
    expect(store.getNonceCount()).toBe(0);
    store.generateNonce();
    store.generateNonce();
    store.generateNonce();
    expect(store.getNonceCount()).toBe(3);
  });

  describe("consumeNonce", () => {
    it("successfully consumes a fresh unused nonce", () => {
      store = new NonceStore();
      const nonce = store.generateNonce();
      const result = store.consumeNonce(nonce, 3600_000);
      expect(result.success).toBe(true);
      expect(result.reason).toBe("ok");
    });

    it("returns already_used for a previously consumed nonce", () => {
      store = new NonceStore();
      const nonce = store.generateNonce();
      store.consumeNonce(nonce, 3600_000);
      const result = store.consumeNonce(nonce, 3600_000);
      expect(result.success).toBe(false);
      expect(result.reason).toBe("already_used");
    });

    it("returns already_used for a nonce marked used via markNonceUsed", () => {
      store = new NonceStore();
      const nonce = store.generateNonce();
      store.markNonceUsed(nonce);
      const result = store.consumeNonce(nonce, 3600_000);
      expect(result.success).toBe(false);
      expect(result.reason).toBe("already_used");
    });

    it("returns unknown for a nonce not in the store", () => {
      store = new NonceStore();
      const result = store.consumeNonce("0xnonexistent", 3600_000);
      expect(result.success).toBe(false);
      expect(result.reason).toBe("unknown");
    });

    it("returns expired for a nonce older than maxAgeMs", () => {
      store = new NonceStore();
      const nonce = store.generateNonce();
      const oldTimestamp = Date.now() - 7_200_000; // 2 hours ago
      store.db.exec(`UPDATE nonces SET created_at = ${oldTimestamp} WHERE nonce = '${nonce}'`);
      const result = store.consumeNonce(nonce, 3_600_000); // 1 hour max age
      expect(result.success).toBe(false);
      expect(result.reason).toBe("expired");
    });

    it("consumes nonce atomically regardless of maxAge", () => {
      store = new NonceStore();
      const nonce = store.generateNonce();
      const result = store.consumeNonce(nonce, 7200_000);
      expect(result.success).toBe(true);
      expect(store.isNonceUsed(nonce)).toBe(true);
    });
  });

  describe("file-backed persistence", () => {
    it("persists nonces across separate store instances with same dbPath", () => {
      const dbFile = join(tmpdir(), `nonce-test-${process.pid}-${Date.now()}.sqlite`);
      if (existsSync(dbFile)) unlinkSync(dbFile);

      store = new NonceStore(dbFile);
      const nonce = store.generateNonce();
      expect(store.hasNonce(nonce)).toBe(true);
      store.close();

      store = new NonceStore(dbFile);
      expect(store.hasNonce(nonce)).toBe(true);
      expect(store.getNonceCount()).toBe(1);
      store.close();

      if (existsSync(dbFile)) unlinkSync(dbFile);
    });

    it("persists consumed (used) state across store instances", () => {
      const dbFile = join(tmpdir(), `nonce-test-${process.pid}-${Date.now()}.sqlite`);
      if (existsSync(dbFile)) unlinkSync(dbFile);

      store = new NonceStore(dbFile);
      const nonce = store.generateNonce();
      const result = store.consumeNonce(nonce, 3600_000);
      expect(result.success).toBe(true);
      store.close();

      store = new NonceStore(dbFile);
      expect(store.hasNonce(nonce)).toBe(true);
      expect(store.isNonceUsed(nonce)).toBe(true);
      store.close();

      if (existsSync(dbFile)) unlinkSync(dbFile);
    });
  });
});
