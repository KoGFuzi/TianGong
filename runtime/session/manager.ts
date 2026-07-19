import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

// ── 会话状态接口 ────────────────────────────────────────────

export interface SessionState {
  activeAgentId: string;
  messages: unknown[];
  stepCount: number;
  summaryCache?: string;       // 摘要缓存（供后续 Task 4 使用）
  todoList?: Array<{ text: string; done: boolean }>;  // TODO 任务列表
  currentTask?: string;        // 当前焦点任务
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

  /** 列出所有会话的元数据摘要 */
  listSessions(): Array<{ id: string; messageCount: number; stepCount: number; createdAt: number }> {
    const rows = this.db.prepare(
      'SELECT id, state FROM sessions'
    ).all() as Array<{ id: string; state: string }>;

    return rows.map(row => {
      try {
        const state = JSON.parse(row.state) as SessionState;
        return {
          id: row.id,
          messageCount: state.messages.length,
          stepCount: state.stepCount,
          createdAt: 0, // SQLite 未存储时间戳，用 0 占位
        };
      } catch {
        return { id: row.id, messageCount: 0, stepCount: 0, createdAt: 0 };
      }
    });
  }

  /** 获取会话的摘要缓存 */
  getSessionSummary(sessionId: string): string | null {
    const state = this.loadState(sessionId);
    return state?.summaryCache ?? null;
  }
}
