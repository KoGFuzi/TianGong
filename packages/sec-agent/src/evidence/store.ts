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
import {
	assertTgSecFindingSeverity,
	assertTgSecFindingStatus,
	isTgSecFindingTransitionAllowed,
	isTgSecRetestStatus,
	type TgSecFindingSeverity,
	type TgSecFindingStatus,
} from "../finding-vocabulary.ts";
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

/** One finding: the campaign's verdict on the subject its evidence is bound to. */
export type TgSecFindingRecord = {
	readonly findingId: string;
	readonly lane: string;
	readonly title: string;
	readonly severity: TgSecFindingSeverity;
	readonly status: TgSecFindingStatus;
	readonly subjectId: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** The newest snapshot a retest attached; empty until the first retest. */
	readonly retestSnapshotId: string;
};

/**
 * One create-or-update request. A finding that does not exist yet is created `open` from `lane`,
 * `title` and `severity`; the rest of the fields patch an existing one. `snapshotId` is the new
 * evidence a retest transition must carry.
 */
export type TgSecFindingWriteInput = {
	readonly findingId: string;
	readonly expectedVersion?: number | null;
	readonly lane?: string;
	readonly title?: string;
	readonly severity?: TgSecFindingSeverity;
	readonly status?: TgSecFindingStatus;
	readonly snapshotId?: string;
};

/** The settled row plus the subject version it was written at. */
export type TgSecFindingWriteResult = {
	readonly finding: TgSecFindingRecord;
	readonly version: number;
	readonly created: boolean;
	readonly changed: boolean;
};

type SnapshotRow = {
	id: string;
	source_id: string;
	flow_id: string;
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

const SNAPSHOT_COLUMNS = `id, source_id, flow_id, captured_at, url, method, status, content_type, req_head, resp_head, req_hash, req_len, resp_hash, resp_len, created_at, unreferenced_at`;

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
					`INSERT INTO tg_sec_evidence_snapshots (id, source_id, flow_id, captured_at, url, method, status, content_type, req_head, resp_head, req_hash, req_len, resp_hash, resp_len, created_at, unreferenced_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
					id,
					fields.sourceId,
					fields.flowId ?? "",
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
	 * Create a finding or patch an existing one. The write shares `tg_sec_evidence_versions` with the
	 * evidence set — `expectedVersion` is the same optimistic lock `bind`/`edit` take — so a verdict
	 * can never race a capture into a state the caller did not read. Creation starts `open`; a status
	 * move must be legal, and a retest (`retest-pass`/`retest-fail`) must name a snapshot bound to the
	 * subject that differs from the one the previous retest recorded. That is the mechanism behind
	 * "a retest leaves new evidence", not a prompt rule.
	 */
	writeFinding(input: TgSecFindingWriteInput): Promise<TgSecFindingWriteResult> {
		const findingId = input.findingId.trim();
		if (findingId === "") throw new TypeError("a finding needs an id");
		return this.emitEvidence("edit", findingId, async () => {
			const result = await this.db.transaction(async (tx) => {
				const existing = await readFinding(tx, findingId);
				const now = this.now();
				if (existing === undefined) {
					const lane = input.lane?.trim() ?? "";
					const title = input.title?.trim() ?? "";
					if (lane === "") throw new TypeError("creating a finding needs a lane");
					if (title === "") throw new TypeError("creating a finding needs a title");
					if (input.severity === undefined) throw new TypeError("creating a finding needs a severity");
					assertTgSecFindingSeverity(input.severity);
					if (input.status !== undefined && input.status !== "open") {
						throw new TypeError("a finding starts open; verify it only once evidence exists");
					}
					if (input.snapshotId !== undefined) {
						throw new TypeError("a finding cannot record a retest before it exists");
					}
					await this.lockSubject(tx, findingId, input.expectedVersion ?? null);
					await tx.run(
						`INSERT INTO tg_sec_findings (finding_id, lane, title, severity, status, subject_id, retest_snapshot_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?, 'open', ?, '', ?, ?)`,
						findingId,
						lane,
						title,
						input.severity,
						findingId,
						now,
						now,
					);
					await bumpSubjectVersion(tx, findingId);
					const finding = await readFinding(tx, findingId);
					return {
						finding: finding!,
						version: await readSubjectVersion(tx, findingId),
						created: true,
						changed: true,
					};
				}

				await this.lockSubject(tx, existing.subjectId, input.expectedVersion ?? null);
				if (input.lane !== undefined && input.lane.trim() !== existing.lane) {
					throw new TypeError(`finding ${findingId}'s lane is fixed at creation`);
				}
				const title = input.title === undefined ? existing.title : input.title.trim();
				if (title === "") throw new TypeError("a finding needs a title");
				const severity = input.severity ?? existing.severity;
				assertTgSecFindingSeverity(severity);
				const status = input.status ?? existing.status;
				assertTgSecFindingStatus(status);

				let retestSnapshotId = existing.retestSnapshotId;
				if (status !== existing.status) {
					if (!isTgSecFindingTransitionAllowed(existing.status, status)) {
						throw new TypeError(`finding ${findingId} cannot move from ${existing.status} to ${status}`);
					}
					if (isTgSecRetestStatus(status)) {
						retestSnapshotId = await requireRetestSnapshot(
							tx,
							existing.subjectId,
							input.snapshotId,
							existing.retestSnapshotId,
						);
					} else if (input.snapshotId !== undefined) {
						throw new TypeError(`only a retest records a snapshot; ${status} does not`);
					}
				} else if (isTgSecRetestStatus(status) && input.snapshotId !== undefined) {
					retestSnapshotId = await requireRetestSnapshot(
						tx,
						existing.subjectId,
						input.snapshotId,
						existing.retestSnapshotId,
					);
				} else if (input.snapshotId !== undefined) {
					throw new TypeError(`only a retest records a snapshot; ${status} does not`);
				}

				const changed =
					title !== existing.title ||
					severity !== existing.severity ||
					status !== existing.status ||
					retestSnapshotId !== existing.retestSnapshotId;
				if (changed) {
					await tx.run(
						"UPDATE tg_sec_findings SET title = ?, severity = ?, status = ?, retest_snapshot_id = ?, updated_at = ? WHERE finding_id = ?",
						title,
						severity,
						status,
						retestSnapshotId,
						now,
						findingId,
					);
					await bumpSubjectVersion(tx, existing.subjectId);
				}
				const finding = await readFinding(tx, findingId);
				return {
					finding: finding!,
					version: await readSubjectVersion(tx, existing.subjectId),
					created: false,
					changed,
				};
			});
			return { value: result, changed: result.changed || result.created, count: 1 };
		});
	}

	/** One finding by id, or `undefined` when it was never registered. */
	getFinding(findingId: string): Promise<TgSecFindingRecord | undefined> {
		const id = findingId.trim();
		return this.emitEvidence("read", id === "" ? undefined : id, async () => {
			const finding = await this.db.transaction((tx) => readFinding(tx, id));
			return { value: finding, changed: false, count: finding === undefined ? 0 : 1 };
		});
	}

	/** Every registered finding in id order; the report renderer and the projection both enumerate. */
	listFindings(): Promise<readonly TgSecFindingRecord[]> {
		return this.emitEvidence("list", undefined, async () => {
			const findings = await this.db.transaction((tx) => readFindings(tx));
			return { value: findings, changed: false, count: findings.length };
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
	// A database written before flow references existed has the table but not the column; the default
	// keeps every stored id verifying, because an empty flow id encodes exactly as it did then.
	const columns = await database.all<{ name: string }>("PRAGMA table_info(tg_sec_evidence_snapshots)");
	if (!columns.some((column) => column.name === "flow_id")) {
		await database.exec("ALTER TABLE tg_sec_evidence_snapshots ADD COLUMN flow_id TEXT NOT NULL DEFAULT ''");
	}
	return new TgSecEvidenceStore(
		database,
		new EvidenceBlobStore(options.dir),
		options.dir,
		options.now ?? defaultNow,
		options.telemetry ?? NOOP_TELEMETRY_CONTEXT,
	);
}

type FindingRow = {
	finding_id: string;
	lane: string;
	title: string;
	severity: string;
	status: string;
	subject_id: string;
	retest_snapshot_id: string;
	created_at: number;
	updated_at: number;
};

const FINDING_COLUMNS = `finding_id, lane, title, severity, status, subject_id, retest_snapshot_id, created_at, updated_at`;

async function readFinding(tx: SqliteExecutor, findingId: string): Promise<TgSecFindingRecord | undefined> {
	const row = await tx.get<FindingRow>(
		`SELECT ${FINDING_COLUMNS} FROM tg_sec_findings WHERE finding_id = ?`,
		findingId,
	);
	return row === undefined ? undefined : findingFromRow(row);
}

async function readFindings(tx: SqliteExecutor): Promise<TgSecFindingRecord[]> {
	const rows = await tx.all<FindingRow>(`SELECT ${FINDING_COLUMNS} FROM tg_sec_findings ORDER BY finding_id`);
	return rows.map(findingFromRow);
}

function findingFromRow(row: FindingRow): TgSecFindingRecord {
	assertTgSecFindingSeverity(row.severity);
	assertTgSecFindingStatus(row.status);
	return {
		findingId: row.finding_id,
		lane: row.lane,
		title: row.title,
		severity: row.severity,
		status: row.status,
		subjectId: row.subject_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		retestSnapshotId: row.retest_snapshot_id,
	};
}

async function readSubjectVersion(tx: SqliteExecutor, subjectId: string): Promise<number> {
	const row = await tx.get<{ v: number }>(
		"SELECT evidence_version AS v FROM tg_sec_evidence_versions WHERE subject_id = ?",
		subjectId,
	);
	return row?.v ?? 0;
}

async function bumpSubjectVersion(tx: SqliteExecutor, subjectId: string): Promise<void> {
	await tx.run(
		"UPDATE tg_sec_evidence_versions SET evidence_version = evidence_version + 1 WHERE subject_id = ?",
		subjectId,
	);
}

/** A retest transition must cite a snapshot bound to the subject and not the one already recorded. */
async function requireRetestSnapshot(
	tx: SqliteExecutor,
	subjectId: string,
	rawSnapshotId: string | undefined,
	previousSnapshotId: string,
): Promise<string> {
	const snapshotId = rawSnapshotId?.trim() ?? "";
	if (snapshotId === "") throw new TypeError("a retest needs a new evidence snapshot id");
	if (snapshotId === previousSnapshotId) throw new TgSecEvidenceConflictError();
	const bound = await tx.get<{ one: number }>(
		"SELECT 1 AS one FROM tg_sec_evidence_bindings WHERE subject_id = ? AND snapshot_id = ?",
		subjectId,
		snapshotId,
	);
	if (bound === undefined) throw new TgSecEvidenceNotFoundError();
	return snapshotId;
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
		flowId: row.flow_id,
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
