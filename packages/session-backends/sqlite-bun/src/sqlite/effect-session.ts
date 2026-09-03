import { Context, Data, Effect, Layer } from "effect";
import * as Client from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";
import { SqliteClient } from "./effect.ts";

export class SqliteSessionEffectError extends Data.TaggedError("SqliteSessionEffectError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface SqliteSessionEffectService {
	readonly all: <A extends object>(
		query: Statement.Statement<A>,
	) => Effect.Effect<ReadonlyArray<A>, SqliteSessionEffectError>;
	readonly get: <A extends object>(
		query: Statement.Statement<A>,
	) => Effect.Effect<A | undefined, SqliteSessionEffectError>;
	readonly run: (
		query: Statement.Statement<unknown>,
	) => Effect.Effect<ReadonlyArray<unknown>, SqliteSessionEffectError>;
	readonly transaction: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | SqliteSessionEffectError, R>;
}

export class SqliteSessionEffect extends Context.Service<SqliteSessionEffect, SqliteSessionEffectService>()(
	"tg-session-backend/SqliteSessionEffect",
) {}

const recover = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catch((cause) => Effect.fail(new SqliteSessionEffectError({ operation, cause }))),
	);

/** Effect-native read/write gateway for session SQL operations. */
export const sqliteSessionLayer: Layer.Layer<SqliteSessionEffect, never, SqliteClient> = Layer.effect(
	SqliteSessionEffect,
	Effect.gen(function* () {
		const client = yield* SqliteClient;
		return SqliteSessionEffect.of({
			all: (query) => recover("all", query),
			get: (query) => recover("get", query.pipe(Effect.map((rows) => rows[0]))),
			run: (query) => recover("run", query),
			transaction: (effect) => recover("transaction", client.withTransaction(effect)),
		});
	}),
);
