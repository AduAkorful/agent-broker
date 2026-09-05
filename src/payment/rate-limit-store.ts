import Database from "better-sqlite3";
import type { RateLimitConfig } from "../config.js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class RateLimitStore {
  private readonly db: Database.Database;
  private readonly maxRequests: number;
  private readonly windowSeconds: number;
  private readonly selectStmt: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly incrementStmt: Database.Statement;
  private readonly deleteIpStmt: Database.Statement;
  private readonly deleteAllStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private _closed = false;

  constructor(options: { dbPath?: string; config?: RateLimitConfig } = {}) {
    const config = options.config ?? { maxRequests: 10, windowSeconds: 60 };
    this.maxRequests = config.maxRequests;
    this.windowSeconds = config.windowSeconds;
    this.db = new Database(options.dbPath ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        ip TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        window_start INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.selectStmt = this.db.prepare("SELECT count, window_start FROM rate_limits WHERE ip = ?");
    this.insertStmt = this.db.prepare(
      "INSERT INTO rate_limits (ip, count, window_start, updated_at) VALUES (?, 1, ?, ?)",
    );
    this.incrementStmt = this.db.prepare("UPDATE rate_limits SET count = count + 1, updated_at = ? WHERE ip = ?");
    this.deleteIpStmt = this.db.prepare("DELETE FROM rate_limits WHERE ip = ?");
    this.deleteAllStmt = this.db.prepare("DELETE FROM rate_limits");
    this.countStmt = this.db.prepare("SELECT COUNT(*) as count FROM rate_limits");
  }

  check(ip: string): RateLimitResult {
    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;
    const row = this.selectStmt.get(ip) as { count: number; window_start: number } | undefined;

    if (!row) {
      this.insertStmt.run(ip, now, now);
      return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + windowMs };
    }

    if (now - row.window_start >= windowMs) {
      this.deleteIpStmt.run(ip);
      this.insertStmt.run(ip, now, now);
      return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + windowMs };
    }

    if (row.count >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: row.window_start + windowMs };
    }

    this.incrementStmt.run(now, ip);
    return { allowed: true, remaining: this.maxRequests - row.count - 1, resetAt: row.window_start + windowMs };
  }

  getRemaining(ip: string): number {
    const row = this.selectStmt.get(ip) as { count: number; window_start: number } | undefined;
    if (!row) return this.maxRequests;

    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;
    if (now - row.window_start >= windowMs) return this.maxRequests;

    return Math.max(0, this.maxRequests - row.count);
  }

  reset(ip?: string): void {
    if (ip) {
      this.deleteIpStmt.run(ip);
    } else {
      this.deleteAllStmt.run();
    }
  }

  getRateLimitCount(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.db.close();
  }
}
