import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import {
	applySqliteMigrations,
	CURRENT_SQLITE_SCHEMA_VERSION,
	DEFAULT_PROJECT_ID,
	SQLITE_MIGRATIONS,
} from "../src/storage/sqlite/migrations.ts";
import { openDefaultSqliteStorage, openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { SqliteStorage } from "../src/storage/sqlite/storage.ts";
import { type ConversationId, type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";

const directories: string[] = [];
afterAll(async () => {
	await Promise.all(directories.map((directory) => rm(directory, { force: true, recursive: true })));
});

/** Temporary database file, plus the directory holding it so cleanup removes both. */
async function tempFile(name: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-sqlite-"));
	directories.push(directory);
	return join(directory, name);
}

describe("SQLite health", () => {
	it("reports integrity, schema version, and the connection settings this adapter applied", async () => {
		const path = await tempFile("health.sqlite");
		const storage = await openNodeSqliteStorage(path);
		const health = await storage.health();
		expect(health.ok).toBe(true);
		expect(health.integrity).toBe("ok");
		expect(health.schemaVersion).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
		expect(health.journalMode).toBe("wal");
		expect(health.synchronous).toBe(1);
		expect(health.walAutoCheckpointPages).toBe(1000);
		expect(health.busyTimeoutMs).toBe(5000);
		await storage.checkpoint();
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("reflects a caller's connection settings instead of the adapter defaults", async () => {
		const storage = await openNodeSqliteStorage(await tempFile("custom.sqlite"), {
			busyTimeoutMs: 250,
			walAutoCheckpointPages: 64,
		});
		const health = await storage.health();
		expect(health.busyTimeoutMs).toBe(250);
		expect(health.walAutoCheckpointPages).toBe(64);
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("reports schema version 0 before any migration has run", async () => {
		const path = await tempFile("uninitialised.sqlite");
		const database = await openNodeSqliteDatabase(path);
		expect(await database.health()).toMatchObject({ ok: true, schemaVersion: 0 });
		await database.close();
		// Opening a file does not migrate it: it stays empty until storage is opened over it.
		const storage = await openNodeSqliteStorage(path);
		expect(await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toBeUndefined();
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("reports schema version 0 before any migration has run", async () => {
		const path = await tempFile("uninitialised.sqlite");
		const database = await openNodeSqliteDatabase(path);
		expect(await database.health()).toMatchObject({ ok: true, schemaVersion: 0 });
		await database.close();
		// The file is still empty: opening it did not migrate anything.
		const reopened = await openNodeSqliteStorage(path);
		expect(await reopened.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toBeUndefined();
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("reflects a caller's connection settings instead of the adapter defaults", async () => {
		const database = await openNodeSqliteDatabase(await tempFile("custom.sqlite"), {
			busyTimeoutMs: 250,
			walAutoCheckpointPages: 64,
		});
		const health = await database.health();
		expect(health.busyTimeoutMs).toBe(250);
		expect(health.walAutoCheckpointPages).toBe(64);
		await database.close();
	});
});

describe("default storage location", () => {
	it("opens with the default project, writes, and reads its own row back", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-default-"));
		directories.push(directory);
		const previous = process.env.TIANGONG_DATA_DIR;
		process.env.TIANGONG_DATA_DIR = join(directory, "data");
		try {
			const storage = await openDefaultSqliteStorage();
			try {
				expect(storage.project).toBe(DEFAULT_PROJECT_ID);
				await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
				expect(await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toBeDefined();
			} finally {
				await storage.close(BACKGROUND_CONTEXT);
			}
		} finally {
			if (previous === undefined) delete process.env.TIANGONG_DATA_DIR;
			else process.env.TIANGONG_DATA_DIR = previous;
		}
	});
});

describe("project isolation", () => {
	it("does not see another project's conversations in the same file", async () => {
		const path = await tempFile("isolation.sqlite");

		const alpha = await openNodeSqliteStorage(path, { project: "alpha" });
		const id = await alpha.mintId<ConversationId>();
		await alpha.commit([{ type: "conversation", value: { id } }], BACKGROUND_CONTEXT);
		await alpha.close(BACKGROUND_CONTEXT);

		const beta = await openNodeSqliteStorage(path, { project: "beta" });
		try {
			expect(await beta.conversation(id, BACKGROUND_CONTEXT)).toBeUndefined();
			const page = await beta.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
			expect(page.items).toEqual([]);
			expect(page.next).toBeUndefined();
		} finally {
			await beta.close(BACKGROUND_CONTEXT);
		}
	});

	it("returns only the requesting project's entries", async () => {
		const path = await tempFile("entry-isolation.sqlite");
		const alpha = await openNodeSqliteStorage(path, { project: "alpha" });
		await alpha.commit(
			[
				{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
				{
					type: "entry",
					value: { id: idFromNumber<EntryId>(2), conversationId: ROOT_CONVERSATION_ID, kind: "cached" },
				},
			],
			BACKGROUND_CONTEXT,
		);
		await alpha.close(BACKGROUND_CONTEXT);

		const beta = await openNodeSqliteStorage(path, { project: "beta" });
		try {
			const conversations = await beta.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
			expect(conversations.items).toEqual([]);
			// A global lookup sees no row, because every row belongs to another project.
			expect(await beta.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT)).toBeUndefined();
			// A conversation-scoped scan fails on an invisible conversation rather than returning empty.
			await expect(
				beta.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, BACKGROUND_CONTEXT),
			).rejects.toThrow(/Unknown conversation/);
		} finally {
			await beta.close(BACKGROUND_CONTEXT);
		}
	});

	it("sees rows written under the same project id", async () => {
		const path = await tempFile("same-project.sqlite");
		const first = await openNodeSqliteStorage(path, { project: "shared" });
		const id = await first.mintId<ConversationId>();
		await first.commit([{ type: "conversation", value: { id } }], BACKGROUND_CONTEXT);
		await first.close(BACKGROUND_CONTEXT);

		const second = await openNodeSqliteStorage(path, { project: "shared" });
		try {
			expect(await second.conversation(id, BACKGROUND_CONTEXT)).toBeDefined();
		} finally {
			await second.close(BACKGROUND_CONTEXT);
		}
	});

	it("rejects an empty project id", async () => {
		const database = await openNodeSqliteDatabase(await tempFile("empty-project.sqlite"));
		await expect(SqliteStorage.open(database, { project: "" })).rejects.toThrow(/must not be empty/);
	});
});

describe("version 2 migration", () => {
	it("keeps the schema history contiguous and ordered", () => {
		expect(SQLITE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3]);
		expect(CURRENT_SQLITE_SCHEMA_VERSION).toBe(3);
	});

	it("assigns rows written before isolation to the default project", async () => {
		const path = await tempFile("pre-v2.sqlite");

		// Seed a version-1 database, then reopen it so the pending migrations run.
		const database = await openNodeSqliteDatabase(path);
		await applySqliteMigrations(database, SQLITE_MIGRATIONS.slice(0, 1));
		const seeded = await SqliteStorage.open(database);
		await seeded.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
		await seeded.close(BACKGROUND_CONTEXT);

		const migrated = await openNodeSqliteStorage(path);
		try {
			const facade = await openNodeSqliteDatabase(path);
			const health = await facade.health();
			expect(health.schemaVersion).toBe(CURRENT_SQLITE_SCHEMA_VERSION);
			await facade.close();
			expect(await migrated.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toBeDefined();
		} finally {
			await migrated.close(BACKGROUND_CONTEXT);
		}
	});
});
