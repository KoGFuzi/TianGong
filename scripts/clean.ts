#!/usr/bin/env bun
/**
 * Removes build output from every workspace package.
 *
 * Also clears the generated model catalog under `packages/ai/src/providers/data`, which is
 * reproduced by `bun run generate:models` and never committed.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { listPackages, repoRoot } from "./lib/packages.ts";

const root = repoRoot();
const packages = await listPackages(root);
const targets = [
	...packages.map((pkg) => resolve(pkg.path, "dist")),
	resolve(root, "packages/tui/dist-chrome"),
	resolve(root, "packages/tui/dist-firefox"),
	resolve(root, ".artifacts"),
];

for (const target of targets) {
	await rm(target, { force: true, recursive: true });
	process.stdout.write(`removed ${target.replace(`${root}/`, "")}\n`);
}

process.stdout.write(`\n[32mCleaned ${targets.length} path(s).[0m\n`);
