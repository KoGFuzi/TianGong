import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("sec-agent bins", () => {
	test("publishes the smoke CLI and the interactive shell, each with a Bun shebang", async () => {
		const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
			bin?: Record<string, string>;
		};
		expect(manifest.bin).toEqual({
			"tg-sec": "./dist/cli/main.js",
			tgsec: "./dist/tui/main.js",
		});

		for (const entry of ["src/cli/main.ts", "src/tui/main.ts"]) {
			const source = await readFile(resolve(packageDirectory, entry), "utf8");
			expect(source.startsWith("#!/usr/bin/env bun\n"), `${entry} must start with a Bun shebang`).toBe(true);
		}
	});
});
