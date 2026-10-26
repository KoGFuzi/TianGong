import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("tg-sec bin", () => {
	test("is the package's only entry point and starts with a Bun shebang", async () => {
		const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
			bin?: Record<string, string>;
		};
		expect(manifest.bin).toEqual({ "tg-sec": "./dist/cli/main.js" });

		const source = await readFile(resolve(packageDirectory, "src/cli/main.ts"), "utf8");
		expect(source.startsWith("#!/usr/bin/env bun\n")).toBe(true);
	});
});
