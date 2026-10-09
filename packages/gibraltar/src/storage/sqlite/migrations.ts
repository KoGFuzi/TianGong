import type { SqliteDatabase } from "./database.ts";

/** Project id every row carries when the caller does not supply one. */
export const DEFAULT_PROJECT_ID = "default";

export type SqliteMigration = {
	readonly version: number;
	readonly statements: readonly string[];
};

// next_id is TEXT because node:sqlite rejects INTEGER results outside JavaScript's safe integer range.
const INITIAL_SCHEMA: readonly string[] = [
	`CREATE TABLE durable_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id TEXT NOT NULL,
		next_seq INTEGER NOT NULL
	) STRICT`,
	`INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
	`CREATE TABLE record_ids (
		id INTEGER PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	) STRICT`,
	`CREATE TABLE conversations (
		id INTEGER PRIMARY KEY,
		owner_conversation_id INTEGER,
		owner_task_id INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	"CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)",
	"CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)",
	`CREATE TABLE entries (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		head INTEGER,
		commit_seq INTEGER NOT NULL,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	"CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)",
	"CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL",
	`CREATE TABLE tasks (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	"CREATE INDEX tasks_by_status ON tasks (status, id)",
	"CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
	"CREATE INDEX tasks_by_kind ON tasks (kind, id)",
	"CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
	"CREATE INDEX tasks_by_background ON tasks (background, id)",
	`CREATE TABLE submissions (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	"CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
	"CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)",
	"CREATE INDEX submissions_by_status ON submissions (status, id)",
	`CREATE TABLE documents (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		family INTEGER NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		retired_at INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	`CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
	"CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)",
	"CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)",
	`CREATE TABLE document_revisions (
		document_id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version INTEGER NOT NULL,
		content TEXT NOT NULL CHECK (json_valid(content)),
		PRIMARY KEY (document_id, seq)
	) STRICT`,
	"CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)",
];

// Version 2 adds project isolation. Every scoped row carries the project it belongs to, so one
// database file can hold many projects and each query sees only its own. `project_id` is an opaque
// caller-supplied key, not a foreign key: a project row is created lazily by the Harness, and the
// storage layer must stay usable with a caller-managed key space.
//
// Rows written before version 2 carry the reserved project id `default`, which is what the
// project-less API still writes to.
const PROJECT_ID_CHECK = "CHECK (project_id <> '')";
const SQL_DEFAULT_PROJECT_ID = "'default'";

const ADD_PROJECT_ID: readonly string[] = [
	`ALTER TABLE conversations ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
	`ALTER TABLE entries ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
	`ALTER TABLE tasks ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
	`ALTER TABLE submissions ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
	`ALTER TABLE documents ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
	// Rebuilt per table: a project-scoped index is the access path every scan actually takes.
	"DROP INDEX IF EXISTS entries_by_conversation",
	"DROP INDEX IF EXISTS entry_heads_by_conversation",
	"DROP INDEX IF EXISTS tasks_by_status",
	"DROP INDEX IF EXISTS tasks_by_conversation",
	"DROP INDEX IF EXISTS tasks_by_kind",
	"DROP INDEX IF EXISTS tasks_by_abort_requested",
	"DROP INDEX IF EXISTS tasks_by_background",
	"DROP INDEX IF EXISTS submissions_by_request",
	"DROP INDEX IF EXISTS submissions_by_conversation",
	"DROP INDEX IF EXISTS submissions_by_status",
	"DROP INDEX IF EXISTS documents_by_address",
	"DROP INDEX IF EXISTS documents_by_scope",
	"DROP INDEX IF EXISTS documents_by_scope_kind",
	"CREATE INDEX entries_by_conversation ON entries (project_id, conversation_id, id DESC)",
	"CREATE INDEX entry_heads_by_conversation ON entries (project_id, conversation_id, id DESC) WHERE head IS NOT NULL",
	"CREATE INDEX tasks_by_status ON tasks (project_id, status, id)",
	"CREATE INDEX tasks_by_conversation ON tasks (project_id, conversation_id, id)",
	"CREATE INDEX tasks_by_kind ON tasks (project_id, kind, id)",
	"CREATE INDEX tasks_by_abort_requested ON tasks (project_id, abort_requested, id)",
	"CREATE INDEX tasks_by_background ON tasks (project_id, background, id)",
	"CREATE INDEX submissions_by_request ON submissions (project_id, conversation_id, request_id)",
	"CREATE INDEX submissions_by_conversation ON submissions (project_id, conversation_id, id)",
	"CREATE INDEX submissions_by_status ON submissions (project_id, status, id)",
	`CREATE INDEX documents_by_address
		ON documents (project_id, kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
	"CREATE INDEX documents_by_scope ON documents (project_id, scope_kind, owner_id, id)",
	"CREATE INDEX documents_by_scope_kind ON documents (project_id, scope_kind, owner_id, kind, id)",
	`CREATE TABLE projects (
		id TEXT PRIMARY KEY,
		worktree TEXT NOT NULL,
		name TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	) STRICT`,
	`INSERT INTO projects (id, worktree, created_at, updated_at)
		SELECT DISTINCT project_id, '', strftime('%s','now') * 1000, strftime('%s','now') * 1000 FROM conversations`,
	`CREATE TABLE health (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		integrity TEXT NOT NULL CHECK (integrity IN ('ok', 'corrupt')),
		checked_at INTEGER NOT NULL
	) STRICT`,
];

// Version 3 adds the conversation-deletion audit to the storage singleton. One ALTER on durable_metadata
// only: the data tables (conversations, entries, tasks, submissions, documents, document_revisions,
// record_ids) do not change. The column is read and written only by deleteConversation; commit's metadata
// SELECT lists next_id and next_seq explicitly, so the audit never touches the commit path. Events append
// at the array tail as {v, conversationId, projectId, deletedAt, counts}.
const ADD_DELETION_AUDIT: readonly string[] = [
	`ALTER TABLE durable_metadata ADD COLUMN deleted_conversations TEXT NOT NULL DEFAULT '[]'`,
];

/** Immutable, ordered schema history. Append new migrations after the initial schema ships. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
	{ version: 1, statements: INITIAL_SCHEMA },
	{ version: 2, statements: ADD_PROJECT_ID },
	{ version: 3, statements: ADD_DELETION_AUDIT },
];

export const CURRENT_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;

type SchemaRow = { readonly version: number };

/** Apply all pending schema migrations atomically. */
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Promise<void> {
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("Durable SQLite migrations must have contiguous versions starting at 1");
		}
	}

	await database.transaction(async (transaction) => {
		await transaction.exec(`CREATE TABLE IF NOT EXISTS durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT`);
		await transaction.run("INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)");
		const row = await transaction.get<SchemaRow>("SELECT version FROM durable_schema WHERE singleton = 1");
		if (row === undefined) throw new Error("Durable SQLite schema metadata is missing");
		const currentVersion = migrations.at(-1)?.version ?? 0;
		if (row.version > currentVersion) {
			throw new Error(
				`Durable SQLite schema version ${row.version} is newer than supported version ${currentVersion}`,
			);
		}
		for (const migration of migrations) {
			if (migration.version <= row.version) continue;
			for (const statement of migration.statements) await transaction.exec(statement);
			await transaction.run("UPDATE durable_schema SET version = ? WHERE singleton = 1", migration.version);
		}
	});
}

/**
 * Settings for one SQLite storage instance.
 */
export type SqliteStorageOptions = {
	/**
	 * Project id written into every row and applied as a filter to every read.
	 *
	 * One database file can hold several projects; this is what keeps them apart. Rows written before
	 * version 2 of the schema carry `default`, which is the value used when this is omitted. Must not
	 * be empty.
	 */
	readonly project?: string;
};
