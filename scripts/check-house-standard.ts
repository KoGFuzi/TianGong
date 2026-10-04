#!/usr/bin/env bun
/**
 * Enforces the TianGong house standard across the workspace.
 *
 * Three invariants, all of them load-bearing:
 *
 *  1. Every package is either a house package under `@OnePanda-TgSec` or an explicitly
 *     declared vendored TianGong package. Nothing is unclassified.
 *  2. House packages carry our metadata: one scope, one version line, our author, our repo.
 *  3. `@earendil-works/*` may only be reached through the two vendored specifiers, and only
 *     from house packages. Vendored packages never import us.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
	FORMER_SPECIFIERS,
	HOUSE_NAMES,
	HOUSE_SCOPE,
	listPackages,
	repoRoot,
	VENDORED_PACKAGES,
} from "./lib/packages.ts";

const root = repoRoot();
const rootManifest = (await Bun.file(resolve(root, "package.json")).json()) as {
	version?: string;
	author?: string;
	license?: string;
	repository?: { url?: string };
};
const rootVersion = rootManifest.version ?? "0.0.0";
const problems: string[] = [];
const fail = (message: string): void => {
	problems.push(message);
};

const packages = await listPackages(root);
const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

// 1. Classification ---------------------------------------------------------------
for (const pkg of packages) {
	if (pkg.origin === "vendored") continue;
	if (!pkg.name.startsWith(`${HOUSE_SCOPE}/`)) {
		fail(`${pkg.directory}: name "${pkg.name}" must live under ${HOUSE_SCOPE}/`);
	}
	if (!(HOUSE_NAMES as readonly string[]).includes(pkg.name)) {
		fail(`${pkg.directory}: "${pkg.name}" is not a registered house package`);
	}
}
for (const name of Object.keys(VENDORED_PACKAGES)) {
	if (!byName.has(name)) fail(`vendored package "${name}" is declared but missing from packages/`);
}
for (const name of HOUSE_NAMES) {
	if (!byName.has(name)) fail(`house package "${name}" is registered but missing from packages/`);
}

// 2. Metadata ---------------------------------------------------------------------
for (const pkg of packages) {
	if (pkg.origin !== "house") continue;
	if (pkg.version !== rootVersion) {
		fail(`${pkg.directory}: version ${pkg.version} must match the workspace version ${rootVersion}`);
	}
	if (pkg.manifest.author !== rootManifest.author) {
		fail(`${pkg.directory}: author "${String(pkg.manifest.author)}" must be "${String(rootManifest.author)}"`);
	}
	if (pkg.manifest.license !== rootManifest.license) {
		fail(`${pkg.directory}: license "${String(pkg.manifest.license)}" must be "${String(rootManifest.license)}"`);
	}
	const repository = pkg.manifest.repository as { url?: string; directory?: string } | undefined;
	if (repository?.url !== rootManifest.repository?.url) {
		fail(`${pkg.directory}: repository.url must be "${String(rootManifest.repository?.url)}"`);
	}
	if (repository?.directory !== pkg.directory) {
		fail(`${pkg.directory}: repository.directory must be "${pkg.directory}", got "${String(repository?.directory)}"`);
	}
	for (const field of ["README.md", "CHANGELOG.md"] as const) {
		const file = Bun.file(resolve(pkg.path, field));
		if (!(await file.exists())) fail(`${pkg.directory}: missing ${field}`);
	}
}

// Vendored packages must keep the identity they were published with.
for (const [name, record] of Object.entries(VENDORED_PACKAGES)) {
	const pkg = byName.get(name);
	if (!pkg) continue;
	if (pkg.version !== record.version) {
		fail(`${pkg.directory}: vendored version drifted to ${pkg.version}, expected ${record.version}`);
	}
	if (pkg.manifest.author !== record.upstreamAuthor) {
		fail(`${pkg.directory}: vendored author must stay "${record.upstreamAuthor}"`);
	}
	const repository = pkg.manifest.repository as { url?: string; directory?: string } | undefined;
	if (repository?.url !== `git+${record.upstreamRepository}.git`) {
		fail(`${pkg.directory}: vendored repository.url must stay pinned to ${record.upstreamRepository}`);
	}
	if (repository?.directory !== record.upstreamDirectory) {
		fail(`${pkg.directory}: vendored repository.directory must stay "${record.upstreamDirectory}"`);
	}
	if (String(pkg.manifest.description ?? "").includes(HOUSE_SCOPE)) {
		fail(`${pkg.directory}: vendored description must not claim ${HOUSE_SCOPE} authorship`);
	}
}

// 3. Import surfaces --------------------------------------------------------------
const CODE_FILES = /\.(?:ts|tsx|mts|mjs|json|c|h|m|cjs|js)$/;
const DOC_FILES = /\.md$/;
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".artifacts"]);
const SPECIFIER = /["'`](@(?:earendil-works|OnePanda-TgSec)\/[A-Za-z0-9._/-]+)["'`]/g;

async function* walk(directory: string): AsyncGenerator<string> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (IGNORED_DIRECTORIES.has(entry.name) || entry.name === ".git") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (CODE_FILES.test(entry.name) || DOC_FILES.test(entry.name)) yield path;
	}
}

/** `@earendil-works/chord/delta` is the same package as the declared `@earendil-works/chord`. */
const rootSpecifier = (specifier: string): string => {
	const match = /^(@(?:earendil-works|OnePanda-TgSec)\/[A-Za-z0-9._-]+)/.exec(specifier);
	return match ? match[1]! : specifier;
};

const vendoredDirectories = new Set<string>(Object.values(VENDORED_PACKAGES).map((record) => record.directory));

for (const pkg of packages) {
	const vendored = vendoredDirectories.has(pkg.directory);
	for await (const file of walk(pkg.path)) {
		const source = await readFile(file, "utf8");
		const where = relative(root, file);
		const isCode = CODE_FILES.test(file);
		for (const match of source.matchAll(SPECIFIER)) {
			const specifier = match[1]!;
			if (vendored) {
				// Vendored packages are upstream code: they may name their own upstream siblings
				// in prose, but they must never reach into this workspace.
				if (specifier.startsWith(`${HOUSE_SCOPE}/`)) {
					fail(`${where}: vendored package must not import "${specifier}"`);
				}
				continue;
			}
			if (!specifier.startsWith("@earendil-works/")) continue;
			const base = rootSpecifier(specifier);
			if (base in VENDORED_PACKAGES) continue;
			if (!isCode && base in FORMER_SPECIFIERS) continue;
			fail(
				`${where}: "${specifier}" is not a declared vendored package` +
					(isCode ? " (house code may only import @OnePanda-TgSec/* or the two vendored specifiers)" : ""),
			);
		}
	}
}

// 4. Identifier prefixes ----------------------------------------------------------
// Enforced on code only. Documentation is prose, and prose has to be able to name the old
// identifiers: a changelog entry records what a rename replaced, and a provenance section names the
// upstream package. Forbidding that would make the history unwritable. Generated model data is
// excluded because it is produced by `bun run generate:models`, not authored here.
const ALLOWED_REMAINDERS = [
	// Radius is a third-party gateway; its domain, OAuth client id, and header names are not ours.
	{ pattern: /radius\.pi\.dev/g, reason: "third-party Radius gateway domain" },
	{ pattern: /x-pi-gateway-upstream-provider/g, reason: "third-party Radius gateway header" },
	{ pattern: /pi-gateway/g, reason: "third-party Radius OAuth client id" },
	// The native TUI addon and its compiled fixtures keep upstream C macros (out of scope).
	{ pattern: /PI_(?:NAPI|CLIPBOARD)_[A-Z_]*/g, reason: "native addon C macro, matches native/napi.h" },
	// Upstream project identity.
	{ pattern: /earendil-works\/pi/g, reason: "upstream project URL" },
	{ pattern: /pi agent/g, reason: "upstream project name" },
	{ pattern: /pi-mono/g, reason: "upstream repo name" },
	// LaTeX in the tui fixtures.
	{ pattern: /\\pi\b/g, reason: "LaTeX" },
];

const IDENTITY_PATTERNS = [
	{ pattern: /(?<![\\\w])pi\.[a-z][a-z-]*/g, label: "pi.* identifier" },
	{ pattern: /\bPI_[A-Z0-9_]+/g, label: "PI_* environment variable" },
	{ pattern: /\bPi[A-Z][A-Za-z0-9]*/g, label: "Pi* type" },
	{ pattern: /\bpi-[a-z0-9]/g, label: "pi-* slug" },
	{ pattern: /(?<!\\)\bpi\b/g, label: "bare pi" },
];

/**
 * Files where a bare `pi` is data rather than product identity, so the sweep must not touch them:
 *
 *  - `packages/tui/native/`, `packages/tui/test/fixtures/`: compiled by the platform toolchain;
 *    the `PI_NAPI_*` macros must keep matching `native/napi.h`.
 *  - `packages/tui/src/latex.ts`: the LaTeX symbol and function tables, where bare math names
 *    (`pi`, `alpha`, `sum`) are the payload.
 *  - `packages/ai/test/codex-websocket-cached-probe.ts`: a synthetic token-distribution fixture
 *    that enumerates the Greek alphabet.
 */
const FROZEN_CODE_PREFIXES = [
	"packages/tui/native/",
	"packages/tui/test/fixtures/",
	"packages/tui/src/latex.ts",
	"packages/ai/test/codex-websocket-cached-probe.ts",
];

/** Generated by `bun run generate:models`; the provider catalogs embed third-party endpoints. */
const GENERATED_PREFIXES = ["packages/ai/src/providers/data/"];

for (const pkg of packages) {
	if (pkg.origin !== "house") continue;
	for await (const file of walk(pkg.path)) {
		const where = relative(root, file);
		if (!CODE_FILES.test(file)) continue;
		if (FROZEN_CODE_PREFIXES.some((prefix) => where.startsWith(prefix))) continue;
		if (GENERATED_PREFIXES.some((prefix) => where.startsWith(prefix))) continue;
		let source = await readFile(file, "utf8");
		for (const { pattern } of ALLOWED_REMAINDERS) source = source.replace(pattern, " ");
		for (const { pattern, label } of IDENTITY_PATTERNS) {
			for (const match of source.matchAll(pattern)) {
				fail(`${where}: ${label} "${match[0]}" must use the TianGong prefix (tg/TG/TianGong)`);
			}
		}
	}
}

// Cross-package dependency declarations must use workspace names.
for (const pkg of packages) {
	if (pkg.origin !== "house") continue;
	const manifest = pkg.manifest as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	for (const [field, deps] of Object.entries({
		dependencies: manifest.dependencies,
		devDependencies: manifest.devDependencies,
	})) {
		for (const [dep, range] of Object.entries(deps ?? {})) {
			if (!dep.startsWith("@earendil-works/") && !dep.startsWith(`${HOUSE_SCOPE}/`)) continue;
			const target = byName.get(dep);
			if (!target) {
				fail(`${pkg.directory}: ${field}.${dep} does not resolve to a workspace package`);
				continue;
			}
			if (target.origin === "vendored" && !range.startsWith("^")) {
				fail(`${pkg.directory}: ${field}.${dep} must pin the vendored range "^${target.version}"`);
			}
		}
	}
}

if (problems.length > 0) {
	process.stderr.write(`\n[31mHouse standard violations (${problems.length}):[0m\n`);
	for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
	process.stderr.write("\nSee AGENTS.md for the house standard and docs/provenance.md for the vendored packages.\n");
	process.exit(1);
}

process.stdout.write(
	`[32mHouse standard OK:[0m ${packages.filter((p) => p.origin === "house").length} house package(s), ` +
		`${packages.filter((p) => p.origin === "vendored").length} vendored (${Object.keys(VENDORED_PACKAGES).join(", ")}).\n`,
);
