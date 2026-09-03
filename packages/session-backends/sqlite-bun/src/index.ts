import { Database, type SQLQueryBindings } from "bun:sqlite";
import { sql } from "./sqlite/sql.ts";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteRunResult, SqliteStatement } from "./sqlite/types.ts";

function isNamedParameters(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	return !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function isAsyncResult(value: unknown): boolean {
	return value !== null && (typeof value === "object" || typeof value === "function") && "then" in value;
}

function toBunNamedParams(params: unknown[]): SQLQueryBindings[] {
	if (params.length === 1 && isNamedParameters(params[0])) {
		const named = params[0] as Record<string, unknown>;
		const converted: Record<string, unknown> = {};
		for (const key of Object.keys(named)) {
			converted["$" + key] = named[key];
		}
		return [converted];
	}
	return params as SQLQueryBindings[];
}

function normalizeSql(sql: string): string {
	return sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => "$" + name);
}

class BunSqliteStatement implements SqliteStatement {
	private readonly statement: ReturnType<Database["query"]>;

	constructor(private readonly db: Database, sql: string) {
		this.statement = db.query(normalizeSql(sql));
	}

	run(...params: unknown[]): SqliteRunResult {
		const result = this.statement.run(...toBunNamedParams(params));
		return {
			changes: Number(result.changes),
			lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
		};
	}

	get<TRow extends object>(...params: unknown[]): TRow | undefined {
		const result = this.statement.get(...toBunNamedParams(params)) as TRow | undefined | null;
		return result === null ? undefined : result;
	}

	all<TRow extends object>(...params: unknown[]): TRow[] {
		return this.statement.all(...toBunNamedParams(params)) as TRow[];
	}

	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
		return this.statement.iterate(...toBunNamedParams(params)) as Iterable<TRow>;
	}
}

class BunSqliteDatabase implements SqliteDatabase {
	constructor(private readonly db: Database) {}

	exec(query: string): void {
		this.db.exec(query);
	}

	prepare(query: string): SqliteStatement {
		return new BunSqliteStatement(this.db, query);
	}

	transaction<T>(fn: () => T): T {
		const result = this.db.transaction(() => {
			const value = fn();
			if (isAsyncResult(value)) throw new TypeError("SQLite transaction callbacks must be synchronous");
			return value;
		})();
		return result;
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
	};
}

export * from "./sqlite/index.ts";
