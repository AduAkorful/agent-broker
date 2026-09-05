import Database from "better-sqlite3";

export interface WithdrawalRecord {
  date: string;
  token: string;
  amount: string;
  destination: string;
  timestamp: number;
  signature?: string;
}

export class TreasuryStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly dailyTotalStmt: Database.Statement;
  private readonly selectAllStmt: Database.Statement;
  private readonly resetStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private _closed = false;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS treasury_withdrawals (
        date TEXT NOT NULL,
        token TEXT NOT NULL,
        amount TEXT NOT NULL,
        destination TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        signature TEXT
      )
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO treasury_withdrawals (date, token, amount, destination, timestamp, signature)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.dailyTotalStmt = this.db.prepare(`
      SELECT amount FROM treasury_withdrawals
      WHERE date = ? AND token = ?
    `);
    this.selectAllStmt = this.db.prepare(`
      SELECT date, token, amount, destination, timestamp, signature
      FROM treasury_withdrawals
      ORDER BY timestamp DESC
    `);
    this.resetStmt = this.db.prepare("DELETE FROM treasury_withdrawals");
    this.countStmt = this.db.prepare("SELECT COUNT(*) as count FROM treasury_withdrawals");
  }

  recordWithdrawal(
    date: string,
    token: string,
    amountAtomic: string,
    destination: string,
    timestamp: number,
    signature?: string,
  ): void {
    this.insertStmt.run(date, token, amountAtomic, destination, timestamp, signature ?? null);
  }

  getDailyTotal(date: string, token: string): bigint {
    const rows = this.dailyTotalStmt.all(date, token) as Array<{ amount: string }>;
    return rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  }

  getAllWithdrawals(): WithdrawalRecord[] {
    const rows = this.selectAllStmt.all() as Array<{
      date: string;
      token: string;
      amount: string;
      destination: string;
      timestamp: number;
      signature: string | null;
    }>;
    return rows.map((row) => ({
      date: row.date,
      token: row.token,
      amount: row.amount,
      destination: row.destination,
      timestamp: row.timestamp,
      signature: row.signature ?? undefined,
    }));
  }

  getWithdrawalCount(): number {
    return (this.countStmt.get() as { count: number }).count;
  }

  reset(): void {
    this.resetStmt.run();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.db.close();
  }
}
