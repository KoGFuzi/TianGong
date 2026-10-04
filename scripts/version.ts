#!/usr/bin/env bun
/**
 * Sets one version across the workspace.
 *
 * House packages always move together on the `2.x` line. Vendored TianGong packages keep the
 * version they were adopted at; their changelog history belongs to upstream.
 *
 *   bun run version:patch        2.0.1 -> 2.0.2
 *   bun run version:minor        2.0.1 -> 2.1.0
 *   bun run version:major        2.0.1 -> 3.0.0
 *   bun run version:set 2.1.0    ->  2.1.0
 */
import { resolve } from "node:path";
import { listPackages, repoRoot } from "./lib/packages.ts";

const root = repoRoot();
const [action, argument] = process.argv.slice(2);
if (!action || !["patch", "minor", "major", "set"].includes(action)) {
	process.stderr.write("Usage: bun run scripts/version.ts <patch|minor|major|set> [version]\n");
	process.exit(1);
}

const packages = await listPackages(root);
const house = packages.filter((pkg) => pkg.origin === "house");
const current = house[0]?.version;
if (!current) throw new Error("No house packages found");

const bump = (version: string): string => {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
	if (action === "major") return `${major + 1}.0.0`;
	if (action === "minor") return `${major}.${minor + 1}.0`;
	if (action === "patch") return `${major}.${minor}.${patch + 1}`;
	return version;
};

const next = action === "set" ? (argument ?? "") : bump(current);
if (!/^\d+\.\d+\.\d+$/.test(next)) {
	process.stderr.write(`"${next}" is not a valid semver version\n`);
	process.exit(1);
}

/** Rewrites "version" in a manifest, preserving tab indentation and the trailing newline. */
async function setVersion(path: string, version: string): Promise<boolean> {
	const source = await Bun.file(path).text();
	const updated = source.replace(/^(\t"version":\s*)"[^"]+"(,?)$/m, `$1"${version}"$2`);
	if (updated === source) return false;
	await Bun.write(path, updated);
	return true;
}

await setVersion(resolve(root, "package.json"), next);
const changed: string[] = [];
for (const pkg of house) {
	if (await setVersion(pkg.path, next)) changed.push(pkg.name);
}

process.stdout.write(`Workspace version ${current} -> ${next}\nUpdated: ${changed.join(", ")}\n`);
process.stdout.write(
	`Left untouched (vendored): ${packages
		.filter((pkg) => pkg.origin === "vendored")
		.map((pkg) => `${pkg.name}@${pkg.version}`)
		.join(", ")}\n`,
);
process.stdout.write("\nRun `bun install` to refresh bun.lock, then record the move in packages/*/CHANGELOG.md.\n");
