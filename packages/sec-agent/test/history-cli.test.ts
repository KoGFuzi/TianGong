import type { ConversationId } from "@OnePanda-TgSec/tg-gibraltar";
import type { SqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite";
import { openNodeSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, context } from "./support.ts";

afterEach(cleanupTempDirs);

const CLI = join(import.meta.dirname, "../src/cli/main.ts");

type HistoryDirectory = {
	readonly db: string;
	readonly evidence: string;
	readonly directory: string;
};

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function historyDirectory(prefix: string): Promise<HistoryDirectory> {
	const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
	directories.add(directory);
	return {
		directory,
		db: join(directory, "session.sqlite"),
		evidence: join(directory, "evidence"),
	};
}

type CliResult = {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
};

/** Run the `tg-sec` smoke entry as its own process, exactly like an operator would. */
function runCli(args: readonly string[]): CliResult {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

const smokeArgs = (directory: HistoryDirectory, project: string, extra: readonly string[] = []): readonly string[] => [
	"--project",
	project,
	"--db",
	directory.db,
	"--evidence",
	directory.evidence,
	...extra,
];

async function withStorage<T>(
	directory: HistoryDirectory,
	project: string,
	run: (storage: SqliteStorage) => Promise<T>,
): Promise<T> {
	const storage = await openNodeSqliteStorage(directory.db, { project });
	try {
		return await run(storage);
	} finally {
		await storage.close(context);
	}
}

/** Conversation IDs in ID order; the first is always the reserved root. */
async function conversationIds(directory: HistoryDirectory, project: string): Promise<readonly ConversationId[]> {
	return withStorage(directory, project, async (storage) =>
		(await storage.scanConversations({}, 100, undefined, context)).items.map(({ id }) => id),
	);
}

const entryIds = (storage: SqliteStorage, id: ConversationId) =>
	storage.scanEntries({ conversationId: id }, 100, undefined, context).then((page) => page.items.map(({ id }) => id));

describe("tg-sec history CLI", () => {
	it("keeps the flagless smoke writing the reserved root conversation", async () => {
		const directory = await historyDirectory("tg-sec-history-h1");
		const first = runCli(smokeArgs(directory, "h1", ["--input", "x"]));
		expect(first.stderr).toBe("");
		const second = runCli(smokeArgs(directory, "h1", ["--input", "x"]));
		expect(second.stderr).toBe("");
		// The reserved root is reused on the second run, not duplicated.
		expect(await conversationIds(directory, "h1")).toHaveLength(1);
	});

	it("prints the history table without writing a conversation", async () => {
		const directory = await historyDirectory("tg-sec-history-h2");
		const seeded = runCli(smokeArgs(directory, "h2", ["--input", "x"]));
		expect(seeded.status, seeded.stderr).toBe(0);
		const listed = runCli(smokeArgs(directory, "h2", ["--history"]));
		expect(listed.status, listed.stderr).toBe(0);
		expect(listed.stdout).toContain("id");
		expect(listed.stdout).toContain("lane");
		expect(listed.stdout).toContain("created");
		expect(listed.stdout).toContain("title");
		expect(listed.stdout).toMatch(/^1 {2}/m);
		// Listing is read-only: no conversation and no model turn is added.
		expect(await conversationIds(directory, "h2")).toHaveLength(1);
	});

	it("forks the newest root conversation on --continue and leaves the source untouched", async () => {
		const directory = await historyDirectory("tg-sec-history-h3");
		expect(runCli(smokeArgs(directory, "h3", ["--input", "x"])).status).toBe(0);
		const ids = await conversationIds(directory, "h3");
		const rootId = ids[0]!;
		const rootEntriesBefore = await withStorage(directory, "h3", (storage) => entryIds(storage, rootId));

		const continued = runCli(smokeArgs(directory, "h3", ["--continue", "--input", "y"]));
		expect(continued.stderr).toBe("");
		const after = await conversationIds(directory, "h3");
		expect(after).toHaveLength(2);
		const childId = after[1]!;
		await withStorage(directory, "h3", async (storage) => {
			const child = await storage.conversation(childId, context);
			expect(child?.parent?.conversationId).toBe(rootId);
			expect(rootEntriesBefore).toContain(child?.parent?.at);
			// The fork sees the inherited history plus its own turn, and the source gains nothing.
			const visible = await entryIds(storage, childId);
			expect(visible.length).toBeGreaterThan(rootEntriesBefore.length);
			for (const entryId of rootEntriesBefore) expect(visible).toContain(entryId);
			expect(await entryIds(storage, rootId)).toEqual(rootEntriesBefore);
		});
	});

	it("restores an explicit --session id and rejects the documented conflict combinations", async () => {
		const directory = await historyDirectory("tg-sec-history-h4");
		expect(runCli(smokeArgs(directory, "h4", ["--input", "x"])).status).toBe(0);

		const explicit = runCli(smokeArgs(directory, "h4", ["--session", "1", "--input", "y"]));
		expect(explicit.stderr).toBe("");
		expect(await conversationIds(directory, "h4")).toHaveLength(2);

		const absent = runCli(smokeArgs(directory, "h4", ["--session", "999", "--input", "y"]));
		expect(absent.status, absent.stderr).not.toBe(0);
		expect(absent.stderr).toContain("999");
		expect(absent.stderr).toContain(directory.db);

		const bothSources = runCli(smokeArgs(directory, "h4", ["--session", "1", "--continue", "--input", "y"]));
		expect(bothSources.status, bothSources.stderr).not.toBe(0);
		expect(bothSources.stderr).toContain("--session cannot be combined with --continue");

		const listedAndSelected = runCli(smokeArgs(directory, "h4", ["--history", "--session", "1"]));
		expect(listedAndSelected.status, listedAndSelected.stderr).not.toBe(0);
		expect(listedAndSelected.stderr).toContain("--history cannot be combined with --session");
	});

	it("warns on stderr and follows this run's lane when restoring across lanes", async () => {
		const directory = await historyDirectory("tg-sec-history-h5");
		expect(runCli(smokeArgs(directory, "h5", ["--lane", "redteam", "--input", "x"])).status).toBe(0);

		const crossLane = runCli(smokeArgs(directory, "h5", ["--lane", "ctf", "--session", "1", "--input", "y"]));
		expect(crossLane.status, crossLane.stderr).toBe(0);
		expect(crossLane.stderr).toContain(
			"tg-sec: restoring conversation 1 (lane redteam) into a ctf campaign; guard policy follows ctf",
		);
		const ids = await conversationIds(directory, "h5");
		const childId = ids[1]!;
		await withStorage(directory, "h5", async (storage) => {
			const summary = await storage.conversationSummary(childId, context);
			expect(summary?.meta.lane).toBe("ctf");
			expect(summary?.parent?.conversationId).toBe(1);
		});
	});
});
