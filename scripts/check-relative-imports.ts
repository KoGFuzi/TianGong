#!/usr/bin/env bun
/**
 * Every relative import must name its extension.
 *
 * The workspace compiles with `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`
 * and runs on Node/Bun ESM, both of which refuse extensionless specifiers. Checking it here
 * gives one error message instead of a wall of module-resolution noise from `tsc`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { listPackages, repoRoot } from "./lib/packages.ts";

const root = repoRoot();
const packages = await listPackages(root);
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".artifacts", "native"]);
const ALLOWED_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|node)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](\.[^"']*)["']/g;

async function* walk(directory: string): AsyncGenerator<string> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (IGNORED_DIRECTORIES.has(entry.name) || entry.name === ".git") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (/\.(?:ts|tsx|mts|cts|mjs)$/.test(entry.name)) yield path;
	}
}

const violations: string[] = [];

async function scan(directory: string): Promise<void> {
	for await (const file of walk(directory)) {
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(SPECIFIER)) {
			const specifier = match[1]!;
			// Split off a query/hash-free path; template expressions cannot be checked statically.
			if (specifier.includes("${")) continue;
			if (specifier.endsWith("/")) continue;
			if (!ALLOWED_EXTENSIONS.test(specifier)) {
				violations.push(`${relative(root, file)}: "${specifier}"`);
			}
		}
	}
}

await scan(resolve(root, "scripts"));
await scan(resolve(root, "vitest.base.ts").replace(/\/[^/]+$/, ""));
for (const pkg of packages) await scan(pkg.path);

if (violations.length > 0) {
	process.stderr.write(`\n[31mExtensionless relative imports (${violations.length}):[0m\n`);
	for (const violation of violations) process.stderr.write(`  - ${violation}\n`);
	process.exit(1);
}

process.stdout.write("[32mAll relative imports carry an explicit extension.[0m\n");
