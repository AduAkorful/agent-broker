import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export interface NonceRecord {
  nonce: string;
  used: boolean;
  createdAt: number;
  usedAt: number | null;
}

export class NonceStore {
  readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly hasStmt: Database.Statement;
  private readonly usedStmt: Database.Statement;
  private readonly markUsedStmt: Database.Statement;
  private readonly consumeStmt: Database.Statement;
  private readonly deleteExpiredStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly isValidStmt: Database.Statement;
  private _closed = false;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nonces (
        nonce TEXT PRIMARY KEY,
        used INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      )
    `);
    this.insertStmt = this.db.prepare("INSERT INTO nonces (nonce, created_at) VALUES (?, ?)");
    this.hasStmt = this.db.prepare("SELECT 1 FROM nonces WHERE nonce = ?");
    this.usedStmt = this.db.prepare("SELECT used FROM nonces WHERE nonce = ?");
    this.markUsedStmt = this.db.prepare("UPDATE nonces SET used = 1, used_at = ? WHERE nonce = ?");
    this.consumeStmt = this.db.prepare(
      "UPDATE nonces SET used = 1, used_at = ? WHERE nonce = ? AND used = 0 AND created_at > ?",
    );
    this.deleteExpiredStmt = this.db.prepare("DELETE FROM nonces WHERE created_at < ? AND used = 0");
    this.countStmt = this.db.prepare("SELECT COUNT(*) as count FROM nonces");
    this.isValidStmt = this.db.prepare("SELECT 1 FROM nonces WHERE nonce = ? AND used = 0 AND created_at > ?");
  }

  generateNonce(): string {
    const nonce = `0x${randomBytes(32).toString("hex")}`;
    const now = Date.now();
    this.insertStmt.run(nonce, now);
    return nonce;
  }

  hasNonce(nonce: string): boolean {
    const row = this.hasStmt.get(nonce) as { 1?: number } | undefined;
    return Boolean(row);
  }

  isNonceUsed(nonce: string): boolean {
    const row = this.usedStmt.get(nonce) as { used: number } | undefined;
    return row ? row.used === 1 : false;
  }

  isNonceValid(nonce: string, maxAgeMs: number): boolean {
    if (typeof nonce !== "string" || nonce.length > 256) return false;
    const now = Date.now();
    const minCreatedAt = now - maxAgeMs;
    const row = this.isValidStmt.get(nonce, minCreatedAt) as { 1?: number } | undefined;
    return Boolean(row);
  }

  markNonceUsed(nonce: string): void {
    this.markUsedStmt.run(Date.now(), nonce);
  }

  consumeNonce(
    nonce: string,
    maxAgeMs: number,
  ): { success: boolean; reason: "ok" | "unknown" | "already_used" | "expired" | "nonce_too_long" } {
    if (typeof nonce !== "string" || nonce.length > 256) return { reason: "nonce_too_long" as const, success: false };
    const now = Date.now();
    const minCreatedAt = now - maxAgeMs;
    const result = this.consumeStmt.run(now, nonce, minCreatedAt);
    if (result.changes > 0) return { success: true, reason: "ok" };
    if (!this.hasNonce(nonce)) return { success: false, reason: "unknown" };
    if (this.isNonceUsed(nonce)) return { success: false, reason: "already_used" };
    return { success: false, reason: "expired" };
  }

  cleanupExpired(beforeTimestamp: number): number {
    const info = this.deleteExpiredStmt.run(beforeTimestamp);
    return info.changes;
  }

  getNonceCount(): number {
    return (this.countStmt.get() as { count: number }).count;
  }

  getAllNonces(): NonceRecord[] {
    const rows = this.db
      .prepare("SELECT nonce, used, created_at as createdAt, used_at as usedAt FROM nonces ORDER BY created_at DESC")
      .all() as Array<{ nonce: string; used: number; createdAt: number; usedAt: number | null }>;
    return rows.map((row) => ({
      nonce: row.nonce,
      used: row.used === 1,
      createdAt: row.createdAt,
      usedAt: row.usedAt,
    }));
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.db.close();
  }
}
