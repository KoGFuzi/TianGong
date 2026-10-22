import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// The package entry as a runtime object: the export-surface assertions below check what a consumer
// can actually import, not what a comment claims.
import * as publicApi from "../src/index.ts";

/**
 * Batch 1c recorded "one text-matching surface" as a convention; batch 1d makes it mechanical. These
 * tests read the source files as text and assert the import graph, because the rule is about which
 * module may hold which raw primitive, and no type system forbids a re-export or a helper that walks
 * `arguments` itself.
 */

const SRC = new URL("../src/", import.meta.url);

/** The file that owns the extraction: it reads `arguments` because that is its job. */
const EXTRACTION_MODULE = "command-text.ts";

/**
 * The only three files in src permitted to hold a `.arguments` read, each pinned to its exact
 * declared line below — batch 2a tightened the open whitelist of batch 1d into 显式申报 + 逐行钉死:
 *  - `command-text.ts` — `extractCommandSurface`, the single tree traversal that feeds both views.
 *  - `types.ts` — `toTgSecRequest`, the ingress that moves the tree onto the request. The ingress
 *    is not a matching face: it compares nothing and returns the tree unchanged to the chain.
 *  - `guard.ts` — `digestArguments`, a sha256 over the canonical JSON for the audit span. A digest
 *    is not a text-matching surface either: no rule ever inspects the strings, so nothing can be
 *    matched against, and widening it would not widen any permission.
 * A second `.arguments` read added to any of the three for matching purposes fails the
 * line-for-line pin below even though the file is whitelisted.
 */
const DECLARED_ARGUMENT_READS: Readonly<Record<string, readonly string[]>> = {
	[EXTRACTION_MODULE]: ['collectValues(request.arguments ?? {}, "command-text", collected);'],
	// The pinned line itself contains a template placeholder and backticks, so the placeholder is escaped
	// inside a template literal: the value stays byte-identical to the source line it pins.
	"types.ts": [`return { toolName: call.name, resource: \`tool:\${call.name}\`, arguments: call.arguments };`],
	"guard.ts": ['return createHash("sha256").update(canonicalJson(request.arguments)).digest("hex").slice(0, 16);'],
};

/**
 * Lines that read `.arguments` off an object, trimmed. Comments do not execute, but the scanner is
 * line-based and counts a comment that writes the property access too — deliberately, so a sanctioned
 * read can never hide in or next to prose. The pattern is narrow (a property access, not the word).
 */
function argumentReadLines(source: string): string[] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /\.\s*arguments\b/.test(line));
}

/** The names a file imports from `./command-text.ts`, from the import statement itself. */
function commandTextImports(source: string): string[] {
	const names: string[] = [];
	const statement = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"\.\/command-text\.ts"/g;
	for (const match of source.matchAll(statement)) {
		for (const part of match[1].split(",")) {
			const name = part
				.trim()
				.replace(/\btype\s+/g, "")
				.split(/\s+as\s+/)[0]!
				.trim();
			if (name !== "") names.push(name);
		}
	}
	return names;
}

async function sourceOf(name: string): Promise<string> {
	return readFile(new URL(name, SRC), "utf8");
}

async function sourceNames(): Promise<string[]> {
	const entries = await readdir(SRC, { withFileTypes: true });
	return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts")).map((entry) => entry.name);
}

describe("single text-matching surface: the package entry", () => {
	// The narrowing batch 1d was asked for: handing out the surface primitives would let any consumer
	// skip the parameter-name filter and rebuild a second matching face outside the audit trail.
	it("does not export the raw surface primitives", () => {
		const exported = Object.keys(publicApi);
		for (const forbidden of ["extractCommandSurface", "connectionTargetsFromSurface", "tokenize"]) {
			expect(exported, forbidden).not.toContain(forbidden);
		}
	});

	it("does not export the batch 2a text-scan view or the built-in danger table", () => {
		// Batch 2a's shape decision: views are package-internal, and the rule set is not
		// host-configurable. A consumer holding `scanTextSurface` could rebuild a matching face
		// outside the audit trail; a consumer holding the table could decide the guardrail was off.
		const exported = Object.keys(publicApi);
		for (const forbidden of ["scanTextSurface", "TG_SEC_DANGER_RULES", "TG_SEC_SUBCOMMAND_DEPTH_LIMIT"]) {
			expect(exported, forbidden).not.toContain(forbidden);
		}
	});

	it("does not export the superseded helpers and their supporting vocabulary", () => {
		const exported = Object.keys(publicApi);
		for (const forbidden of ["createInMemoryScopeRegistry"]) {
			expect(exported, forbidden).not.toContain(forbidden);
		}
	});

	it("exports the single extraction entry, the registry engine, and the danger evaluator factory", () => {
		const exported = Object.keys(publicApi);
		expect(exported).toContain("extractConnectionTargets");
		expect(exported).toContain("createTgSecScopeRegistry");
		expect(exported).toContain("createTgSecDangerEvaluator");
		expect(exported).toContain("TG_SEC_OBJECTIVES");
	});
});

describe("single text-matching surface: the scope path", () => {
	it("the engine imports nothing from the extraction module", async () => {
		// `scope-registry.ts` consumes host strings, full stop. If it ever reaches into command-text,
		// the registry has grown its own parse of the arguments and there are two surfaces again.
		const source = await sourceOf("scope-registry.ts");
		expect(commandTextImports(source)).toEqual([]);
		expect(source).not.toContain("./command-text.ts");
	});

	it("the engine never sees a request at all", async () => {
		const source = await sourceOf("scope-registry.ts");
		expect(source).not.toMatch(/\bTgSecRequest\b/);
		expect(argumentReadLines(source)).toEqual([]);
	});

	it("the resolver takes exactly one name from the extraction module", async () => {
		const source = await sourceOf("scope.ts");
		// `extractConnectionTargets` and nothing else: the resolver reads the filtered candidates,
		// not the values or streams the self-destruction face matches on.
		expect(commandTextImports(source)).toEqual(["extractConnectionTargets"]);
		expect(argumentReadLines(source)).toEqual([]);
	});
});

describe("single text-matching surface: the whole src directory", () => {
	it("no src file outside the extraction and its two declared readers reads `.arguments`", async () => {
		const names = await sourceNames();
		expect(names).toContain(EXTRACTION_MODULE);
		for (const name of names) {
			if (name in DECLARED_ARGUMENT_READS) continue;
			const hits = argumentReadLines(await sourceOf(name));
			expect(hits, `${name} must not read .arguments`).toEqual([]);
		}
	});

	it("the declared readers stay at exactly their sanctioned lines, pinned verbatim", async () => {
		// The batch 2a tightening: not a count but the literal line. A rewritten ingress or digest
		// has to be re-declared here, in review, before it can pass — a second read smuggled into the
		// same file, or a matching comparison added to the digest line, fails on the spot.
		for (const [name, declared] of Object.entries(DECLARED_ARGUMENT_READS)) {
			expect(argumentReadLines(await sourceOf(name)), name).toEqual([...declared]);
		}
	});
});

describe("single text-matching surface: the matcher modules", () => {
	/** Names a matcher module may import from the extraction module: finished views and shape helpers. */
	const VIEW_NAMES = ["extractConnectionTargets", "scanTextSurface", "hasForcedRecursiveFlags", "nonFlagTargets"];
	const TYPE_ONLY_NAMES = ["TgSecCommandGroup", "TgSecConnectionTarget", "TgSecTextSurface"];
	const RAW_PRIMITIVES = ["extractCommandSurface", "connectionTargetsFromSurface", "tokenize", "TgSecTargetStream"];

	it("hard-deny takes the two views and the shape helpers, never the raw primitives", async () => {
		const imported = commandTextImports(await sourceOf("hard-deny.ts"));
		for (const name of imported) expect([...VIEW_NAMES, ...TYPE_ONLY_NAMES], name).toContain(name);
		for (const forbidden of RAW_PRIMITIVES) expect(imported, forbidden).not.toContain(forbidden);
		// Both views, because hard deny genuinely reads both faces: targets for self-protection,
		// text and commands for self-destruction. `danger.ts` below is the sharper half of the split.
		expect(imported).toContain("extractConnectionTargets");
		expect(imported).toContain("scanTextSurface");
	});

	it("danger takes only the text-scan view: a danger rule never matches a host", async () => {
		const imported = commandTextImports(await sourceOf("danger.ts"));
		for (const name of imported)
			expect(
				["scanTextSurface", "hasForcedRecursiveFlags", "nonFlagTargets", "TgSecCommandGroup", "TgSecTextSurface"],
				name,
			).toContain(name);
		// The connection-target view is deliberately absent: if the danger set could read it, the
		// batch 1c parameter-name filter would be one import away from being merged away.
		for (const forbidden of [...RAW_PRIMITIVES, "extractConnectionTargets"])
			expect(imported, forbidden).not.toContain(forbidden);
	});
});

describe("single text-matching surface: the batch 2b judge and rules table", () => {
	it("the judge imports exactly the two finished views, and nothing else reaches it", async () => {
		// The pin is an exact equality, not a membership check: adding a third name — a raw primitive
		// or a helper that re-walks the tree — fails on the spot, and so does removing one the judge
		// no longer needs (a deleted import is how a view quietly stops being watched).
		const source = await sourceOf("judge.ts");
		expect(commandTextImports(source)).toEqual(["extractConnectionTargets", "scanTextSurface"]);
		for (const forbidden of [
			"extractCommandSurface",
			"connectionTargetsFromSurface",
			"tokenize",
			"TgSecTargetStream",
		])
			expect(source, forbidden).not.toContain(forbidden);
		expect(argumentReadLines(source)).toEqual([]);
	});

	it("the rules table reads only the resource string: no extraction import, no request, no arguments", async () => {
		// The table matches on `tool:<name>` and nothing else. If it ever imported a text view, the
		// parameter-level non-goal would be one import away from being silently reversed.
		const source = await sourceOf("rules.ts");
		expect(commandTextImports(source)).toEqual([]);
		expect(source).not.toContain("./command-text.ts");
		expect(source).not.toMatch(/\bTgSecRequest\b/);
		expect(argumentReadLines(source)).toEqual([]);
	});

	it("the package entry exports the rule table seam and the two-axis judge", () => {
		// These are consumer-facing seams by design (the host loads its rules and wires its transport),
		// so their absence is a regression just as their forbidden counterparts would be.
		const exported = Object.keys(publicApi);
		for (const required of [
			"createTgSecRuleTable",
			"parseTgSecRules",
			"loadTgSecRules",
			"createTgSecTwoAxisJudge",
			"probeRuleDenyForcesAskPastExemptions",
			"probeStrictIgnoresRuleAllow",
			"probeJudgeTransportErrorAsks",
			"probeJudgeTimeoutAsks",
		]) {
			expect(exported, required).toContain(required);
		}
	});

	it("flags a judge that grew its own argument scan", () => {
		// Meta-case, same shape as the batch 2a ones: the exact-equality pin above breaks on either
		// of these lines, so a green run means the judge really holds only the two views.
		expect(commandTextImports('import { extractCommandSurface } from "./command-text.ts";')).toContain(
			"extractCommandSurface",
		);
		expect(argumentReadLines("return JSON.stringify(request.arguments);")).not.toEqual([]);
	});
});

describe("the checker itself fires", () => {
	// A guard test that cannot fail is decoration. These cases run the same helpers used above against
	// deliberate bypass sources, so the mechanism is proven red without editing the real files. The
	// batch report additionally records the manual red run against a real bypass added to scope.ts,
	// observed failing, then removed.
	it("flags a resolver that scans the argument tree directly", () => {
		const bypass =
			"export function createTgSecScopeResolver(registry: TgSecScopeRegistry): TgSecScopeResolver {\n" +
			"\treturn (request: TgSecRequest) => ({ inScope: registry.contains(JSON.stringify(request.arguments)) });\n" +
			"}";
		expect(argumentReadLines(bypass)).not.toEqual([]);
	});

	it("flags a consumer that re-tokenizes instead of calling the extraction", () => {
		const bypass = 'import { extractCommandSurface } from "./command-text.ts";';
		// The scope-path assertion above demands `[]` from the engine and exactly
		// `["extractConnectionTargets"]` from the resolver; either of these imports breaks it.
		expect(commandTextImports(bypass)).toEqual(["extractCommandSurface"]);
	});

	it("flags a danger implementation that scans the raw tree instead of the text-scan view", () => {
		// The batch 2a red demonstration in the report adds this exact line to `danger.ts` and watches
		// the pin above fail on it; here the same shape proves the helpers fire without editing src.
		const bypass =
			"export function createTgSecDangerEvaluator(options: { objective: TgSecObjective }): TgSecDangerEvaluator {\n" +
			'\treturn (request) => ({ hit: JSON.stringify(request.arguments).toLowerCase().includes("drop table") });\n' +
			"}";
		expect(argumentReadLines(bypass)).not.toEqual([]);
	});

	it("flags an engine that grew its own request handling", () => {
		const bypass =
			'import type { TgSecRequest } from "./types.ts";\nexport function pick(request: TgSecRequest): string {\n\treturn request.toolName;\n}';
		expect(bypass).toMatch(/\bTgSecRequest\b/);
	});
});
