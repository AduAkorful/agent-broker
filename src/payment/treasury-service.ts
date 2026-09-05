import { B402_CONFIG, type B402Config, type TreasuryConfig } from "../config.js";
import { TreasuryStore } from "./treasury-store.js";

export type TreasuryCheckResult = { allowed: true } | { allowed: false; reason: string; message: string };

const ETHEREUM_ADDRESS_PATTERN = /^0[xX][a-fA-F0-9]{40}$/;

function isValidEthereumAddress(address: string): boolean {
  return ETHEREUM_ADDRESS_PATTERN.test(address);
}

export class TreasuryService {
  private readonly store: TreasuryStore;
  private readonly config: TreasuryConfig;

  constructor(options: { store?: TreasuryStore; config?: B402Config } = {}) {
    this.store = options.store ?? new TreasuryStore();
    this.config = (options.config ?? B402_CONFIG).treasury;
  }

  todayUtc(): string {
    const now = new Date();
    return now.toISOString().split("T")[0]!;
  }

  checkWithdrawal(amountAtomic: string, tokenAddress: string, destination: string): TreasuryCheckResult {
    if (!this.config.active) {
      return { allowed: false, reason: "treasury_inactive", message: "Treasury withdrawals are not active" };
    }

    if (!isValidEthereumAddress(tokenAddress)) {
      return {
        allowed: false,
        reason: "invalid_token_address",
        message: `Token address ${tokenAddress} is not a valid Ethereum address`,
      };
    }

    if (!isValidEthereumAddress(destination)) {
      return {
        allowed: false,
        reason: "invalid_destination",
        message: `Destination ${destination} is not a valid Ethereum address`,
      };
    }

    const normalizedToken = tokenAddress.toLowerCase();
    const tokenWhitelisted = this.config.tokenWhitelist.some((t) => t.toLowerCase() === normalizedToken);
    if (!tokenWhitelisted) {
      return {
        allowed: false,
        reason: "token_not_whitelisted",
        message: `Token ${tokenAddress} is not in the treasury token whitelist`,
      };
    }

    const normalizedDest = destination.toLowerCase();
    const destWhitelisted = this.config.withdrawalWhitelist.some((d) => d.toLowerCase() === normalizedDest);
    if (!destWhitelisted) {
      return {
        allowed: false,
        reason: "destination_not_whitelisted",
        message: `Destination ${destination} is not in the withdrawal whitelist`,
      };
    }

    if (!/^[0-9]+$/.test(amountAtomic)) {
      return {
        allowed: false,
        reason: "invalid_amount",
        message: "Withdrawal amount must be a positive integer string",
      };
    }

    const amount = BigInt(amountAtomic);
    if (amount <= 0n) {
      return { allowed: false, reason: "invalid_amount", message: "Withdrawal amount must be positive" };
    }

    const singleLimit = BigInt(this.config.singleLimitAtomic);
    if (amount > singleLimit) {
      return {
        allowed: false,
        reason: "exceeds_single_limit",
        message: `Amount exceeds single withdrawal limit of ${this.config.singleLimitAtomic}`,
      };
    }

    const today = this.todayUtc();
    const dailySpent = this.store.getDailyTotal(today, normalizedToken);
    const dailyLimit = BigInt(this.config.dailyLimitAtomic);
    if (dailySpent + amount > dailyLimit) {
      return {
        allowed: false,
        reason: "exceeds_daily_limit",
        message: `Amount would exceed daily limit of ${this.config.dailyLimitAtomic} (already spent: ${dailySpent.toString()})`,
      };
    }

    return { allowed: true };
  }

  recordWithdrawal(amountAtomic: string, tokenAddress: string, destination: string, signature?: string): void {
    const today = this.todayUtc();
    const normalizedToken = tokenAddress.toLowerCase();
    this.store.recordWithdrawal(today, normalizedToken, amountAtomic, destination, Date.now(), signature);
  }

  getDailySpent(tokenAddress: string): bigint {
    return this.store.getDailyTotal(this.todayUtc(), tokenAddress.toLowerCase());
  }

  getAllWithdrawals() {
    return this.store.getAllWithdrawals();
  }

  close(): void {
    this.store.close();
  }
}
