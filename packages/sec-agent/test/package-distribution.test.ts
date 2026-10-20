import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { tg: string };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./rpc-entry": { import: string; types: string };
	};
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("exposes the CLI and the modular library entrypoints", () => {
		expect(packageJson.bin.tg).toBe("dist/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/rpc-entry.js");
	});
});
