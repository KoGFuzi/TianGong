import { Database, type Statement } from "bun:sqlite";
import { sql } from "./sqlite/sql.ts";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteRunResult, SqliteStatement } from "./sqlite/types.ts";

class BunSqliteStatement implements SqliteStatement {
	private readonly statement: Statement;

	constructor(statement: Statement) {
		this.statement = statement;
	}

	run(...params: unknown[]): SqliteRunResult {
		const result = this.statement.run(...(params as never[]));
		return {
			changes: Number(result.changes),
			lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
		};
	}

	get<TRow extends object>(...params: unknown[]): TRow | undefined {
		// bun:sqlite yields null for "no row" where node:sqlite yields undefined;
		// normalize so the backend code can rely on the node semantics.
		const row = this.statement.get(...(params as never[])) as TRow | null | undefined;
		return row === null ? undefined : row;
	}

	all<TRow extends object>(...params: unknown[]): TRow[] {
		return this.statement.all(...(params as never[])) as TRow[];
	}

	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
		return this.statement.iterate(...(params as never[])) as Iterable<TRow>;
	}
}

class BunSqliteDatabase implements SqliteDatabase {
	private readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	exec(query: string): void {
		this.db.exec(query);
	}

	prepare(query: string): SqliteStatement {
		return new BunSqliteStatement(this.db.query(query));
	}

	transaction<T>(fn: () => T): T {
		sql`BEGIN IMMEDIATE`.exec(this);
		try {
			const result = fn();
			if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
				throw new TypeError("SQLite transaction callbacks must be synchronous");
			}
			sql`COMMIT`.exec(this);
			return result;
		} catch (error) {
			try {
				sql`ROLLBACK`.exec(this);
			} catch {
				// Ignore rollback errors to rethrow original error.
			}
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}
}

export function wrapBunSqliteDatabase(db: Database): SqliteDatabase {
	return new BunSqliteDatabase(db);
}

export function createBunSqliteFactory(): SqliteDatabaseFactory {
	return {
		async open(path: string): Promise<SqliteDatabase> {
			return new BunSqliteDatabase(new Database(path));
		},
		async openExisting(path: string): Promise<SqliteDatabase> {
			// bun 1.3.14 misuses `{ create: false }` alone (SQLITE_MISUSE); the explicit
			// readwrite flag is required for "open without creating" semantics.
			return new BunSqliteDatabase(new Database(path, { readwrite: true, create: false }));
		},
		async openReadOnly(path: string): Promise<SqliteDatabase> {
			return new BunSqliteDatabase(new Database(path, { readonly: true }));
		},
	};
}

// Re-export the SQLite session backend and types so this package is a complete bun-sqlite backend.
export * from "./sqlite/index.ts";
