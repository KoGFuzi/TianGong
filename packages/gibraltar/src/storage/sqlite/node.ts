import { tiangongSessionDbPath } from "@OnePanda-TgSec/tg-ai/config-paths";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteHealthReport, SqliteValue } from "./database.ts";
import { DEFAULT_PROJECT_ID, type SqliteStorageOptions } from "./migrations.ts";
import { SqliteStorage } from "./storage.ts";

/** Settings for opening storage at the default production location. */
export type DefaultSqliteStorageOptions = NodeSqliteStorageOptions &
	SqliteStorageOptions & {
		/** Overrides the database file inside the data directory. */
		readonly path?: string;
	};

/** Node SQLite connection settings for a durable storage file. */
export type NodeSqliteStorageOptions = {
	/** SQLite WAL auto-checkpoint threshold. SQLite and this adapter default to 1,000 pages; 0 disables it. */
	readonly walAutoCheckpointPages?: number;
	/** Time SQLite waits for a competing file lock. SQLite defaults to 0; this adapter defaults to 5,000 ms. */
	readonly busyTimeoutMs?: number;
};

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

type TransactionScope = { active: boolean };

const ignore = (): void => {};

/**
 * Runs operations in call order. An operation starts immediately when nothing is running or waiting;
 * otherwise it waits for everything before it. An asynchronous operation holds the queue until it settles.
 */
class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	run<T>(operation: () => T): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	runAsync<T>(operation: () => Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		this.pending++;
		// Publish the barrier before the operation starts, so calls it makes synchronously wait behind it.
		const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
		this.tail = barrier;
		let started: Promise<T>;
		try {
			started = operation();
		} catch (error) {
			started = Promise.reject(error);
		}
		return started.finally(() => {
			this.pending--;
			releaseBarrier();
		});
	}

	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		this.pending++;
		return this.release(this.tail.then(operation));
	}

	private release<T>(operation: Promise<T>): Promise<T> {
		const settled = operation.finally(() => {
			this.pending--;
		});
		this.tail = settled.then(ignore, ignore);
		return settled;
	}
}

/**
 * Executes SQL on one connection. Prepared statements are cached per connection by SQL text, so the
 * database and its transaction handles share them across transactions.
 */
abstract class NodeSqliteExecutor implements SqliteExecutor {
	protected readonly database: DatabaseSync;
	protected readonly statements: Map<string, StatementSync>;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>) {
		this.database = database;
		this.statements = statements;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.statement(sql).run(...params);
		});
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => this.statement(sql).get(...params) as T | undefined);
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.statement(sql).all(...params) as T[]);
	}

	protected abstract runOperation<T>(operation: () => T): Promise<T>;

	private statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.database.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
}

class NodeSqliteTransaction extends NodeSqliteExecutor {
	private readonly scope: TransactionScope;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>, scope: TransactionScope) {
		super(database, statements);
		this.scope = scope;
	}

	protected async runOperation<T>(operation: () => T): Promise<T> {
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

/** `SqliteDatabase` adapter backed by Node's built-in `node:sqlite`. */
export class NodeSqliteDatabase extends NodeSqliteExecutor implements SqliteDatabase {
	private readonly access = new SerialOperationQueue();
	private closed = false;

	constructor(database: DatabaseSync) {
		super(database, new Map());
	}

	/** SQLite's own view of file integrity, plus the connection settings this adapter applied. */
	async health(): Promise<SqliteHealthReport> {
		return this.access.run(async () => {
			this.assertOpen();
			// `node:sqlite` reports each pragma result under its own field name.
			const integrity = await this.get<{ integrity_check: string }>("PRAGMA integrity_check");
			const journalMode = await this.get<{ journal_mode: string }>("PRAGMA journal_mode");
			const synchronous = await this.get<{ synchronous: number }>("PRAGMA synchronous");
			const walCheckpoint = await this.get<{ wal_autocheckpoint: number }>("PRAGMA wal_autocheckpoint");
			const busyTimeout = await this.get<{ timeout: number }>("PRAGMA busy_timeout");
			// `durable_schema` exists only after the first migration, so a freshly opened file has
			// nowhere to read the version from. Reporting 0 for "nothing migrated yet" is the honest
			// answer and keeps health usable on an uninitialised database.
			const hasSchema =
				(
					await this.get<{ present: number }>(
						"SELECT COUNT(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'",
					)
				)?.present === 1;
			const schemaVersion = hasSchema
				? ((await this.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1"))
						?.version ?? 0)
				: 0;
			return {
				ok: integrity?.integrity_check === "ok",
				integrity: integrity?.integrity_check ?? "unknown",
				schemaVersion,
				journalMode: journalMode?.journal_mode ?? "unknown",
				synchronous: synchronous?.synchronous ?? -1,
				walAutoCheckpointPages: walCheckpoint?.wal_autocheckpoint ?? 0,
				busyTimeoutMs: busyTimeout?.timeout ?? 0,
			};
		});
	}

	/** Runs `wal_checkpoint(TRUNCATE)` to hand the log back to the filesystem. Safe at any time. */
	async checkpoint(): Promise<void> {
		return this.access.run(async () => {
			this.assertOpen();
			await this.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		});
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SQLite database is closed");
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new NodeSqliteTransaction(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.access.run(() => {
			if (this.closed) return;
			this.closed = true;
			this.statements.clear();
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
		});
	}

	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.access.run(operation);
	}
}

/** Open and configure a Node-backed SQLite database facade. */
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<NodeSqliteDatabase> {
	const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
	const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const database = new DatabaseSync(path, { timeout });
	const adapter = new NodeSqliteDatabase(database);
	try {
		await adapter.exec("PRAGMA journal_mode = WAL");
		await adapter.exec("PRAGMA synchronous = NORMAL");
		await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
		// A connection that finds a foreign key violation only at write time is worse than one that
		// reports it on the statement that caused it, and the schema defines no foreign keys yet.
		await adapter.exec("PRAGMA foreign_keys = ON");
		// WAL needs a checkpoint to reclaim the log after a burst; PASSIVE keeps it bounded without
		// blocking writers, the way `opencode` runs one at startup.
		await adapter.exec("PRAGMA wal_checkpoint(PASSIVE)");
		return adapter;
	} catch (error) {
		try {
			await adapter.close();
		} catch {
			// Preserve the configuration failure.
		}
		throw error;
	}
}

/**
 * Open or create durable storage at the default production location.
 *
 * `~/.local/share/TianGong/session.sqlite`, or `$TIANGONG_SESSION_DB` for the file name and
 * `$TIANGONG_DATA_DIR` for the whole data root. One project per database file is the supported
 * deployment shape; pass `project` to scope every row this storage writes.
 *
 * This is the entry point a service uses when it has not been given a path. Anything with a
 * deployment-specific location calls `openNodeSqliteStorage` with an explicit path instead.
 */
export async function openDefaultSqliteStorage(options: DefaultSqliteStorageOptions = {}): Promise<SqliteStorage> {
	const path = options.path ?? tiangongSessionDbPath();
	return openNodeSqliteStorage(path, {
		...options,
		project: options.project ?? DEFAULT_PROJECT_ID,
	});
}

/** Open or create file-backed durable storage using Node's built-in SQLite. */
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions & SqliteStorageOptions = {},
): Promise<SqliteStorage> {
	const { walAutoCheckpointPages, busyTimeoutMs, ...storageOptions } = options;
	return SqliteStorage.open(
		await openNodeSqliteDatabase(path, { walAutoCheckpointPages, busyTimeoutMs }),
		storageOptions,
	);
}
