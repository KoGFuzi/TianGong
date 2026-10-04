/** Values supported by the portable SQLite storage core. */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/**
 * Asynchronous SQL operations shared by a database and its transaction handles.
 *
 * `exec` runs SQL text without bindings and may contain several statements. `run`, `get`, and `all`
 * execute one statement with positional bindings. Adapters may cache prepared statements by SQL text,
 * so callers pass values as bindings instead of interpolating them.
 */
export interface SqliteExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: SqliteValue[]): Promise<void>;
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}

/**
 * Minimal database facade required by `SqliteStorage`.
 *
 * All operations are asynchronous so adapters may execute outside the harness runtime.
 *
 * `transaction` passes the callback a transaction handle. All work in the transaction
 * must use that handle; the handle is invalid after the callback settles. Adapters must
 * queue unrelated operations and other transactions until the transaction finishes. The
 * returned promise settles after commit or rollback. Calling the database itself (including
 * `transaction` or `close`) from inside a callback therefore waits for that transaction and
 * never settles.
 *
 * When the callback rejects, the adapter must roll the transaction back before rejecting
 * with that same error. If rollback fails, it must reject with a different error (for
 * example an `AggregateError`) so callers cannot mistake the callback error for a
 * guaranteed rollback.
 */
export interface SqliteDatabase extends SqliteExecutor {
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

/**
 * An integrity and settings report from a database adapter.
 *
 * Every field is observed at call time. Adapters that cannot report integrity return `ok: false` with
 * `integrity: "unsupported"` rather than claiming to be healthy.
 */
export type SqliteHealthReport = {
	/** `integrity_check` returned `ok`. */
	readonly ok: boolean;
	/** Raw `PRAGMA integrity_check` result. */
	readonly integrity: string;
	/** Version recorded in the schema table; 0 when no migration has run yet. */
	readonly schemaVersion: number;
	readonly journalMode: string;
	/** `PRAGMA synchronous` as SQLite reports it: 1 is `NORMAL`. */
	readonly synchronous: number;
	readonly walAutoCheckpointPages: number;
	readonly busyTimeoutMs: number;
};
