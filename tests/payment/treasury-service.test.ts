import { afterEach, describe, expect, it } from "vitest";
import { TreasuryService } from "../../src/payment/treasury-service.js";
import { TreasuryStore } from "../../src/payment/treasury-store.js";
import { B402_CONFIG, type B402Config, type TreasuryConfig } from "../../src/config.js";

const USDT = B402_CONFIG.tokens.usdt.address;
const USDC = B402_CONFIG.tokens.usdc.address;
const COLD_WALLET = B402_CONFIG.treasury.withdrawalWhitelist[0]!;
const UNKNOWN_TOKEN = "0x0000000000000000000000000000000000000002";
const UNAUTHORIZED_DEST = "0x0000000000000000000000000000000000000003";

function makeConfig(overrides: Partial<TreasuryConfig> = {}): B402Config {
  return {
    ...B402_CONFIG,
    treasury: { ...B402_CONFIG.treasury, ...overrides },
  };
}

describe("TreasuryService", () => {
  let store: TreasuryStore;
  let service: TreasuryService;

  afterEach(() => {
    service?.close();
  });

  describe("checkWithdrawal", () => {
    it("allows a valid withdrawal within all limits", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      const result = service.checkWithdrawal("500000000000000000", USDT, COLD_WALLET);
      expect(result.allowed).toBe(true);
    });

    it("rejects when treasury is inactive", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig({ active: false }) });

      const result = service.checkWithdrawal("500000000000000000", USDT, COLD_WALLET);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("treasury_inactive");
      }
    });

    it("rejects tokens not in the whitelist", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      const result = service.checkWithdrawal("500000000000000000", UNKNOWN_TOKEN, COLD_WALLET);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("token_not_whitelisted");
      }
    });

    it("rejects destinations not in the withdrawal whitelist", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      const result = service.checkWithdrawal("500000000000000000", USDT, UNAUTHORIZED_DEST);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("destination_not_whitelisted");
      }
    });

    it("rejects zero or negative amounts", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      expect(service.checkWithdrawal("0", USDT, COLD_WALLET).allowed).toBe(false);
      expect(service.checkWithdrawal("-1000", USDT, COLD_WALLET).allowed).toBe(false);
    });

    it("rejects amounts exceeding the single withdrawal limit", () => {
      store = new TreasuryStore();
      service = new TreasuryService({
        store,
        config: makeConfig({ singleLimitAtomic: "1000000000000000000" }),
      });

      const result = service.checkWithdrawal("2000000000000000000", USDT, COLD_WALLET);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("exceeds_single_limit");
      }
    });

    it("allows amounts exactly at the single withdrawal limit", () => {
      store = new TreasuryStore();
      service = new TreasuryService({
        store,
        config: makeConfig({ singleLimitAtomic: "1000000000000000000" }),
      });

      const result = service.checkWithdrawal("1000000000000000000", USDT, COLD_WALLET);
      expect(result.allowed).toBe(true);
    });

    it("rejects invalid token address format", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      const result = service.checkWithdrawal("500000000000000000", "not-an-address", COLD_WALLET);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("invalid_token_address");
      }
    });

    it("rejects invalid destination address format", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      const result = service.checkWithdrawal("500000000000000000", USDT, "0xbad");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("invalid_destination");
      }
    });
  });

  describe("daily limit enforcement", () => {
    it("rejects withdrawals that would exceed the daily limit", () => {
      store = new TreasuryStore();
      service = new TreasuryService({
        store,
        config: makeConfig({ dailyLimitAtomic: "1000000000000000000", singleLimitAtomic: "1000000000000000000" }),
      });

      service.recordWithdrawal("1000000000000000000", USDT, COLD_WALLET);

      const result = service.checkWithdrawal("1", USDT, COLD_WALLET);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("exceeds_daily_limit");
      }
    });

    it("allows a second withdrawal within the daily limit", () => {
      store = new TreasuryStore();
      service = new TreasuryService({
        store,
        config: makeConfig({ dailyLimitAtomic: "2000000000000000000", singleLimitAtomic: "2000000000000000000" }),
      });

      service.recordWithdrawal("1000000000000000000", USDT, COLD_WALLET);

      const result = service.checkWithdrawal("500000000000000000", USDT, COLD_WALLET);
      expect(result.allowed).toBe(true);
    });

    it("tracks daily totals per token independently", () => {
      store = new TreasuryStore();
      service = new TreasuryService({
        store,
        config: makeConfig({ dailyLimitAtomic: "1000000000000000000", singleLimitAtomic: "1000000000000000000" }),
      });

      service.recordWithdrawal("1000000000000000000", USDT, COLD_WALLET);

      expect(service.getDailySpent(USDT).toString()).toBe("1000000000000000000");
      expect(service.getDailySpent(USDC).toString()).toBe("0");
    });
  });

  describe("recordWithdrawal", () => {
    it("stores the withdrawal with signature if provided", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      service.recordWithdrawal("500000000000000000", USDT, COLD_WALLET, "0xsignature");

      const history = service.getAllWithdrawals();
      expect(history).toHaveLength(1);
      expect(history[0]!.signature).toBe("0xsignature");
      expect(history[0]!.token).toBe(USDT.toLowerCase());
    });

    it("stores the withdrawal without a signature if not provided", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      service.recordWithdrawal("500000000000000000", USDT, COLD_WALLET);

      const history = service.getAllWithdrawals();
      expect(history).toHaveLength(1);
      expect(history[0]!.signature).toBeUndefined();
    });
  });

  describe("case-insensitive matching", () => {
    it("matches token addresses case-insensitively", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      const result = service.checkWithdrawal("500000000000000000", USDT.toUpperCase(), COLD_WALLET);
      expect(result).toEqual({ allowed: true });
    });

    it("matches destination addresses case-insensitively", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      const result = service.checkWithdrawal("500000000000000000", USDT, COLD_WALLET.toUpperCase());
      expect(result).toEqual({ allowed: true });
    });

    it("rejects non-integer-string amounts without throwing", () => {
      store = new TreasuryStore();
      service = new TreasuryService({ store, config: makeConfig() });

      expect(service.checkWithdrawal("1.5", USDT, COLD_WALLET).allowed).toBe(false);
      expect(service.checkWithdrawal("abc", USDT, COLD_WALLET).allowed).toBe(false);
      expect(service.checkWithdrawal("", USDT, COLD_WALLET).allowed).toBe(false);
      expect(service.checkWithdrawal("1e10", USDT, COLD_WALLET).allowed).toBe(false);
    });
  });
});
