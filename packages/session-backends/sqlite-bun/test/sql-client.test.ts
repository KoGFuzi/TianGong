import { expect, test } from "bun:test";
import { Effect } from "effect";
import * as Client from "effect/unstable/sql/SqlClient";
import { sqliteLayer } from "../src/sqlite/effect.ts";
import { acquireWriterLeaseEffect, renewWriterLeaseEffect, releaseWriterLeaseEffect } from "../src/sqlite/effect-lease.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Client.SqlClient>) =>
	Effect.runPromise(Effect.provide(effect, sqliteLayer({ filename: ":memory:", disableWAL: true })));

test("executes Bun SQLite queries through Effect SqlClient", async () => {
	const rows = await run(
		Effect.gen(function* () {
			const sql = yield* Client.SqlClient;
			yield* sql`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
			yield* sql`INSERT INTO users (name) VALUES (${"Ada"})`;
			return yield* sql`SELECT name FROM users`;
		}),
	);

	expect(rows).toEqual([{ name: "Ada" }]);
});

test("rolls back failed Effect SqlClient transactions", async () => {
	const rows = await run(
		Effect.gen(function* () {
			const sql = yield* Client.SqlClient;
			yield* sql`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
			yield* sql.withTransaction(
				sql`INSERT INTO users (name) VALUES (${"Grace"})`.pipe(Effect.andThen(Effect.fail("rollback"))),
			).pipe(Effect.ignore);
			return yield* sql`SELECT name FROM users`;
		}),
	);

	expect(rows).toEqual([]);
});

test("fences writer leases through Effect SQL transactions", async () => {
	const result = await run(
		Effect.gen(function* () {
			const sql = yield* Client.SqlClient;
			yield* sql`CREATE TABLE writer_leases (session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fence INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL)`;
			const first = yield* acquireWriterLeaseEffect("session", "owner-a", 100, 200);
			const blocked = yield* acquireWriterLeaseEffect("session", "owner-b", 150, 250);
			const renewed = first === undefined ? false : yield* renewWriterLeaseEffect("session", first, 150, 300);
			if (first !== undefined) yield* releaseWriterLeaseEffect("session", first);
			return { first, blocked, renewed };
		}),
	);

	expect(result.first).toEqual({ ownerId: "owner-a", fence: 1, expiresAtMs: 200 });
	expect(result.blocked).toBeUndefined();
	expect(result.renewed).toBe(true);
});
