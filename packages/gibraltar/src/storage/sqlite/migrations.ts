import type { SqliteDatabase } from "./database.ts";
import { DEFAULT_SQLITE_SCHEMA, type SqliteSchema } from "./schema.ts";

/** Project id every row carries when the caller does not supply one. */
export const DEFAULT_PROJECT_ID = "default";

export type SqliteMigration = {
	readonly version: number;
	readonly statements: readonly string[];
};

/** Build immutable, ordered schema history for a set of SQLite identifiers. */
export function createSqliteMigrations(schema: SqliteSchema): readonly SqliteMigration[] {
	const { tables, indexes } = schema;
	// next_id is TEXT because node:sqlite rejects INTEGER results outside JavaScript's safe integer range.
	return [
		{
			version: 1,
			statements: [
				`CREATE TABLE ${tables.durableMetadata} (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id TEXT NOT NULL,
		next_seq INTEGER NOT NULL
	) STRICT`,
				`INSERT INTO ${tables.durableMetadata} (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
				`CREATE TABLE ${tables.recordIds} (
		id INTEGER PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	) STRICT`,
				`CREATE TABLE ${tables.conversations} (
		id INTEGER PRIMARY KEY,
		owner_conversation_id INTEGER,
		owner_task_id INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
				`CREATE INDEX ${indexes.conversationsByOwnerConversation} ON ${tables.conversations} (owner_conversation_id, id)`,
				`CREATE INDEX ${indexes.conversationsByOwnerTask} ON ${tables.conversations} (owner_task_id, id)`,
				`CREATE TABLE ${tables.entries} (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		head INTEGER,
		commit_seq INTEGER NOT NULL,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
				`CREATE INDEX ${indexes.entriesByConversation} ON ${tables.entries} (conversation_id, id DESC)`,
				`CREATE INDEX ${indexes.entryHeadsByConversation} ON ${tables.entries} (conversation_id, id DESC) WHERE head IS NOT NULL`,
				`CREATE TABLE ${tables.tasks} (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
				`CREATE INDEX ${indexes.tasksByStatus} ON ${tables.tasks} (status, id)`,
				`CREATE INDEX ${indexes.tasksByConversation} ON ${tables.tasks} (conversation_id, id)`,
				`CREATE INDEX ${indexes.tasksByKind} ON ${tables.tasks} (kind, id)`,
				`CREATE INDEX ${indexes.tasksByAbortRequested} ON ${tables.tasks} (abort_requested, id)`,
				`CREATE INDEX ${indexes.tasksByBackground} ON ${tables.tasks} (background, id)`,
				`CREATE TABLE ${tables.submissions} (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
				`CREATE INDEX ${indexes.submissionsByRequest} ON ${tables.submissions} (conversation_id, request_id)`,
				`CREATE INDEX ${indexes.submissionsByConversation} ON ${tables.submissions} (conversation_id, id)`,
				`CREATE INDEX ${indexes.submissionsByStatus} ON ${tables.submissions} (status, id)`,
				`CREATE TABLE ${tables.documents} (
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
				`CREATE INDEX ${indexes.documentsByAddress}
		ON ${tables.documents} (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
				`CREATE INDEX ${indexes.documentsByScope} ON ${tables.documents} (scope_kind, owner_id, id)`,
				`CREATE INDEX ${indexes.documentsByScopeKind} ON ${tables.documents} (scope_kind, owner_id, kind, id)`,
				`CREATE TABLE ${tables.documentRevisions} (
		document_id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version INTEGER NOT NULL,
		content TEXT NOT NULL CHECK (json_valid(content)),
		PRIMARY KEY (document_id, seq)
	) STRICT`,
				`CREATE INDEX ${indexes.documentRevisionsByKind} ON ${tables.documentRevisions} (document_id, kind, seq DESC)`,
			],
		},
	];
}

// Version 2 adds project isolation. Every scoped row carries the project it belongs to, so one
// database file can hold many projects and each query sees only its own. `project_id` is an opaque
// caller-supplied key, not a foreign key: a project row is created lazily by the Harness, and the
// storage layer must stay usable with a caller-managed key space.
//
// Rows written before version 2 carry the reserved project id `default`, which is what the
// project-less API still writes to.
const PROJECT_ID_CHECK = "CHECK (project_id <> '')";
const SQL_DEFAULT_PROJECT_ID = "'default'";

function renderProjectIsolation(schema: SqliteSchema): readonly string[] {
	const { tables, indexes } = schema;
	return [
		`ALTER TABLE ${tables.conversations} ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
		`ALTER TABLE ${tables.entries} ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
		`ALTER TABLE ${tables.tasks} ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
		`ALTER TABLE ${tables.submissions} ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
		`ALTER TABLE ${tables.documents} ADD COLUMN project_id TEXT NOT NULL DEFAULT ${SQL_DEFAULT_PROJECT_ID} ${PROJECT_ID_CHECK}`,
		// Rebuilt per table: a project-scoped index is the access path every scan actually takes.
		`DROP INDEX IF EXISTS ${indexes.entriesByConversation}`,
		`DROP INDEX IF EXISTS ${indexes.entryHeadsByConversation}`,
		`DROP INDEX IF EXISTS ${indexes.tasksByStatus}`,
		`DROP INDEX IF EXISTS ${indexes.tasksByConversation}`,
		`DROP INDEX IF EXISTS ${indexes.tasksByKind}`,
		`DROP INDEX IF EXISTS ${indexes.tasksByAbortRequested}`,
		`DROP INDEX IF EXISTS ${indexes.tasksByBackground}`,
		`DROP INDEX IF EXISTS ${indexes.submissionsByRequest}`,
		`DROP INDEX IF EXISTS ${indexes.submissionsByConversation}`,
		`DROP INDEX IF EXISTS ${indexes.submissionsByStatus}`,
		`DROP INDEX IF EXISTS ${indexes.documentsByAddress}`,
		`DROP INDEX IF EXISTS ${indexes.documentsByScope}`,
		`DROP INDEX IF EXISTS ${indexes.documentsByScopeKind}`,
		`CREATE INDEX ${indexes.entriesByConversation} ON ${tables.entries} (project_id, conversation_id, id DESC)`,
		`CREATE INDEX ${indexes.entryHeadsByConversation} ON ${tables.entries} (project_id, conversation_id, id DESC) WHERE head IS NOT NULL`,
		`CREATE INDEX ${indexes.tasksByStatus} ON ${tables.tasks} (project_id, status, id)`,
		`CREATE INDEX ${indexes.tasksByConversation} ON ${tables.tasks} (project_id, conversation_id, id)`,
		`CREATE INDEX ${indexes.tasksByKind} ON ${tables.tasks} (project_id, kind, id)`,
		`CREATE INDEX ${indexes.tasksByAbortRequested} ON ${tables.tasks} (project_id, abort_requested, id)`,
		`CREATE INDEX ${indexes.tasksByBackground} ON ${tables.tasks} (project_id, background, id)`,
		`CREATE INDEX ${indexes.submissionsByRequest} ON ${tables.submissions} (project_id, conversation_id, request_id)`,
		`CREATE INDEX ${indexes.submissionsByConversation} ON ${tables.submissions} (project_id, conversation_id, id)`,
		`CREATE INDEX ${indexes.submissionsByStatus} ON ${tables.submissions} (project_id, status, id)`,
		`CREATE INDEX ${indexes.documentsByAddress}
		ON ${tables.documents} (project_id, kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
		`CREATE INDEX ${indexes.documentsByScope} ON ${tables.documents} (project_id, scope_kind, owner_id, id)`,
		`CREATE INDEX ${indexes.documentsByScopeKind} ON ${tables.documents} (project_id, scope_kind, owner_id, kind, id)`,
		`CREATE TABLE ${tables.projects} (
		id TEXT PRIMARY KEY,
		worktree TEXT NOT NULL,
		name TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	) STRICT`,
		`INSERT INTO ${tables.projects} (id, worktree, created_at, updated_at)
		SELECT DISTINCT project_id, '', strftime('%s','now') * 1000, strftime('%s','now') * 1000 FROM ${tables.conversations}`,
		`CREATE TABLE ${tables.health} (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		integrity TEXT NOT NULL CHECK (integrity IN ('ok', 'corrupt')),
		checked_at INTEGER NOT NULL
	) STRICT`,
	];
}

// Version 3 adds the conversation-deletion audit to the storage singleton. One ALTER on the metadata table
// only: the data tables (conversations, entries, tasks, submissions, documents, document_revisions,
// record_ids) do not change. The column is read and written only by deleteConversation; commit's metadata
// SELECT lists next_id and next_seq explicitly, so the audit never touches the commit path. Events append
// at the array tail as {v, conversationId, projectId, deletedAt, counts}.
function renderDeletionAudit(schema: SqliteSchema): readonly string[] {
	return [`ALTER TABLE ${schema.tables.durableMetadata} ADD COLUMN deleted_conversations TEXT NOT NULL DEFAULT '[]'`];
}

/** Immutable, ordered schema history. Append new migrations after the initial schema ships. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
	...createSqliteMigrations(DEFAULT_SQLITE_SCHEMA),
	{ version: 2, statements: renderProjectIsolation(DEFAULT_SQLITE_SCHEMA) },
	{ version: 3, statements: renderDeletionAudit(DEFAULT_SQLITE_SCHEMA) },
];

export const CURRENT_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;

type SchemaRow = { readonly version: number };

/** Apply all pending schema migrations atomically. */
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Promise<void> {
	return applySqliteMigrationsForSchema(database, DEFAULT_SQLITE_SCHEMA, migrations);
}

/** Apply migrations rendered for a particular schema. */
export async function applySqliteMigrationsForSchema(
	database: SqliteDatabase,
	schema: SqliteSchema,
	migrations: readonly SqliteMigration[] = [
		...createSqliteMigrations(schema),
		{ version: 2, statements: renderProjectIsolation(schema) },
		{ version: 3, statements: renderDeletionAudit(schema) },
	],
): Promise<void> {
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("Durable SQLite migrations must have contiguous versions starting at 1");
		}
	}

	const { durableSchema } = schema.tables;
	await database.transaction(async (transaction) => {
		await transaction.exec(`CREATE TABLE IF NOT EXISTS ${durableSchema} (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT`);
		await transaction.run(`INSERT OR IGNORE INTO ${durableSchema} (singleton, version) VALUES (1, 0)`);
		const row = await transaction.get<SchemaRow>(`SELECT version FROM ${durableSchema} WHERE singleton = 1`);
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
			await transaction.run(`UPDATE ${durableSchema} SET version = ? WHERE singleton = 1`, migration.version);
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
