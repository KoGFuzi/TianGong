import { Effect } from "effect";
import { describe, expect, it } from "bun:test";
import { SqliteEffect, SqliteEffectError, SqliteEffectLive, sqliteSync } from "../src/sqlite/effect.ts";
import type { SqliteDatabase, SqliteDatabaseFactory } from "../src/sqlite/types.ts";

function factoryFor(database: SqliteDatabase): SqliteDatabaseFactory {
	return { open: async () => database };
}

describe("Effect v4 SQLite service", () => {
	it("maps database open failures to SqliteEffectError", async () => {
		const program = Effect.gen(function* () {
			const sqlite = yield* SqliteEffect;
			return yield* sqlite.open("missing.sqlite");
		});
		const failure = await Effect.runPromiseExit(
			Effect.provide(
				program,
				SqliteEffectLive({
					open: async () => {
						throw new Error("cannot open");
					},
				}),
			),
		);

		expect(failure._tag).toBe("Failure");
		if (failure._tag === "Failure") expect(failure.cause.toString()).toContain("SqliteEffectError");
	});

	it("provides a database and releases it after use", async () => {
		let closes = 0;
		const database: SqliteDatabase = {
			exec: () => {},
			prepare: () => {
				throw new Error("not used");
			},
			transaction: (callback) => callback(),
			close: () => {
				closes += 1;
			},
		};

		const program = Effect.gen(function* () {
			const sqlite = yield* SqliteEffect;
			return yield* sqlite.withDatabase(":memory:", (db) => sqliteSync("assert", () => db === database));
		});

		expect(await Effect.runPromise(Effect.provide(program, SqliteEffectLive(factoryFor(database))))).toBe(true);
		expect(closes).toBe(1);
	});

	it("turns synchronous failures into tagged Effect errors", async () => {
		let failure: unknown;
		try {
			await Effect.runPromise(sqliteSync("query", () => {
				throw new Error("broken query");
			}));
		} catch (cause) {
			failure = cause;
		}
		expect(failure).toBeInstanceOf(SqliteEffectError);
		expect((failure as SqliteEffectError).operation).toBe("query");
	});
});
