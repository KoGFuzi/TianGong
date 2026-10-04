#!/usr/bin/env bun
/**
 * Builds every workspace package in dependency order.
 *
 * `tsc` still emits declarations, but orchestration is Bun's job: one process, one graph,
 * one ordered pass. Pass `--offline` to prefer each package's `build:offline` script where one
 * exists; only `@OnePanda-TgSec/tg-ai` has one, because only it needs the network-backed model
 * catalog refresh. Packages without it build normally.
 *
 * Naming a package (`bun run scripts/build.ts packages/chord`) narrows the run.
 */
import { buildOrder, listPackages, repoRoot, runInPackage, type WorkspacePackage } from "./lib/packages.ts";

const root = repoRoot();
const packages = await listPackages(root);
const offline = process.argv.includes("--offline");
const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

const order = buildOrder(packages);
const selected: WorkspacePackage[] =
	only.length === 0 ? order : order.filter((pkg) => only.includes(pkg.directory) || only.includes(pkg.name));

/** `build:offline` where the package defines it, plain `build` otherwise. */
const scriptFor = (pkg: WorkspacePackage): string => {
	const scripts = pkg.manifest.scripts as Record<string, string> | undefined;
	return offline && scripts?.["build:offline"] ? "build:offline" : "build";
};

process.stdout.write(`TianGong build${offline ? " (offline)" : ""}: ${selected.map((p) => p.name).join(" -> ")}\n`);

for (const pkg of selected) {
	await runInPackage(pkg, scriptFor(pkg));
}

process.stdout.write(`\n[32mBuilt ${selected.length} package(s).[0m\n`);
