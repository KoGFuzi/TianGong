import { createTempDirectory, fileExists, joinPath, removeDirectoryTree } from "../src/sqlite/bunfs.ts";
import { describe, expect, it } from "bun:test";
import { createBunSqliteFactory } from "../src/index.ts";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await createTempDirectory("tg-sqlite-adapter-");
	try {
		return await run(directory);
	} finally {
		await removeDirectoryTree(directory);
	}
}

describe("bun:sqlite adapter", () => {
	it("does not create files for existing or read-only opens", async () => {
		await withTempDir(async (directory) => {
			const path = joinPath(directory, "missing % #.sqlite");
			const factory = createBunSqliteFactory();

			await expect(factory.openExisting(path)).rejects.toThrow();
			expect(await fileExists(path)).toBe(false);
			await expect(factory.openReadOnly(path)).rejects.toThrow();
			expect(await fileExists(path)).toBe(false);
		});
	});

	it("opens an existing database read-write or read-only without changing its mode", async () => {
		await withTempDir(async (directory) => {
			const path = joinPath(directory, "existing % #.sqlite");
			const factory = createBunSqliteFactory();
			const created = await factory.open(path);
			created.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			created.close();

			const writable = await factory.openExisting(path);
			writable.exec("INSERT INTO values_table (value) VALUES (1)");
			writable.close();
			const readOnly = await factory.openReadOnly(path);
			try {
				expect(readOnly.prepare("SELECT value FROM values_table").all()).toEqual([{ value: 1 }]);
				expect(() => readOnly.exec("INSERT INTO values_table (value) VALUES (2)")).toThrow();
			} finally {
				readOnly.close();
			}
		});
	});

	it("commits a synchronous transaction and returns its result", async () => {
		const db = await createBunSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			const result = db.transaction(() => {
				db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
				return "committed";
			});

			expect(result).toBe("committed");
			expect(db.prepare("SELECT value FROM values_table").get()).toEqual({ value: 42 });
		} finally {
			db.close();
		}
	});

	it("forwards positional and named statement parameters", async () => {
		const db = await createBunSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			expect(db.prepare("INSERT INTO values_table (value) VALUES (?)").run("positional")).toEqual({
				changes: 1,
				lastInsertRowid: 1,
			});
			// bun:sqlite binds named parameters by their prefixed key ($name, :name, @name),
			// so the statement placeholder and the object key must share the prefix character.
			expect(db.prepare("INSERT INTO values_table (value) VALUES ($value)").run({ $value: "named" })).toEqual({
				changes: 1,
				lastInsertRowid: 2,
			});
			expect(db.prepare("SELECT value FROM values_table WHERE id = ?").get(1)).toEqual({ value: "positional" });
			expect(db.prepare("SELECT value FROM values_table WHERE id >= $id ORDER BY id").all({ $id: 2 })).toEqual([
				{ value: "named" },
			]);
		} finally {
			db.close();
		}
	});

	it("rejects asynchronous transaction callbacks", async () => {
		const db = await createBunSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			const asynchronous = async () => {
				db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
				await Promise.resolve();
			};
			expect(() => db.transaction(asynchronous)).toThrow("SQLite transaction callbacks must be synchronous");
			await Promise.resolve();
			expect(db.prepare("SELECT value FROM values_table").all()).toEqual([]);
		} finally {
			db.close();
		}
	});
});
