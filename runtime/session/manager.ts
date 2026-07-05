import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

// ── 会话状态接口 ────────────────────────────────────────────

export interface SessionState {
  activeAgentId: string;
  messages: unknown[];
  stepCount: number;
}

// ── SQLite 会话管理器 ───────────────────────────────────────

export class SessionManager {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      )
    `);
  }

  saveState(sessionId: string, state: SessionState): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO sessions (id, state) VALUES (?, ?)'
    );
    stmt.run(sessionId, JSON.stringify(state));
  }

  loadState(sessionId: string): SessionState | null {
    const stmt = this.db.prepare(
      'SELECT state FROM sessions WHERE id = ?'
    );
    const row = stmt.get(sessionId) as { state: string } | null;
    if (row == null) return null;
    return JSON.parse(row.state) as SessionState;
  }

  close(): void {
    this.db.close();
  }
}
