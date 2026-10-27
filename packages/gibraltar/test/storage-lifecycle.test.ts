import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/storage/memory.ts";
import { applySqliteMigrations, SQLITE_MIGRATIONS, type SqliteStorage } from "../src/storage/sqlite/index.ts";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import {
	type ConversationId,
	type ConversationMeta,
	type DocumentId,
	type EntryId,
	ROOT_CONVERSATION_ID,
} from "../src/types.ts";

const conversationMeta = (title: string): ConversationMeta => ({
	title,
	cwd: "",
	lane: "test",
	createdAt: 1,
	updatedAt: 1,
});

const context = BACKGROUND_CONTEXT;
const openStorages = new Set<SqliteStorage>();
const tempDirectories = new Set<string>();

afterEach(async () => {
	for (const storage of openStorages) await storage.close(context);
	openStorages.clear();
	for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
	tempDirectories.clear();
});

async function createSqliteStorage(): Promise<{
	readonly storage: SqliteStorage;
	readonly path: string;
	readonly directory: string;
}> {
	const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-lifecycle-"));
	tempDirectories.add(directory);
	const path = join(directory, "storage.sqlite");
	const storage = await openNodeSqliteStorage(path);
	openStorages.add(storage);
	return { storage, path, directory };
}

async function seedConversation(storage: SqliteStorage): Promise<ConversationId> {
	const conversationId = await storage.mintId<ConversationId>();
	const entryId = await storage.mintId<EntryId>();
	const documentId = await storage.mintId<DocumentId>();
	await storage.commit(
		[
			{ type: "conversation", value: { id: ROOT_CONVERSATION_ID }, meta: conversationMeta("fixture") },
			{ type: "conversation", value: { id: conversationId }, meta: conversationMeta("fixture") },
			{ type: "entry", value: { id: entryId, conversationId, kind: "message" } },
			{
				type: "document.create",
				record: {
					id: documentId,
					kind: "lifecycle.notes",
					scope: { kind: "conversation", conversationId },
					history: "latest",
					fork: "current",
				},
				content: { kind: "base", version: 1, value: { count: 1 } },
			},
		],
		context,
	);
	return conversationId;
}

function readMetadataRow(path: string): {
	readonly deleted_conversations: string;
	readonly next_id: string;
	readonly next_seq: number;
} {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const row = database
			.prepare("SELECT deleted_conversations, next_id, next_seq FROM durable_metadata WHERE singleton = 1")
			.get() as
			| {
					readonly deleted_conversations: string;
					readonly next_id: string;
					readonly next_seq: number;
			  }
			| undefined;
		if (row === undefined) throw new Error("durable_metadata row is missing");
		return row;
	} finally {
		database.close();
	}
}

function readTableCounts(path: string): Record<string, number> {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const counts: Record<string, number> = {};
		for (const table of ["conversations", "entries", "tasks", "submissions", "documents", "document_revisions"]) {
			const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { readonly count: number };
			counts[table] = row.count;
		}
		return counts;
	} finally {
		database.close();
	}
}

type ConversationColumn = {
	readonly cid: number;
	readonly name: string;
	readonly type: string;
	readonly notnull: number;
	readonly dflt_value: string | null;
	readonly pk: number;
};

type ConversationColumnShape = Pick<ConversationColumn, "name" | "type" | "notnull" | "dflt_value">;

function readConversationColumns(path: string, table: string): ReadonlyMap<string, ConversationColumnShape> {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const rows = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as ConversationColumn[];
		return new Map(rows.map(({ cid: _cid, pk: _pk, ...column }) => [column.name, column]));
	} finally {
		database.close();
	}
}

function readIndexNames(path: string, table: string): readonly string[] {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const rows = database.prepare(`PRAGMA index_list(${table})`).all() as unknown as { readonly name: string }[];
		return rows.map((row) => row.name);
	} finally {
		database.close();
	}
}

type ConversationMetaRow = {
	readonly title: string;
	readonly cwd: string;
	readonly lane: string;
	readonly created_at: number;
	readonly updated_at: number;
	readonly archived_at: number | null;
	readonly parent_conversation_id: number | null;
};

function readConversationMetaRows(path: string, table = "conversations"): readonly ConversationMetaRow[] {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return database
			.prepare(
				`SELECT title, cwd, lane, created_at, updated_at, archived_at, parent_conversation_id
				FROM ${table} ORDER BY id`,
			)
			.all() as unknown as ConversationMetaRow[];
	} finally {
		database.close();
	}
}

describe("storage lifecycle", () => {
	it("reports schema version 4 and an empty audit column for a fresh database", async () => {
		const { storage, path } = await createSqliteStorage();
		const health = await storage.health();
		expect(health.ok).toBe(true);
		expect(health.schemaVersion).toBe(4);
		expect(readMetadataRow(path).deleted_conversations).toBe("[]");
	});

	it("upgrades a version 2 database to the audit schema in place", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-lifecycle-"));
		tempDirectories.add(directory);
		const path = join(directory, "storage.sqlite");
		const database = await openNodeSqliteDatabase(path);
		try {
			await applySqliteMigrations(database, SQLITE_MIGRATIONS.slice(0, 2));
			const version = (
				await database.get<{ readonly version: number }>("SELECT version FROM durable_schema WHERE singleton = 1")
			)?.version;
			expect(version).toBe(2);
		} finally {
			await database.close();
		}

		const storage = await openNodeSqliteStorage(path);
		openStorages.add(storage);
		expect((await storage.health()).schemaVersion).toBe(4);
		expect(readMetadataRow(path)).toEqual({ deleted_conversations: "[]", next_id: "2", next_seq: 1 });
	});

	it("appends one durable audit event per deletion in deletion order", async () => {
		const { storage, path } = await createSqliteStorage();
		await storage.commit(
			[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID }, meta: conversationMeta("fixture") }],
			context,
		);
		const firstId = await storage.mintId<ConversationId>();
		const firstEntryId = await storage.mintId<EntryId>();
		await storage.commit(
			[
				{ type: "conversation", value: { id: firstId }, meta: conversationMeta("fixture") },
				{ type: "entry", value: { id: firstEntryId, conversationId: firstId, kind: "message" } },
			],
			context,
		);
		const secondId = await storage.mintId<ConversationId>();
		await storage.commit(
			[{ type: "conversation", value: { id: secondId }, meta: conversationMeta("fixture") }],
			context,
		);

		const firstDeletion = await storage.deleteConversation(firstId, context);
		const secondDeletion = await storage.deleteConversation(secondId, context);
		expect(firstDeletion?.projectId).toBe("default");
		expect(firstDeletion?.deletedAt).toBeGreaterThan(0);
		expect(firstDeletion?.counts).toEqual({ entries: 1, tasks: 0, submissions: 0, documents: 0 });
		expect(secondDeletion?.counts).toEqual({ entries: 0, tasks: 0, submissions: 0, documents: 0 });

		const events = JSON.parse(readMetadataRow(path).deleted_conversations) as readonly unknown[];
		expect(events).toEqual([
			{ v: 1, ...firstDeletion! },
			{ v: 1, ...secondDeletion! },
		]);

		// Deletion leaves the file intact: integrity stays ok with the audit column in place.
		const health = await storage.health();
		expect(health.ok).toBe(true);
		expect(health.integrity).toBe("ok");
	});

	it("backs up a consistent snapshot that reopens cleanly with identical rows", async () => {
		const { storage, path, directory } = await createSqliteStorage();
		const conversationId = await seedConversation(storage);
		const backupPath = join(directory, "snapshot.sqlite");
		await storage.backup(backupPath, context);

		const snapshot = await openNodeSqliteStorage(backupPath);
		openStorages.add(snapshot);
		const health = await snapshot.health();
		expect(health.ok).toBe(true);
		expect(health.schemaVersion).toBe(4);
		expect(readTableCounts(backupPath)).toEqual(readTableCounts(path));
		expect(await snapshot.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
		expect(await snapshot.conversation(conversationId, context)).toEqual({ id: conversationId });
	});

	it("rejects a backup onto an existing file and leaves the source intact", async () => {
		const { storage, path, directory } = await createSqliteStorage();
		await seedConversation(storage);
		const backupPath = join(directory, "snapshot.sqlite");
		await storage.backup(backupPath, context);
		const countsBefore = readTableCounts(path);

		await expect(storage.backup(backupPath, context)).rejects.toThrow(/output file already exists/);
		expect((await storage.health()).ok).toBe(true);
		expect(readTableCounts(path)).toEqual(countsBefore);
	});

	it("rejects lifecycle operations after close", async () => {
		const { storage, directory } = await createSqliteStorage();
		await storage.commit(
			[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID }, meta: conversationMeta("fixture") }],
			context,
		);
		await storage.close(context);
		await expect(storage.deleteConversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
		await expect(storage.exportConversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
		await expect(storage.backup(join(directory, "never.sqlite"), context)).rejects.toThrow("closed");
	});

	it("rejects MemoryStorage file backups as an unsupported capability", async () => {
		const storage = new MemoryStorage();
		await storage.commit(
			[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID }, meta: conversationMeta("fixture") }],
			context,
		);
		const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-lifecycle-"));
		tempDirectories.add(directory);
		const path = join(directory, "memory-backup.json");

		await expect(storage.backup(path, context)).rejects.toThrow("cannot write file backups");
		// Rejection is a capability statement; the storage stays open and usable.
		await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).resolves.toEqual({ id: ROOT_CONVERSATION_ID });

		await storage.close(context);
		await expect(storage.backup(path, context)).rejects.toThrow("closed");
	});

	it("adds the conversation metadata columns and backfills rows written before version 4", async () => {
		const { storage, path } = await createSqliteStorage();
		expect((await storage.health()).schemaVersion).toBe(4);
		const columns = readConversationColumns(path, "conversations");
		// Shapes observed through PRAGMA table_info on a STRICT table: NOT NULL display columns carry
		// their SQL defaults, the nullable ancestry and archive stamps carry none.
		expect(columns.get("title")).toEqual({ name: "title", type: "TEXT", notnull: 1, dflt_value: "''" });
		expect(columns.get("cwd")).toEqual({ name: "cwd", type: "TEXT", notnull: 1, dflt_value: "''" });
		expect(columns.get("lane")).toEqual({ name: "lane", type: "TEXT", notnull: 1, dflt_value: "''" });
		expect(columns.get("created_at")).toEqual({ name: "created_at", type: "INTEGER", notnull: 1, dflt_value: "0" });
		expect(columns.get("updated_at")).toEqual({ name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: "0" });
		expect(columns.get("archived_at")).toEqual({
			name: "archived_at",
			type: "INTEGER",
			notnull: 0,
			dflt_value: null,
		});
		expect(columns.get("parent_conversation_id")).toEqual({
			name: "parent_conversation_id",
			type: "INTEGER",
			notnull: 0,
			dflt_value: null,
		});

		// A database left at version 3 with rows already in it: the rows must survive the upgrade with
		// backfilled defaults, and the ID allocation state must not move.
		const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-lifecycle-"));
		tempDirectories.add(directory);
		const upgradePath = join(directory, "upgrade.sqlite");
		const v3 = await openNodeSqliteDatabase(upgradePath);
		try {
			await applySqliteMigrations(v3, SQLITE_MIGRATIONS.slice(0, 3));
			await v3.run(
				`INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record, project_id)
				VALUES (1, NULL, NULL, ?, 'default'), (2, 1, NULL, ?, 'default')`,
				JSON.stringify({ id: 1 }),
				JSON.stringify({ id: 2 }),
			);
		} finally {
			await v3.close();
		}

		const upgraded = await openNodeSqliteStorage(upgradePath);
		openStorages.add(upgraded);
		expect((await upgraded.health()).schemaVersion).toBe(4);
		expect(readConversationMetaRows(upgradePath)).toEqual([
			{
				title: "",
				cwd: "",
				lane: "",
				created_at: 0,
				updated_at: 0,
				archived_at: null,
				parent_conversation_id: null,
			},
			{
				title: "",
				cwd: "",
				lane: "",
				created_at: 0,
				updated_at: 0,
				archived_at: null,
				parent_conversation_id: null,
			},
		]);
		expect(readTableCounts(upgradePath).conversations).toBe(2);
		expect(readMetadataRow(upgradePath)).toEqual({ deleted_conversations: "[]", next_id: "2", next_seq: 1 });
	});

	it("applies the conversation metadata columns to a prefixed schema", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-lifecycle-"));
		tempDirectories.add(directory);
		const path = join(directory, "prefixed.sqlite");
		const storage = await openNodeSqliteStorage(path, { prefix: "tg_" });
		openStorages.add(storage);

		expect((await storage.health()).schemaVersion).toBe(4);
		const columns = readConversationColumns(path, "tg_conversations");
		for (const name of [
			"title",
			"cwd",
			"lane",
			"created_at",
			"updated_at",
			"archived_at",
			"parent_conversation_id",
		]) {
			expect(columns.has(name), name).toBe(true);
		}
		const indexes = readIndexNames(path, "tg_conversations");
		expect(indexes).toContain("tg_conversations_by_updated");
		expect(indexes).toContain("tg_conversations_by_lane");
	});

	it("serves the newest-first history scan through an index without a sort step", async () => {
		const { storage, path } = await createSqliteStorage();
		expect((await storage.health()).schemaVersion).toBe(4);
		const indexes = readIndexNames(path, "conversations");
		expect(indexes).toContain("conversations_by_updated");
		expect(indexes).toContain("conversations_by_lane");

		// Behavioral direction: the first page of the default query is strictly descending by ID.
		await storage.commit(
			[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID }, meta: conversationMeta("root") }],
			context,
		);
		const ids: ConversationId[] = [];
		for (let index = 0; index < 3; index++) {
			const id = await storage.mintId<ConversationId>();
			ids.push(id);
			await storage.commit(
				[{ type: "conversation", value: { id }, meta: conversationMeta(`fixture ${index}`) }],
				context,
			);
		}
		const first = await storage.scanConversationSummaries({}, 2, undefined, context);
		expect(first.items.map(({ id }) => id)).toEqual([ids[2], ids[1]]);
		const second = await storage.scanConversationSummaries({}, 2, first.next, context);
		expect(second.items.map(({ id }) => id)).toEqual([ids[0], ROOT_CONVERSATION_ID]);

		// The real --history query shape must pick an index and must not sort. Which of the two usable
		// indexes the planner chooses is a statistics decision, so the plan is not pinned to one.
		const database = new DatabaseSync(path, { readOnly: true });
		try {
			const plan = database
				.prepare(
					`EXPLAIN QUERY PLAN SELECT id, record, title, cwd, lane, created_at, updated_at, archived_at
					FROM conversations WHERE project_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 21`,
				)
				.all("default") as unknown as readonly { readonly detail: string }[];
			const details = plan.map((row) => row.detail).join("\n");
			expect(details).toMatch(/USING (COVERING )?INDEX/);
			expect(details).not.toContain("TEMP B-TREE");
		} finally {
			database.close();
		}
	});
});
