import { Data, Effect } from "effect";
import * as Client from "effect/unstable/sql/SqlClient";

export class SqliteWriterLeaseEffectError extends Data.TaggedError("SqliteWriterLeaseEffectError")<{
	readonly operation: string;
	readonly sessionId: string;
	readonly cause: unknown;
}> {}

export interface EffectWriterLease {
	readonly ownerId: string;
	readonly fence: number;
	readonly expiresAtMs: number;
}

const mapLeaseError = (operation: string, sessionId: string) =>
	Effect.mapError((cause: unknown) => new SqliteWriterLeaseEffectError({ operation, sessionId, cause }));

export const acquireWriterLeaseEffect = (sessionId: string, ownerId: string, now: number, expiresAtMs: number) =>
	Effect.gen(function* () {
		const sql = yield* Client.SqlClient;
		const rows = yield* sql<{ owner_id: string; fence: number; expires_at_ms: number }>`INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms)
			VALUES (${sessionId}, ${ownerId}, 1, ${expiresAtMs})
			ON CONFLICT(session_id) DO UPDATE SET
			owner_id = excluded.owner_id,
			fence = writer_leases.fence + 1,
			expires_at_ms = excluded.expires_at_ms
			WHERE writer_leases.expires_at_ms <= ${now}
			RETURNING owner_id, fence, expires_at_ms`;
		const row = rows[0];
		return row === undefined
			? undefined
			: { ownerId: row.owner_id, fence: row.fence, expiresAtMs: row.expires_at_ms } satisfies EffectWriterLease;
	}).pipe(mapLeaseError("acquire", sessionId));

export const renewWriterLeaseEffect = (
	sessionId: string,
	lease: EffectWriterLease,
	now: number,
	expiresAtMs: number,
) =>
	Effect.gen(function* () {
		const sql = yield* Client.SqlClient;
		const rows = yield* sql`UPDATE writer_leases SET expires_at_ms = ${expiresAtMs}
			WHERE session_id = ${sessionId} AND owner_id = ${lease.ownerId}
			AND fence = ${lease.fence} AND expires_at_ms > ${now}
			RETURNING expires_at_ms`;
		return rows.length === 1;
	}).pipe(mapLeaseError("renew", sessionId));

export const releaseWriterLeaseEffect = (sessionId: string, lease: EffectWriterLease) =>
	Effect.gen(function* () {
		const sql = yield* Client.SqlClient;
		yield* sql`DELETE FROM writer_leases
			WHERE session_id = ${sessionId} AND owner_id = ${lease.ownerId} AND fence = ${lease.fence}`;
	}).pipe(mapLeaseError("release", sessionId));
