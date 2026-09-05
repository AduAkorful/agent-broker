import Database from "better-sqlite3";

export interface SubscriptionRecord {
  nonce: string;
  initial_balance: number;
  remaining_balance: number;
  expires_at: number;
  created_at: number;
  /** Optional payer address binding (PAY-H1). */
  payer?: string | null;
}

export class SubscriptionStore {
  readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly selectStmt: Database.Statement;
  private readonly deductStmt: Database.Statement;
  private readonly deleteExpiredStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private _closed = false;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        nonce TEXT PRIMARY KEY,
        initial_balance INTEGER NOT NULL,
        remaining_balance INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        payer TEXT
      )
    `);
    // Migrate older DBs missing payer column
    const cols = this.db.prepare("PRAGMA table_info(subscriptions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "payer")) {
      this.db.exec("ALTER TABLE subscriptions ADD COLUMN payer TEXT");
    }
    this.insertStmt = this.db.prepare(`
      INSERT INTO subscriptions (nonce, initial_balance, remaining_balance, expires_at, created_at, payer)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.selectStmt = this.db.prepare(`
      SELECT nonce, initial_balance, remaining_balance, expires_at, created_at, payer
      FROM subscriptions WHERE nonce = ?
    `);
    this.deductStmt = this.db.prepare(`
      UPDATE subscriptions
      SET remaining_balance = remaining_balance - 1
      WHERE nonce = ? AND remaining_balance > 0 AND expires_at > ?
    `);
    this.deleteExpiredStmt = this.db.prepare("DELETE FROM subscriptions WHERE expires_at < ?");
    this.countStmt = this.db.prepare("SELECT COUNT(*) as count FROM subscriptions");
  }

  createSubscription(nonce: string, initialBalance: number, ttlSeconds: number, payer?: string): void {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    this.insertStmt.run(nonce, initialBalance, initialBalance, expiresAt, now, payer ?? null);
  }

  getSubscription(nonce: string): SubscriptionRecord | null {
    const row = this.selectStmt.get(nonce) as
      | {
          nonce: string;
          initial_balance: number;
          remaining_balance: number;
          expires_at: number;
          created_at: number;
          payer: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      nonce: row.nonce,
      initial_balance: row.initial_balance,
      remaining_balance: row.remaining_balance,
      expires_at: row.expires_at,
      created_at: row.created_at,
      payer: row.payer,
    };
  }

  deduct(nonce: string): { success: boolean; remaining: number } {
    const now = Date.now();
    const result = this.deductStmt.run(nonce, now);
    if (result.changes === 0) return { success: false, remaining: 0 };
    const row = this.selectStmt.get(nonce) as { remaining_balance: number } | undefined;
    return { success: true, remaining: row ? row.remaining_balance : 0 };
  }

  verifyAndDeduct(nonce: string): { valid: boolean; remaining: number } {
    const result = this.deduct(nonce);
    if (!result.success) return { valid: false, remaining: 0 };
    return { valid: true, remaining: result.remaining };
  }

  cleanupExpired(beforeTimestamp: number): number {
    const info = this.deleteExpiredStmt.run(beforeTimestamp);
    return info.changes;
  }

  getSubscriptionCount(): number {
    return (this.countStmt.get() as { count: number }).count;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.db.close();
  }
}
