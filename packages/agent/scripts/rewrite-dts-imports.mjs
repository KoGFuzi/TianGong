#!/usr/bin/env bun

const root = Bun.argv[2];
if (!root) throw new Error("Usage: bun scripts/rewrite-dts-imports.mjs <directory>");

for await (const path of new Bun.Glob("**/*.d.ts").scan({ cwd: root, absolute: true })) {
	const file = Bun.file(path);
	const source = await file.text();
	const rewritten = source.replace(/(from\s+["'][^"']+|import\s*\(["'][^"']+)(\.ts)(["'])/g, "$1.js$3");
	if (rewritten !== source) await Bun.write(path, rewritten);
}
