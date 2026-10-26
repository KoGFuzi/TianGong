import type { SqliteExecutor, SqliteHealthReport } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite";
import { type NodeSqliteDatabase, openNodeSqliteDatabase } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";
import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	TG_SPAN_SCHEMA,
} from "@OnePanda-TgSec/tg-telemetry";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import { basename, join } from "node:path";
import { EvidenceBlobStore } from "./blobs.ts";
import { blobsRoot, evidenceIndexPath, stagingDir } from "./config.ts";
import { TgSecEvidenceConflictError, TgSecEvidenceHashMismatchError, TgSecEvidenceNotFoundError } from "./errors.ts";
import {
	normalizeEvidenceFields,
	snapshotMetadataId,
	type TgSecEvidenceSnapshotFields,
	tgSecContentHash,
} from "./hashing.ts";
import { EVIDENCE_SCHEMA } from "./schema.ts";

/** How long an unreferenced snapshot or orphan blob survives before GC reaps it. */
export const EVIDENCE_GRACE_MS = 24 * 60 * 60 * 1000;

const EVIDENCE_ROLES = ["baseline", "proof", "verification", "supporting"] as const;

/** Why a snapshot is bound to a subject; mirrors the ARTEX traffic role vocabulary. */
export type TgSecEvidenceRole = (typeof EVIDENCE_ROLES)[number];

/** The evidence-store operations an audit span names, one per public method. */
type EvidenceOp = "record" | "bind" | "list" | "edit" | "collect" | "read";

/** How an evidence operation ended, recorded on the span. */
type EvidenceOutcome = "ok" | "conflict" | "not-found" | "error";

/** The facts a caller supplies to record one exchange; body hashes and lengths are derived. */
export type TgSecEvidenceRecordInput = Omit<TgSecEvidenceSnapshotFields, "reqHash" | "respHash" | "reqLen" | "respLen">;

/** A request to bind one snapshot to a subject, with an optional role and note. */
export type TgSecEvidenceRef = {
	readonly snapshotId: string;
	readonly role?: TgSecEvidenceRole;
	readonly note?: string;
};

/** A stored snapshot: its id, the facts it was hashed from, and when it was recorded. */
export type TgSecEvidenceSnapshotRecord = {
	readonly id: string;
	readonly fields: TgSecEvidenceSnapshotFields;
	readonly createdAt: number;
};

/** One subject's claim on a snapshot, in display order. */
export type TgSecEvidenceBinding = {
	readonly bindingId: number;
	readonly snapshotId: string;
	readonly role: TgSecEvidenceRole;
	readonly note: string;
	readonly position: number;
};

/** A subject's evidence set: the optimistic-lock version plus its bindings. */
export type TgSecEvidenceSet = {
	readonly subjectId: string;
	readonly version: number;
	readonly bindings: readonly TgSecEvidenceBinding[];
};

/** One binding touched in place: change its role or note, or remove it. */
export type TgSecEvidenceBindingEdit = {
	readonly bindingId: number;
	readonly role?: TgSecEvidenceRole;
	readonly note?: string;
	readonly remove?: boolean;
};

/** Reorder a whole set by binding id, or touch one binding. */
export type TgSecEvidenceEdit = { readonly reorder: readonly number[] } | TgSecEvidenceBindingEdit;

type SnapshotRow = {
	id: string;
	source_id: string;
	captured_at: number;
	url: string;
	method: string;
	status: number;
	content_type: string;
	req_head: string;
	resp_head: string;
	req_hash: string;
	req_len: number;
	resp_hash: string;
	resp_len: number;
	created_at: number;
	unreferenced_at: number | null;
};

const SNAPSHOT_COLUMNS = `id, source_id, captured_at, url, method, status, content_type, req_head, resp_head, req_hash, req_len, resp_hash, resp_len, created_at, unreferenced_at`;

/**
 * The durable evidence store: a content-addressed body tree plus a columnar SQLite index that is
 * **independent of the session database**. Writes are serialized by `NodeSqliteDatabase.transaction`
 * (an in-process queue plus `BEGIN IMMEDIATE` and a busy timeout), which is the SQLite-native stand-in
 * for ARTEX's PostgreSQL advisory lock and `SELECT … FOR UPDATE`. The `evidence_version` on each
 * subject is the optimistic lock: a `bind` supplies it to refuse a stale write, and an `edit` must
 * match it before it bumps.
 */
export class TgSecEvidenceStore {
	private readonly db: NodeSqliteDatabase;
	private readonly blobs: EvidenceBlobStore;
	private readonly dir: string;
	private readonly now: () => number;
	private readonly telemetry: TelemetryContext;

	constructor(
		db: NodeSqliteDatabase,
		blobs: EvidenceBlobStore,
		dir: string,
		now: () => number,
		telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
	) {
		this.db = db;
		this.blobs = blobs;
		this.dir = dir;
		this.now = now;
		this.telemetry = telemetry;
	}

	/**
	 * Freeze one exchange into immutable evidence: write the request and response as two independent
	 * blobs, then persist the normalized metadata row keyed by its own hash. Recording the same facts
	 * twice is idempotent (`ON CONFLICT(id) DO NOTHING`); binding to a subject is a separate call.
	 */
	record(
		request: Uint8Array,
		response: Uint8Array,
		input: TgSecEvidenceRecordInput,
	): Promise<TgSecEvidenceSnapshotRecord> {
		return this.emitEvidence("record", undefined, async () => {
			const reqHash = tgSecContentHash(request);
			const respHash = tgSecContentHash(response);
			const fields = normalizeEvidenceFields({
				...input,
				reqHash,
				respHash,
				reqLen: request.length,
				respLen: response.length,
			});
			const id = snapshotMetadataId(fields);
			await this.blobs.writeBody(request, { expectedLength: request.length, expectedHash: reqHash });
			await this.blobs.writeBody(response, { expectedLength: response.length, expectedHash: respHash });
			const createdAt = this.now();
			const inserted = await this.db.transaction(async (tx) => {
				const present = await tx.get<{ id: string }>("SELECT id FROM tg_sec_evidence_snapshots WHERE id = ?", id);
				if (present !== undefined) return false;
				await tx.run(
					`INSERT INTO tg_sec_evidence_snapshots (id, source_id, captured_at, url, method, status, content_type, req_head, resp_head, req_hash, req_len, resp_hash, resp_len, created_at, unreferenced_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
					id,
					fields.sourceId,
					fields.capturedAt,
					fields.url,
					fields.method,
					fields.status,
					fields.contentType,
					fields.reqHead,
					fields.respHead,
					fields.reqHash,
					fields.reqLen,
					fields.respHash,
					fields.respLen,
					createdAt,
				);
				return true;
			});
			return { value: { id, fields, createdAt }, changed: inserted, count: 1 };
		});
	}

	/**
	 * Claim snapshots for a subject under the optimistic lock. `expectedVersion` of `null` skips the
	 * check; any number must equal the current version or the call rejects with a conflict. New
	 * bindings are appended in order, an existing binding's role/note is never overwritten, GC's
	 * `unreferenced_at` mark is cleared unconditionally, and the version bumps only if something was
	 * actually added.
	 */
	bind(
		subjectId: string,
		expectedVersion: number | null,
		refs: readonly TgSecEvidenceRef[],
	): Promise<TgSecEvidenceSet> {
		return this.emitEvidence("bind", subjectId, async () => {
			const normalized = normalizeRefs(refs);
			const result = await this.db.transaction(async (tx) => {
				await this.lockSubject(tx, subjectId, expectedVersion);
				const start = await tx.get<{ p: number }>(
					"SELECT COALESCE(MAX(position) + 1, 0) AS p FROM tg_sec_evidence_bindings WHERE subject_id = ?",
					subjectId,
				);
				let position = start?.p ?? 0;
				let changed = false;
				const createdAt = this.now();
				for (const ref of normalized) {
					const present = await tx.get<{ id: string }>(
						"SELECT id FROM tg_sec_evidence_snapshots WHERE id = ?",
						ref.snapshotId,
					);
					if (present === undefined) throw new TgSecEvidenceNotFoundError();
					await tx.run("UPDATE tg_sec_evidence_snapshots SET unreferenced_at = NULL WHERE id = ?", ref.snapshotId);
					const existing = await tx.get<{ one: number }>(
						"SELECT 1 AS one FROM tg_sec_evidence_bindings WHERE subject_id = ? AND snapshot_id = ?",
						subjectId,
						ref.snapshotId,
					);
					if (existing === undefined) {
						await tx.run(
							"INSERT INTO tg_sec_evidence_bindings (subject_id, snapshot_id, role, note, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
							subjectId,
							ref.snapshotId,
							ref.role,
							ref.note,
							position,
							createdAt,
						);
						position += 1;
						changed = true;
					}
				}
				if (changed) {
					await tx.run(
						"UPDATE tg_sec_evidence_versions SET evidence_version = evidence_version + 1 WHERE subject_id = ?",
						subjectId,
					);
				}
				return { changed, set: await readSet(tx, subjectId) };
			});
			return { value: result.set, changed: result.changed, count: result.set.bindings.length };
		});
	}

	/** A subject's current evidence set: version and bindings in display order. */
	list(subjectId: string): Promise<TgSecEvidenceSet> {
		return this.emitEvidence("list", subjectId, async () => {
			const set = await this.db.transaction((tx) => readSet(tx, subjectId));
			return { value: set, changed: false, count: set.bindings.length };
		});
	}

	/**
	 * Every subject the store has ever locked, in id order. The projection needs the enumeration to
	 * turn evidence into findings; a subject whose bindings were all removed still has a version row
	 * and is reported with an empty set.
	 */
	listSubjects(): Promise<string[]> {
		return this.emitEvidence("list", undefined, async () => {
			const rows = await this.db.transaction((tx) =>
				tx.all<{ subject_id: string }>("SELECT subject_id FROM tg_sec_evidence_versions ORDER BY subject_id"),
			);
			const subjects = rows.map((row) => row.subject_id);
			return { value: subjects, changed: false, count: subjects.length };
		});
	}

	/**
	 * Read one snapshot's metadata by id, verifying its stored hash against the id before returning.
	 * `undefined` when the snapshot is absent; the bodies are separate and come from `readBody`. A
	 * read-only view over the same row `readBody` resolves, so a traffic query can show what was
	 * captured without pulling the bytes.
	 */
	getSnapshot(snapshotId: string): Promise<TgSecEvidenceSnapshotRecord | undefined> {
		return this.emitEvidence("read", undefined, async () => {
			const record = await this.db.transaction(async (tx) => {
				const row = await tx.get<SnapshotRow>(
					`SELECT ${SNAPSHOT_COLUMNS} FROM tg_sec_evidence_snapshots WHERE id = ?`,
					snapshotId,
				);
				if (row === undefined) return undefined;
				assertSnapshotIntegrity(row);
				return { id: row.id, fields: fieldsFromRow(row), createdAt: row.created_at };
			});
			return { value: record, changed: false, count: record === undefined ? 0 : 1 };
		});
	}

	/**
	 * Reorder or edit one binding under the optimistic lock. A reorder must cover exactly the current
	 * binding ids; an edit must name a binding that exists. Either accepted edit bumps the version.
	 */
	async edit(subjectId: string, expectedVersion: number | null, edit: TgSecEvidenceEdit): Promise<TgSecEvidenceSet> {
		if ("role" in edit && edit.role !== undefined) assertRole(edit.role);
		return this.emitEvidence("edit", subjectId, async () => {
			const set = await this.db.transaction(async (tx) => {
				await this.lockSubject(tx, subjectId, expectedVersion);
				const current = await readSet(tx, subjectId);
				if ("reorder" in edit) {
					if (edit.reorder.length !== current.bindings.length) throw new TgSecEvidenceConflictError();
					const known = new Set(current.bindings.map((binding) => binding.bindingId));
					for (const id of edit.reorder) if (!known.has(id)) throw new TgSecEvidenceConflictError();
					for (const [index, id] of edit.reorder.entries()) {
						await tx.run(
							"UPDATE tg_sec_evidence_bindings SET position = ? WHERE subject_id = ? AND binding_id = ?",
							index,
							subjectId,
							id,
						);
					}
				} else {
					const target = current.bindings.find((binding) => binding.bindingId === edit.bindingId);
					if (target === undefined) throw new TgSecEvidenceNotFoundError();
					if (edit.remove) {
						await tx.run(
							"DELETE FROM tg_sec_evidence_bindings WHERE subject_id = ? AND binding_id = ?",
							subjectId,
							edit.bindingId,
						);
					} else {
						await tx.run(
							"UPDATE tg_sec_evidence_bindings SET role = COALESCE(?, role), note = COALESCE(?, note) WHERE subject_id = ? AND binding_id = ?",
							edit.role ?? null,
							edit.note ?? null,
							subjectId,
							edit.bindingId,
						);
					}
				}
				await tx.run(
					"UPDATE tg_sec_evidence_versions SET evidence_version = evidence_version + 1 WHERE subject_id = ?",
					subjectId,
				);
				return readSet(tx, subjectId);
			});
			return { value: set, changed: true, count: set.bindings.length };
		});
	}

	/**
	 * Resolve one binding's metadata under the transaction, then read and verify its body afterwards —
	 * the body is content-addressed and only GC removes it, so releasing the write path before the
	 * O(size) read keeps a large download from blocking every other evidence write.
	 */
	readBody(snapshotId: string, side: "request" | "response"): Promise<Buffer> {
		return this.emitEvidence("read", undefined, async () => {
			const body = await this.db.transaction(async (tx) => {
				const row = await tx.get<SnapshotRow>(
					`SELECT ${SNAPSHOT_COLUMNS} FROM tg_sec_evidence_snapshots WHERE id = ?`,
					snapshotId,
				);
				if (row === undefined) throw new TgSecEvidenceNotFoundError();
				assertSnapshotIntegrity(row);
				return side === "response"
					? { hash: row.resp_hash, length: row.resp_len }
					: { hash: row.req_hash, length: row.req_len };
			});
			const bytes = await this.blobs.readBody(body.hash);
			if (bytes.length !== body.length) {
				throw new Error(
					`evidence ${side} body for ${snapshotId} is ${bytes.length} bytes, index says ${body.length}`,
				);
			}
			return { value: bytes, changed: false, count: 1 };
		});
	}

	/**
	 * One GC pass: mark snapshots nothing binds, delete those unbound past the grace window, then reap
	 * any blob or staging file not referenced by a surviving snapshot and older than the grace window.
	 * Grace time for a file comes from its modification time; the span's `count` is the files reclaimed.
	 */
	collect(now: number = this.now()): Promise<void> {
		return this.emitEvidence("collect", undefined, async () => {
			const cutoff = now - EVIDENCE_GRACE_MS;
			const surviving = new Set<string>();
			await this.db.transaction(async (tx) => {
				await tx.run(
					`UPDATE tg_sec_evidence_snapshots SET unreferenced_at = ?
					 WHERE unreferenced_at IS NULL AND NOT EXISTS (SELECT 1 FROM tg_sec_evidence_bindings b WHERE b.snapshot_id = tg_sec_evidence_snapshots.id)`,
					now,
				);
				await tx.run(
					`DELETE FROM tg_sec_evidence_snapshots
					 WHERE unreferenced_at < ? AND NOT EXISTS (SELECT 1 FROM tg_sec_evidence_bindings b WHERE b.snapshot_id = tg_sec_evidence_snapshots.id)`,
					cutoff,
				);
				const rows = await tx.all<{ h: string }>(
					"SELECT req_hash AS h FROM tg_sec_evidence_snapshots UNION SELECT resp_hash AS h FROM tg_sec_evidence_snapshots",
				);
				for (const row of rows) surviving.add(row.h);
			});
			const count = await this.reapFiles(surviving, now);
			return { value: undefined, changed: count > 0, count };
		});
	}

	/** SQLite integrity plus the connection settings this index applied. */
	health(): Promise<SqliteHealthReport> {
		return this.db.health();
	}

	/** Hand the WAL log back to the filesystem. Safe at any time. */
	checkpoint(): Promise<void> {
		return this.db.checkpoint();
	}

	close(): Promise<void> {
		return this.db.close();
	}

	private emitEvidence<T>(
		op: EvidenceOp,
		subjectId: string | undefined,
		run: () => Promise<{ value: T; changed: boolean; count: number }>,
	): Promise<T> {
		const startSpan = createTypedSpanStarter(this.telemetry, [TG_SPAN_SCHEMA]);
		return startSpan(
			"tg.span.sec.evidence",
			{ op, ...(subjectId === undefined ? {} : { subjectDigest: subjectDigest(subjectId) }) },
			async (span) => {
				try {
					const { value, changed, count } = await run();
					span.setAttributes({ outcome: "ok", changed, count });
					return value;
				} catch (error) {
					span.setAttributes({ outcome: outcomeOf(error), changed: false, count: 0 });
					throw error;
				}
			},
		);
	}

	private async lockSubject(tx: SqliteExecutor, subjectId: string, expectedVersion: number | null): Promise<void> {
		await tx.run(
			"INSERT INTO tg_sec_evidence_versions (subject_id, evidence_version) VALUES (?, 0) ON CONFLICT(subject_id) DO NOTHING",
			subjectId,
		);
		const row = await tx.get<{ v: number }>(
			"SELECT evidence_version AS v FROM tg_sec_evidence_versions WHERE subject_id = ?",
			subjectId,
		);
		const current = row?.v ?? 0;
		if (expectedVersion !== null && expectedVersion !== current) throw new TgSecEvidenceConflictError();
	}

	private async reapFiles(keep: ReadonlySet<string>, now: number): Promise<number> {
		let removed = 0;
		for (const root of [blobsRoot(this.dir), stagingDir(this.dir)]) {
			await this.walk(root, async (path, mtimeMs) => {
				const name = basename(path);
				const hash = name.endsWith(".bin") ? name.slice(0, -4) : name;
				if (keep.has(hash)) return;
				if (now - mtimeMs < EVIDENCE_GRACE_MS) return;
				await fsp.rm(path, { force: true });
				removed += 1;
			});
		}
		return removed;
	}

	private async walk(root: string, visit: (path: string, mtimeMs: number) => Promise<void>): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fsp.readdir(root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(root, entry.name);
			if (entry.isDirectory()) {
				await this.walk(path, visit);
				continue;
			}
			if (!entry.isFile()) continue;
			const stat = await fsp.stat(path);
			await visit(path, stat.mtimeMs);
		}
	}
}

/** Open the evidence index for one project directory and make sure its tables exist. */
export async function openTgSecEvidenceStore(options: {
	readonly dir: string;
	readonly now?: () => number;
	readonly telemetry?: TelemetryContext;
}): Promise<TgSecEvidenceStore> {
	const database = await openNodeSqliteDatabase(evidenceIndexPath(options.dir));
	for (const statement of EVIDENCE_SCHEMA) await database.exec(statement);
	return new TgSecEvidenceStore(
		database,
		new EvidenceBlobStore(options.dir),
		options.dir,
		options.now ?? defaultNow,
		options.telemetry ?? NOOP_TELEMETRY_CONTEXT,
	);
}

async function readSet(tx: SqliteExecutor, subjectId: string): Promise<TgSecEvidenceSet> {
	const version = await tx.get<{ v: number }>(
		"SELECT evidence_version AS v FROM tg_sec_evidence_versions WHERE subject_id = ?",
		subjectId,
	);
	const rows = await tx.all<{
		binding_id: number;
		snapshot_id: string;
		role: string;
		note: string;
		position: number;
	}>(
		"SELECT binding_id, snapshot_id, role, note, position FROM tg_sec_evidence_bindings WHERE subject_id = ? ORDER BY position, binding_id",
		subjectId,
	);
	return {
		subjectId,
		version: version?.v ?? 0,
		bindings: rows.map((row) => ({
			bindingId: row.binding_id,
			snapshotId: row.snapshot_id,
			role: row.role as TgSecEvidenceRole,
			note: row.note,
			position: row.position,
		})),
	};
}

function assertSnapshotIntegrity(row: SnapshotRow): void {
	const fields = fieldsFromRow(row);
	if (snapshotMetadataId(fields) !== row.id) throw new TgSecEvidenceHashMismatchError(row.id);
}

function fieldsFromRow(row: SnapshotRow): TgSecEvidenceSnapshotFields {
	return {
		sourceId: row.source_id,
		capturedAt: row.captured_at,
		url: row.url,
		method: row.method,
		status: row.status,
		contentType: row.content_type,
		reqHead: row.req_head,
		respHead: row.resp_head,
		reqHash: row.req_hash,
		respHash: row.resp_hash,
		reqLen: row.req_len,
		respLen: row.resp_len,
	};
}

type NormalizedRef = { readonly snapshotId: string; readonly role: TgSecEvidenceRole; readonly note: string };

function normalizeRefs(refs: readonly TgSecEvidenceRef[]): NormalizedRef[] {
	const out: NormalizedRef[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const snapshotId = ref.snapshotId.trim();
		if (snapshotId === "") throw new TypeError("an evidence binding needs a snapshot id");
		const role = ref.role ?? "supporting";
		assertRole(role);
		if (seen.has(snapshotId)) continue;
		seen.add(snapshotId);
		out.push({ snapshotId, role, note: ref.note ?? "" });
	}
	return out;
}

function assertRole(role: string): asserts role is TgSecEvidenceRole {
	if (!(EVIDENCE_ROLES as readonly string[]).includes(role)) {
		throw new TypeError(`evidence role ${role} is not one of ${EVIDENCE_ROLES.join(", ")}`);
	}
}

function defaultNow(): number {
	return Date.now();
}

function outcomeOf(error: unknown): EvidenceOutcome {
	if (error instanceof TgSecEvidenceConflictError) return "conflict";
	if (error instanceof TgSecEvidenceNotFoundError) return "not-found";
	return "error";
}

function subjectDigest(subjectId: string): string {
	return createHash("sha256").update(subjectId).digest("hex").slice(0, 16);
}
