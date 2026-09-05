import Database from "better-sqlite3";
import type { CvmsScore } from "./types.js";

export interface HistoryRecord {
  id: number;
  symbol: string;
  fetched_at: number;
  score_json: string;
  sources: string;
  confidence: number;
  data_age_ms: number;
}

export class ScoreHistoryStore {
  readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly selectBySymbolStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly deleteExpiredStmt: Database.Statement;
  private readonly deleteOldestStmt: Database.Statement;
  private _closed = false;

  constructor(
    dbPath: string = ":memory:",
    private readonly maxSize: number = 10_000,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS score_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        score_json TEXT NOT NULL,
        sources TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        data_age_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_score_history_symbol ON score_history(symbol)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_score_history_fetched_at ON score_history(fetched_at)`);
    this.insertStmt = this.db.prepare(`
      INSERT INTO score_history (symbol, fetched_at, score_json, sources, confidence, data_age_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.selectBySymbolStmt = this.db.prepare(`
      SELECT id, symbol, fetched_at, score_json, sources, confidence, data_age_ms
      FROM score_history WHERE symbol = ? ORDER BY fetched_at DESC LIMIT ?
    `);
    this.deleteStmt = this.db.prepare("DELETE FROM score_history WHERE symbol = ?");
    this.countStmt = this.db.prepare("SELECT COUNT(*) as count FROM score_history");
    this.deleteExpiredStmt = this.db.prepare(`
      DELETE FROM score_history WHERE created_at < ?
    `);
    this.deleteOldestStmt = this.db.prepare(`
      DELETE FROM score_history WHERE id NOT IN (
        SELECT id FROM score_history ORDER BY fetched_at DESC LIMIT ?
      )
    `);
  }

  recordScore(symbol: string, score: CvmsScore, sources: string[], confidence: number, dataAgeMs: number): void {
    const fetchedAt = score.timestamp;
    const scoreJson = JSON.stringify(score);
    const sourcesJson = JSON.stringify(sources);
    this.insertStmt.run(symbol, fetchedAt, scoreJson, sourcesJson, confidence, dataAgeMs);
    this.evictOverflow();
  }

  private evictOverflow(): void {
    if (this.maxSize <= 0) return;
    const count = this.getHistoryCount();
    if (count > this.maxSize) {
      this.deleteOldestStmt.run(this.maxSize);
    }
  }

  cleanupExpired(beforeTimestamp: number): number {
    const info = this.deleteExpiredStmt.run(beforeTimestamp);
    return info.changes;
  }

  scheduleCleanup(intervalMs: number): { stop: () => void } {
    const interval = setInterval(() => {
      const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3_600;
      this.cleanupExpired(cutoff);
      this.evictOverflow();
    }, intervalMs);
    interval.unref();
    return { stop: () => clearInterval(interval) };
  }

  getHistory(symbol: string, limit: number): HistoryRecord[] {
    const rows = this.selectBySymbolStmt.all(symbol, limit) as HistoryRecord[];
    return rows;
  }

  clearSymbol(symbol: string): number {
    const info = this.deleteStmt.run(symbol);
    return info.changes;
  }

  getHistoryCount(): number {
    return (this.countStmt.get() as { count: number }).count;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.db.close();
  }
}
