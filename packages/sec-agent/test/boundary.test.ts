import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Batch 3 is the first place a *new* dependency edge can be recorded as a false claim, so the edge
 * set is asserted from the two files that actually decide it — the manifest and the import graph —
 * not from a comment. The set sec-agent depends on is the six house packages a campaign runtime
 * needs plus the two sanctioned non-house entries: gibraltar's vendored codemode, reached through
 * gibraltar's own `./codemode` subpath, and `@earendil-works/pi-codemode` itself (AGENTS.md: house
 * packages import vendored packages by their upstream name). `tg-env` is deliberately absent: the
 * env resolver is typed by gibraltar (`env/node`, `EnvTarget`), so accepting a host-built remote env
 * costs sec-agent no edge on the env package. `tg-tui` is the interactive shell the `tgsec` bin
 * renders; it is a leaf dependency, never the reverse.
 */

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageDirectory, "src");
const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/gu;

/** The house packages a campaign runtime is allowed to depend on — the edge set, exactly. */
const ALLOWED_WORKSPACE = [
	"@OnePanda-TgSec/chord",
	"@OnePanda-TgSec/tg-ai",
	"@OnePanda-TgSec/tg-gibraltar",
	"@OnePanda-TgSec/tg-sec-guard",
	"@OnePanda-TgSec/tg-telemetry",
	"@OnePanda-TgSec/tg-tui",
];

/** Collapse a scope specifier to its package root so a subpath import counts once. */
function workspaceRoot(specifier: string): string {
	const segments = specifier.split("/");
	return segments.slice(0, 2).join("/");
}

async function sourceFiles(): Promise<string[]> {
	const entries = await readdir(sourceDirectory, { recursive: true });
	return entries.filter((entry) => typeof entry === "string" && entry.endsWith(".ts")).map((entry) => entry as string);
}

/** Every import/export specifier in every src file, paired with the file it came from. */
async function specifiers(): Promise<readonly { readonly file: string; readonly specifier: string }[]> {
	const found: { file: string; specifier: string }[] = [];
	for (const path of await sourceFiles()) {
		const source = await readFile(resolve(sourceDirectory, path), "utf8");
		for (const match of source.matchAll(IMPORT_SPECIFIER)) found.push({ file: path, specifier: match[1]! });
	}
	return found;
}

describe("sec-agent package boundary", () => {
	test("declares exactly the six house dependencies and nothing else under the scope", async () => {
		const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		const declared = Object.keys(manifest.dependencies ?? {})
			.filter((name) => name.startsWith("@OnePanda-TgSec/"))
			.sort();
		expect(declared).toEqual([...ALLOWED_WORKSPACE].sort());
	});

	test("imports no house package outside the declared edge set", async () => {
		const roots = new Set<string>();
		for (const { specifier } of await specifiers()) {
			if (!specifier.startsWith("@OnePanda-TgSec/")) continue;
			const root = workspaceRoot(specifier);
			roots.add(root);
			expect(ALLOWED_WORKSPACE, `${root} is not an allowed house edge`).toContain(root);
		}
		// Every declared package is actually imported: a declared-but-unused edge is the same fiction.
		expect([...roots].sort()).toEqual([...ALLOWED_WORKSPACE].sort());
	});

	test("keeps mcp and the env package out of the graph", async () => {
		const forbidden = [
			"@OnePanda-TgSec/tg-env",
			"@OnePanda-TgSec/tg-mcp",
			"@OnePanda-TgSec/tg-codemode",
			"@earendil-works/pi-mcp",
		];
		for (const { file, specifier } of await specifiers()) {
			for (const name of forbidden) expect(specifier, `${file} must not depend on ${name}`).not.toContain(name);
		}
	});

	test("builds only on the SQLite backend — MemoryStorage never enters the graph", async () => {
		for (const { file, specifier } of await specifiers()) {
			expect(specifier, `${file} must not import an in-memory storage`).not.toMatch(/storage\/memory/);
		}
	});

	test("never imports the read-only legacy snapshot", async () => {
		for (const { file, specifier } of await specifiers())
			expect(specifier, `${file} must not import scripts/legacy`).not.toContain("scripts/legacy");
	});

	test("has no second file format: no JSONL writer reaches the filesystem", async () => {
		const offenders: string[] = [];
		for (const path of await sourceFiles()) {
			const source = await readFile(resolve(sourceDirectory, path), "utf8");
			if (source.includes(".jsonl")) offenders.push(`${path}: .jsonl`);
			if (/\bappendFile\s*\(/.test(source)) offenders.push(`${path}: appendFile(`);
		}
		expect(offenders).toEqual([]);
	});

	test("provisions no redis backend this batch — nothing reaches a redis client", async () => {
		const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		for (const name of Object.keys(manifest.dependencies ?? {})) {
			expect(name, `${name} must not be a redis dependency`).not.toMatch(/redis/i);
		}
		for (const { file, specifier } of await specifiers()) {
			expect(specifier, `${file} must not import a redis client`).not.toMatch(/(^|[/.-])redis($|[/.-])/i);
		}
	});

	test("stores no JSON in the evidence layer — the snapshot preimage is byte-encoded", async () => {
		const offenders: string[] = [];
		for (const path of await sourceFiles()) {
			// `readdir` joins recursive results with the platform separator; normalize before matching.
			if (!path.split(sep).join("/").startsWith("evidence/")) continue;
			const source = await readFile(resolve(sourceDirectory, path), "utf8");
			if (source.includes("JSON.stringify")) offenders.push(`${path}: JSON.stringify`);
			if (source.includes("JSON.parse")) offenders.push(`${path}: JSON.parse`);
		}
		expect(offenders).toEqual([]);
	});

	test("the tool surface reaches the wire only through node:http(s), never fs, net, or process primitives", async () => {
		const allowedBuiltins = ["node:http", "node:https"];
		const forbiddenBuiltins = [
			"node:fs",
			"node:net",
			"node:child_process",
			"node:dns",
			"node:tls",
			"node:worker_threads",
		];
		for (const { file, specifier } of await specifiers()) {
			if (!file.split(sep).join("/").startsWith("tools/")) continue;
			for (const banned of forbiddenBuiltins)
				expect(specifier, `${file} must not import ${banned}`).not.toContain(banned);
			if (specifier.startsWith("node:"))
				expect(allowedBuiltins, `${file} may import only node:http(s) from the tool surface`).toContain(specifier);
		}
	});

	test("relative imports stay inside src", async () => {
		const offenders: string[] = [];
		for (const { file, specifier } of await specifiers()) {
			if (!specifier.startsWith(".")) continue;
			const target = resolve(dirname(resolve(sourceDirectory, file)), specifier);
			if (!target.startsWith(sourceDirectory + sep)) offenders.push(`${file}: ${specifier} escapes src`);
		}
		expect(offenders).toEqual([]);
	});
});
