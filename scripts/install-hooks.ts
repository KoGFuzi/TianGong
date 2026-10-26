#!/usr/bin/env bun
/**
 * Installs the repository's git hooks by pointing `.git/hooks/pre-commit` at `.githooks/pre-commit`.
 *
 * No hook framework, no extra dependency: one file, one symlink, re-runnable.
 */
import { chmod, copyFile, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { repoRoot } from "./lib/packages.ts";

const root = repoRoot();
const gitDirectory = Bun.spawnSync(["git", "rev-parse", "--git-dir"], { cwd: root });
if (gitDirectory.exitCode !== 0) {
	process.stdout.write("Not a git repository; skipping hook install.\n");
	process.exit(0);
}

const hooksDirectory = resolve(root, gitDirectory.stdout.toString().trim(), "hooks");
const source = resolve(root, ".githooks", "pre-commit");
const target = resolve(hooksDirectory, "pre-commit");

await mkdir(hooksDirectory, { recursive: true });
await chmod(source, 0o755);
await rm(target, { force: true });
let linked = true;
try {
	await symlink(relative(hooksDirectory, source), target);
} catch (error) {
	// Windows without Developer Mode/admin denies symlinks (EPERM). A copy keeps the hook
	// working; it just doesn't track later edits to .githooks/pre-commit.
	if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
	await copyFile(source, target);
	linked = false;
}

const installed = (await readFile(target, "utf8")).length;
process.stdout.write(`Installed ${relative(root, target)} (${installed} bytes, ${linked ? "symlink" : "copy"}).\n`);
