import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

// ── 接口定义 ─────────────────────────────────────────────────

/** Embedding 生成策略接口 — 可替换的具体实现 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/** 向量检索结果 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** 记忆记录结构 */
export interface MemoryRecord {
  content: string;
  category: string;
  tags: string[];
  createdAt: number;
}

/** VectorStore 构造选项 */
export interface VectorStoreOptions {
  /** 向量维度，sqlite-vec 模式下必填 */
  dimensions?: number;
}

// ── 向量存储引擎 ─────────────────────────────────────────────

/**
 * 基于 bun:sqlite 的向量存储与检索引擎。
 *
 * 优先尝试加载 sqlite-vec 扩展以获得原生向量索引支持（L2 距离检索），
 * 若加载失败则自动降级为 JSON 序列化 + JS 层余弦相似度计算。
 *
 * 通过 `backend` 属性可查询当前实际使用的后端。
 */
export class VectorStore {
  private db: Database;
  private readonly useVec: boolean;
  private readonly dimensions: number;

  /** 当前使用的存储后端: "sqlite-vec" 或 "json" */
  readonly backend: 'sqlite-vec' | 'json';

  constructor(dbPath: string, options?: VectorStoreOptions) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.dimensions = options?.dimensions ?? 384;

    // 尝试加载 sqlite-vec 扩展
    this.useVec = this.tryLoadVecExtension();
    this.backend = this.useVec ? 'sqlite-vec' : 'json';

    this.initTables();
  }

  // ── 扩展加载 ─────────────────────────────────────────────

  private tryLoadVecExtension(): boolean {
    try {
      // sqlite-vec 提供 getLoadablePath() 获取原生扩展路径
      const sqliteVec = require('sqlite-vec') as { getLoadablePath(): string };
      this.db.loadExtension(sqliteVec.getLoadablePath());
      return true;
    } catch {
      return false;
    }
  }

  // ── 初始化 ───────────────────────────────────────────────

  private initTables(): void {
    if (this.useVec) {
      // sqlite-vec 模式：vec0 虚拟表 + 元数据表
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_store USING vec0(
          embedding float[${this.dimensions}]
        );
        CREATE TABLE IF NOT EXISTS vec_metadata (
          rowid INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          metadata TEXT NOT NULL DEFAULT '{}'
        );
      `);
    } else {
      // JSON 降级模式
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vector_store (
          id TEXT PRIMARY KEY,
          embedding TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}'
        )
      `);
    }
  }

  // ── 存储 ─────────────────────────────────────────────────

  /** 存储向量及其元数据 */
  store(id: string, embedding: number[], metadata: Record<string, unknown>): void {
    if (this.useVec) {
      this.storeVec(id, embedding, metadata);
    } else {
      this.storeJson(id, embedding, metadata);
    }
  }

  private storeVec(id: string, embedding: number[], metadata: Record<string, unknown>): void {
    // 若已存在同名 id，先删除旧记录
    const existing = this.db
      .prepare('SELECT rowid FROM vec_metadata WHERE id = ?')
      .get(id) as { rowid: number } | null;

    if (existing != null) {
      this.db.prepare('DELETE FROM vec_store WHERE rowid = ?').run(existing.rowid);
      this.db.prepare('DELETE FROM vec_metadata WHERE rowid = ?').run(existing.rowid);
    }

    // 插入向量 — vec0 使用 INSERT 时自动生成 rowid
    const result = this.db
      .prepare('INSERT INTO vec_store (embedding) VALUES (?)')
      .run(JSON.stringify(embedding));
    const rowid = Number(result.lastInsertRowid);

    // 插入元数据，显式指定 rowid 与向量表对齐
    this.db
      .prepare('INSERT INTO vec_metadata (rowid, id, metadata) VALUES (?, ?, ?)')
      .run(rowid, id, JSON.stringify(metadata));
  }

  private storeJson(id: string, embedding: number[], metadata: Record<string, unknown>): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO vector_store (id, embedding, metadata) VALUES (?, ?, ?)'
    );
    stmt.run(id, JSON.stringify(embedding), JSON.stringify(metadata));
  }

  // ── 检索 ─────────────────────────────────────────────────

  /**
   * 相似度检索，返回最相似的 topK 条记录。
   *
   * - sqlite-vec 后端：使用 L2 距离排序
   * - json 后端：使用余弦相似度排序
   */
  search(queryEmbedding: number[], topK: number = 5): VectorSearchResult[] {
    if (this.useVec) {
      return this.searchVec(queryEmbedding, topK);
    }
    return this.searchJson(queryEmbedding, topK);
  }

  private searchVec(queryEmbedding: number[], topK: number): VectorSearchResult[] {
    const rows = this.db
      .prepare(
        'SELECT v.rowid, v.distance, m.id, m.metadata ' +
        'FROM vec_store v JOIN vec_metadata m ON v.rowid = m.rowid ' +
        'WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?'
      )
      .all(JSON.stringify(queryEmbedding), topK) as Array<{
        rowid: number;
        distance: number;
        id: string;
        metadata: string;
      }>;

    return rows.map(row => ({
      id: row.id,
      score: row.distance,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    }));
  }

  private searchJson(queryEmbedding: number[], topK: number): VectorSearchResult[] {
    const rows = this.db
      .prepare('SELECT id, embedding, metadata FROM vector_store')
      .all() as Array<{ id: string; embedding: string; metadata: string }>;

    const scored: VectorSearchResult[] = [];

    for (const row of rows) {
      const stored: number[] = JSON.parse(row.embedding);
      const score = cosineSimilarity(queryEmbedding, stored);
      scored.push({
        id: row.id,
        score,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // ── 删除 ─────────────────────────────────────────────────

  /** 删除指定向量记录 */
  delete(id: string): void {
    if (this.useVec) {
      const existing = this.db
        .prepare('SELECT rowid FROM vec_metadata WHERE id = ?')
        .get(id) as { rowid: number } | null;

      if (existing != null) {
        this.db.prepare('DELETE FROM vec_store WHERE rowid = ?').run(existing.rowid);
        this.db.prepare('DELETE FROM vec_metadata WHERE rowid = ?').run(existing.rowid);
      }
    } else {
      this.db.prepare('DELETE FROM vector_store WHERE id = ?').run(id);
    }
  }

  // ── 关闭 ─────────────────────────────────────────────────

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }
}

// ── 工具函数 ─────────────────────────────────────────────────

/** 计算两个向量的余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
