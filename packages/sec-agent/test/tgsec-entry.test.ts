import { openNodeSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, context } from "./support.ts";

afterEach(cleanupTempDirs);

const ENTRY = join(import.meta.dirname, "../src/tui/main.ts");
const SMOKE = join(import.meta.dirname, "../src/cli/main.ts");

type EntryDirectory = {
	readonly db: string;
	readonly evidence: string;
	readonly directory: string;
};

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function entryDirectory(prefix: string): Promise<EntryDirectory> {
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

/** Run one entry as its own process without a TTY, exactly like a piped invocation would. */
function runEntry(args: readonly string[]): CliResult {
	const result = spawnSync(process.execPath, [ENTRY, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function runSmoke(args: readonly string[]): CliResult {
	const result = spawnSync(process.execPath, [SMOKE, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

const entryArgs = (directory: EntryDirectory, project: string, extra: readonly string[] = []): readonly string[] => [
	"--project",
	project,
	"--db",
	directory.db,
	"--evidence",
	directory.evidence,
	...extra,
];

async function conversationCount(directory: EntryDirectory, project: string): Promise<number> {
	const storage = await openNodeSqliteStorage(directory.db, { project });
	try {
		return (await storage.scanConversations({}, 100, undefined, context)).items.length;
	} finally {
		await storage.close(context);
	}
}

describe("tgsec entry convergence", () => {
	it("documents both frontends and the history flags in --help", () => {
		const helped = runEntry(["--help"]);
		expect(helped.status, helped.stderr).toBe(0);
		expect(helped.stdout).toContain("open the interactive campaign shell (default)");
		expect(helped.stdout).toContain("open the campaign WebUI sidecar instead");
		for (const flag of ["--webui", "--history", "--session", "--continue", "--host", "--port", "--target"]) {
			expect(helped.stdout).toContain(flag);
		}
	});

	it("prints the history table without a TTY, before any frontend opens", async () => {
		const directory = await entryDirectory("tgsec-entry-e1");
		const listed = runEntry(entryArgs(directory, "e1", ["--history"]));
		// stdin is "ignore", so this only passes when --history dispatches before the TTY gate.
		expect(listed.status, listed.stderr).toBe(0);
		expect(listed.stdout).toContain('no history in project "e1"');
	});

	it("prints a seeded project's history with and without --webui", async () => {
		const directory = await entryDirectory("tgsec-entry-e2");
		const seeded = runSmoke(entryArgs(directory, "e2", ["--input", "x"]));
		expect(seeded.status, seeded.stderr).toBe(0);

		const listed = runEntry(entryArgs(directory, "e2", ["--history"]));
		expect(listed.status, listed.stderr).toBe(0);
		expect(listed.stdout).toMatch(/^1 {2}/m);

		const webuiListed = runEntry(entryArgs(directory, "e2", ["--webui", "--history"]));
		expect(webuiListed.status, webuiListed.stderr).toBe(0);
		expect(webuiListed.stdout).toMatch(/^1 {2}/m);
	});

	it("fails the webui frontend on an absent session before the server starts", async () => {
		const directory = await entryDirectory("tgsec-entry-e3");
		const seeded = runSmoke(entryArgs(directory, "e3", ["--input", "x"]));
		expect(seeded.status, seeded.stderr).toBe(0);

		const absent = runEntry(entryArgs(directory, "e3", ["--webui", "--faux", "--session", "999"]));
		expect(absent.status, absent.stderr).not.toBe(0);
		expect(absent.stderr).toContain("Conversation 999");
		expect(absent.stderr).toContain(directory.db);
	});

	// Ten spawned processes; each pays a full node start, so the default 5s is not enough.
	it("rejects the documented conflict combinations", () => {
		const cases: readonly (readonly [readonly string[], string])[] = [
			[["--history", "--session", "1"], "--history cannot be combined with --session"],
			[["--history", "--continue"], "--history cannot be combined with --continue"],
			[["--history", "--faux"], "--history cannot be combined with --faux"],
			[["--session", "1", "--continue"], "--session cannot be combined with --continue"],
			[["--faux", "--model", "x/y"], "--faux cannot be combined with --model"],
			[["--session", "abc"], "--session must be a positive integer"],
			[["--host", "127.0.0.1"], "--host needs --webui"],
			[["--port", "8080"], "--port needs --webui"],
			[["--target", "demo"], "--target needs --webui"],
			[["--webui", "--port", "99999"], "--port must be an integer in 0..65535"],
		];
		for (const [args, message] of cases) {
			const rejected = runEntry(args);
			expect(rejected.status, `${args.join(" ")}: ${rejected.stderr}`).not.toBe(0);
			expect(rejected.stderr).toContain(message);
		}
	}, 30_000);

	it("keeps the TTY gate ahead of the shell and its fork, so a piped invocation writes nothing", async () => {
		const directory = await entryDirectory("tgsec-entry-e4");
		const seeded = runSmoke(entryArgs(directory, "e4", ["--input", "x"]));
		expect(seeded.status, seeded.stderr).toBe(0);

		const piped = runEntry(entryArgs(directory, "e4", ["--faux", "--session", "1"]));
		expect(piped.status, piped.stderr).not.toBe(0);
		expect(piped.stderr).toContain("needs an interactive terminal");
		// The requested fork never happened: the source is still the only conversation.
		expect(await conversationCount(directory, "e4")).toBe(1);
	});

	it("redirects the removed tg-sec serve subcommand to tgsec --webui", () => {
		const moved = runSmoke(["serve"]);
		expect(moved.status, moved.stderr).not.toBe(0);
		expect(moved.stderr).toContain('serve moved to "tgsec --webui"');
	});
});
