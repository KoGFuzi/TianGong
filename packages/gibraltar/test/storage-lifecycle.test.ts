import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/storage/memory.ts";
import { applySqliteMigrations, SQLITE_MIGRATIONS, type SqliteStorage } from "../src/storage/sqlite/index.ts";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { type ConversationId, type DocumentId, type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";

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
			{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
			{ type: "conversation", value: { id: conversationId } },
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

describe("storage lifecycle", () => {
	it("reports schema version 3 and an empty audit column for a fresh database", async () => {
		const { storage, path } = await createSqliteStorage();
		const health = await storage.health();
		expect(health.ok).toBe(true);
		expect(health.schemaVersion).toBe(3);
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
		expect((await storage.health()).schemaVersion).toBe(3);
		expect(readMetadataRow(path)).toEqual({ deleted_conversations: "[]", next_id: "2", next_seq: 1 });
	});

	it("appends one durable audit event per deletion in deletion order", async () => {
		const { storage, path } = await createSqliteStorage();
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const firstId = await storage.mintId<ConversationId>();
		const firstEntryId = await storage.mintId<EntryId>();
		await storage.commit(
			[
				{ type: "conversation", value: { id: firstId } },
				{ type: "entry", value: { id: firstEntryId, conversationId: firstId, kind: "message" } },
			],
			context,
		);
		const secondId = await storage.mintId<ConversationId>();
		await storage.commit([{ type: "conversation", value: { id: secondId } }], context);

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
		expect(health.schemaVersion).toBe(3);
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
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		await storage.close(context);
		await expect(storage.deleteConversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
		await expect(storage.exportConversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
		await expect(storage.backup(join(directory, "never.sqlite"), context)).rejects.toThrow("closed");
	});

	it("rejects MemoryStorage file backups as an unsupported capability", async () => {
		const storage = new MemoryStorage();
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-lifecycle-"));
		tempDirectories.add(directory);
		const path = join(directory, "memory-backup.json");

		await expect(storage.backup(path, context)).rejects.toThrow("cannot write file backups");
		// Rejection is a capability statement; the storage stays open and usable.
		await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).resolves.toEqual({ id: ROOT_CONVERSATION_ID });

		await storage.close(context);
		await expect(storage.backup(path, context)).rejects.toThrow("closed");
	});
});
