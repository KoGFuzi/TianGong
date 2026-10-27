import { TG_SEC_FINDING_SEVERITIES, TG_SEC_FINDING_STATUSES } from "../finding-vocabulary.ts";

/**
 * The evidence index schema. Metadata is **columnar** — no JSON is stored anywhere — and the four
 * tables mirror ARTEX's `traffic_evidence_snapshots` / `finding_traffic_bindings` / `evidence_version`
 * contract, generalized so the "subject" owning a set of evidence is an opaque string key.
 *
 * - `tg_sec_evidence_snapshots` — immutable content facts. `id` is the metadata hash (recomputed to
 *   detect tampering); `req_hash`/`resp_hash` address the two independent body blobs; `flow_id` names
 *   the Yakit http-flow the bodies came from, empty for every other capture; `unreferenced_at`
 *   starts GC's 24-hour grace once nothing binds the snapshot.
 * - `tg_sec_evidence_bindings` — which snapshots a subject claims, with a role, note and display
 *   order. `UNIQUE(subject_id, snapshot_id)` makes a re-bind a no-op, which is what lets the version
 *   bump fire only on a real change.
 * - `tg_sec_evidence_versions` — the per-subject `evidence_version` the optimistic lock compares.
 *   Findings share it: one subject, one version, one concurrency mechanism.
 * - `tg_sec_findings` — the campaign's verdict on a subject. Severity and status are constrained by
 *   the same vocabulary `sections.ts` renders, so the prompt can never name a level the store rejects;
 *   `retest_snapshot_id` records the newest snapshot a retest attached.
 */
const FINDING_SEVERITY_VALUES = TG_SEC_FINDING_SEVERITIES.map((value) => `'${value}'`).join(", ");
const FINDING_STATUS_VALUES = TG_SEC_FINDING_STATUSES.map((value) => `'${value}'`).join(", ");

export const EVIDENCE_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS tg_sec_evidence_snapshots (
		id TEXT PRIMARY KEY,
		source_id TEXT NOT NULL,
		flow_id TEXT NOT NULL DEFAULT '',
		captured_at INTEGER NOT NULL,
		url TEXT NOT NULL,
		method TEXT NOT NULL,
		status INTEGER NOT NULL,
		content_type TEXT NOT NULL,
		req_head TEXT NOT NULL,
		resp_head TEXT NOT NULL,
		req_hash TEXT NOT NULL,
		req_len INTEGER NOT NULL,
		resp_hash TEXT NOT NULL,
		resp_len INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		unreferenced_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS tg_sec_evidence_bindings (
		binding_id INTEGER PRIMARY KEY AUTOINCREMENT,
		subject_id TEXT NOT NULL,
		snapshot_id TEXT NOT NULL,
		role TEXT NOT NULL,
		note TEXT NOT NULL,
		position INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		UNIQUE (subject_id, snapshot_id)
	)`,
	`CREATE TABLE IF NOT EXISTS tg_sec_evidence_versions (
		subject_id TEXT PRIMARY KEY,
		evidence_version INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS tg_sec_findings (
		finding_id TEXT PRIMARY KEY,
		lane TEXT NOT NULL,
		title TEXT NOT NULL,
		severity TEXT NOT NULL CHECK (severity IN (${FINDING_SEVERITY_VALUES})),
		status TEXT NOT NULL CHECK (status IN (${FINDING_STATUS_VALUES})),
		subject_id TEXT NOT NULL,
		retest_snapshot_id TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS tg_sec_evidence_bindings_subject ON tg_sec_evidence_bindings (subject_id, position)",
	"CREATE INDEX IF NOT EXISTS tg_sec_evidence_snapshots_unreferenced ON tg_sec_evidence_snapshots (unreferenced_at)",
	"CREATE INDEX IF NOT EXISTS tg_sec_findings_subject ON tg_sec_findings (subject_id)",
];
