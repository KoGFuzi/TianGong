#!/usr/bin/env bun
/**
 * Runs every workspace package's test suite in dependency order.
 *
 * Extra arguments are forwarded to the runner, so `bun run test --watch` works. Naming a
 * package (`bun run test packages/ai`) narrows the run to that package and its dependencies.
 */
import { buildOrder, listPackages, repoRoot, runInPackage, type WorkspacePackage } from "./lib/packages.ts";

const root = repoRoot();
const packages = await listPackages(root);
const passthrough = process.argv.slice(2).filter((arg) => arg.startsWith("-"));
const targets = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

const order = buildOrder(packages);
const selected: WorkspacePackage[] =
	targets.length === 0 ? order : order.filter((pkg) => targets.includes(pkg.directory) || targets.includes(pkg.name));

const failed: string[] = [];
for (const pkg of selected) {
	try {
		await runInPackage(pkg, "test", passthrough);
	} catch {
		failed.push(pkg.name);
	}
}

if (failed.length > 0) {
	process.stderr.write(`\n[31mFailing packages: ${failed.join(", ")}[0m\n`);
	process.exit(1);
}

process.stdout.write(`\n[32mAll ${selected.length} package suite(s) passed.[0m\n`);
