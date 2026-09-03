import { Database } from "bun:sqlite";
import { Context, Data, Effect, Fiber, Layer, Scope, Semaphore, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";
import type { SqliteDatabase, SqliteDatabaseFactory } from "./types.ts";

export interface SqliteBunConfig {
	readonly filename: string;
	readonly readonly?: boolean;
	readonly readwrite?: boolean;
	readonly create?: boolean;
	readonly disableWAL?: boolean;
	readonly spanAttributes?: Record<string, unknown>;
	readonly transformResultNames?: (name: string) => string;
	readonly transformQueryNames?: (name: string) => string;
}

export class SqliteNative extends Context.Service<SqliteNative, Database>()(
	"tg-session-backend/SqliteNative",
) {}

export interface SqliteClient extends Client.SqlClient {
	readonly config: SqliteBunConfig;
	readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>;
	readonly serialize: Effect.Effect<Uint8Array, SqlError>;
	readonly updateValues: never;
}

export const SqliteClient = Context.Service<SqliteClient>("tg-session-backend/SqliteClient");

/** Error raised by the legacy adapter-oriented Effect API. */
export class SqliteEffectError extends Data.TaggedError("SqliteEffectError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface SqliteEffectService {
	readonly open: (path: string) => Effect.Effect<SqliteDatabase, SqliteEffectError>;
	readonly withDatabase: <A, E, R>(
		path: string,
		effect: (database: SqliteDatabase) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | SqliteEffectError, R>;
}

export class SqliteEffect extends Context.Service<SqliteEffect, SqliteEffectService>()(
	"tg-session-backend/SqliteEffect",
) {}

const sqliteError = (cause: unknown, operation: string, message = "Failed to execute statement") =>
	new SqlError({ reason: classifySqliteError(cause, { message, operation }) });

const sqliteRun = (database: Database, query: string, params: ReadonlyArray<unknown>) =>
	Effect.withFiber<ReadonlyArray<Record<string, unknown>>, SqlError>((fiber) => {
		const statement = database.query(query);
		// Bun 1.3 exposes this method at runtime while older bun-types omit it.
		(statement as unknown as { safeIntegers: (enabled: boolean) => void }).safeIntegers(
			Context.get(fiber.context, Client.SafeIntegers),
		);
		try {
			return Effect.succeed((statement.all(...(params as any[])) ?? []) as ReadonlyArray<Record<string, unknown>>);
		} catch (cause) {
			return Effect.fail(sqliteError(cause, "execute"));
		}
	});

const sqliteValues = (database: Database, query: string, params: ReadonlyArray<unknown>) =>
	Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
		const statement = database.query(query);
		(statement as unknown as { safeIntegers: (enabled: boolean) => void }).safeIntegers(
			Context.get(fiber.context, Client.SafeIntegers),
		);
		try {
			return Effect.succeed((statement.values(...(params as any[])) ?? []) as ReadonlyArray<ReadonlyArray<unknown>>);
		} catch (cause) {
			return Effect.fail(sqliteError(cause, "execute"));
		}
	});

const makeClient = (config: SqliteBunConfig) =>
	Effect.gen(function* () {
		const database = yield* SqliteNative;
		const compiler = Statement.makeCompilerSqlite(config.transformQueryNames);
		const transformRows = config.transformResultNames
			? Statement.defaultTransforms(config.transformResultNames).array
			: undefined;

		const connection: Connection = {
			execute: (query, params, transform) => {
				const result = sqliteRun(database, query, params);
				return transform ? Effect.map(result, transform) : result;
			},
			executeRaw: (query, params) => sqliteRun(database, query, params),
			executeValues: (query, params) => sqliteValues(database, query, params),
			executeValuesUnprepared: (query, params) => sqliteValues(database, query, params),
			executeUnprepared: (query, params, transform) => {
				const result = sqliteRun(database, query, params);
				return transform ? Effect.map(result, transform) : result;
			},
			executeStream: () => Stream.die("executeStream not implemented"),
		};

		const semaphore = yield* Semaphore.make(1);
		const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
		const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
			const fiber = Fiber.getCurrent()!;
			const scope = Context.getUnsafe(fiber.context, Scope.Scope);
			return Effect.as(
				Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
				connection,
			);
		});

		const client = (yield* Client.make({
			acquirer,
			compiler,
			transactionAcquirer,
			spanAttributes: [
				...(config.spanAttributes ? Object.entries(config.spanAttributes) : []),
				["db.system.name", "sqlite"],
			],
			transformRows,
		})) as SqliteClient;

		return Object.assign(client, {
			config,
			loadExtension: (path: string) =>
				Effect.flatMap(acquirer, () =>
					Effect.try({
						try: () => database.loadExtension(path),
						catch: (cause) => sqliteError(cause, "loadExtension", "Failed to load extension"),
					}),
				),
			serialize: Effect.flatMap(acquirer, () =>
				Effect.try({
					try: () => database.serialize(),
					catch: (cause) => sqliteError(cause, "serialize", "Failed to serialize database"),
				}),
			),
		});
	});

const nativeLayer = (config: SqliteBunConfig) =>
	Layer.effect(
		SqliteNative,
		Effect.gen(function* () {
			const database = new Database(config.filename, {
				readonly: config.readonly,
				readwrite: config.readwrite ?? true,
				create: config.create ?? true,
			});
			yield* Effect.addFinalizer(() => Effect.sync(() => database.close()));
			if (config.disableWAL !== true && config.readonly !== true) database.run("PRAGMA journal_mode = WAL");
			return database;
		}),
	);

/** Effect v4 layer exposing both the native Bun database and standard SqlClient. */
export const sqliteLayer = (
	config: SqliteBunConfig,
): Layer.Layer<SqliteNative | SqliteClient | Client.SqlClient> => {
		const native = nativeLayer(config);
		return Layer.merge(
			native,
			Layer.effectContext(
				Effect.map(makeClient(config), (client) =>
					Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
				),
			).pipe(Layer.provide(native)),
		).pipe(Layer.provide(Reactivity.layer));
};

const openDatabase = (factory: SqliteDatabaseFactory, path: string) =>
	Effect.tryPromise({
		try: () => factory.open(path),
		catch: (cause) => new SqliteEffectError({ operation: "open", cause }),
	});

/** Creates an Effect layer around the existing session database capability. */
export const SqliteEffectLive = (factory: SqliteDatabaseFactory): Layer.Layer<SqliteEffect> =>
	Layer.succeed(
		SqliteEffect,
		SqliteEffect.of({
			open: (path) => openDatabase(factory, path),
			withDatabase: (path, effect) =>
				Effect.acquireUseRelease(
					openDatabase(factory, path),
					(database) => effect(database),
					(database) => Effect.sync(() => database.close()),
				),
		}),
	);

export const sqliteSync = <A>(operation: string, callback: () => A): Effect.Effect<A, SqliteEffectError> =>
	Effect.try({
		try: callback,
		catch: (cause) => new SqliteEffectError({ operation, cause }),
	});
