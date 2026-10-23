/**
 * The evidence index schema. Metadata is **columnar** — no JSON is stored anywhere — and the three
 * tables mirror ARTEX's `traffic_evidence_snapshots` / `finding_traffic_bindings` / `evidence_version`
 * contract, generalized so the "subject" owning a set of evidence is an opaque string key (the finding
 * and report tables arrive with the later batches).
 *
 * - `tg_sec_evidence_snapshots` — immutable content facts. `id` is the metadata hash (recomputed to
 *   detect tampering); `req_hash`/`resp_hash` address the two independent body blobs; `unreferenced_at`
 *   starts GC's 24-hour grace once nothing binds the snapshot.
 * - `tg_sec_evidence_bindings` — which snapshots a subject claims, with a role, note and display
 *   order. `UNIQUE(subject_id, snapshot_id)` makes a re-bind a no-op, which is what lets the version
 *   bump fire only on a real change.
 * - `tg_sec_evidence_versions` — the per-subject `evidence_version` the optimistic lock compares.
 */
export const EVIDENCE_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS tg_sec_evidence_snapshots (
		id TEXT PRIMARY KEY,
		source_id TEXT NOT NULL,
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
	"CREATE INDEX IF NOT EXISTS tg_sec_evidence_bindings_subject ON tg_sec_evidence_bindings (subject_id, position)",
	"CREATE INDEX IF NOT EXISTS tg_sec_evidence_snapshots_unreferenced ON tg_sec_evidence_snapshots (unreferenced_at)",
];
