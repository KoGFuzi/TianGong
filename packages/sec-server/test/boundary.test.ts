import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The sidecar owns the WebUI contract and must stay below the campaign runtime: it depends on the
 * harness and chord only, and the host injects a plain projection. These assertions read the
 * manifest, the source imports and the build path map, so the AGENTS.md edge cannot drift from the
 * package.
 */

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageDirectory, "src");
const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/gu;

const ALLOWED_WORKSPACE = ["@OnePanda-TgSec/chord", "@OnePanda-TgSec/tg-gibraltar"];

async function sourceSpecifiers(): Promise<readonly { readonly file: string; readonly specifier: string }[]> {
	const entries = await readdir(sourceDirectory, { recursive: true });
	const found: { file: string; specifier: string }[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string" || !entry.endsWith(".ts")) continue;
		const source = await readFile(resolve(sourceDirectory, entry), "utf8");
		for (const match of source.matchAll(IMPORT_SPECIFIER)) {
			found.push({ file: entry.split(sep).join("/"), specifier: match[1]! });
		}
	}
	return found;
}

describe("sec-server package boundary", () => {
	test("declares the harness and chord as its only house dependencies", async () => {
		const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		const declared = Object.keys(manifest.dependencies ?? {})
			.filter((name) => name.startsWith("@OnePanda-TgSec/"))
			.sort();
		expect(declared).toEqual([...ALLOWED_WORKSPACE].sort());
	});

	test("imports no house package outside that edge set and never imports the campaign runtime", async () => {
		for (const { file, specifier } of await sourceSpecifiers()) {
			if (!specifier.startsWith("@OnePanda-TgSec/")) continue;
			const root = specifier.split("/").slice(0, 2).join("/");
			expect(ALLOWED_WORKSPACE, `${file} imports ${root}`).toContain(root);
			expect(specifier, `${file} must not depend on sec-agent`).not.toContain("tg-sec-agent");
		}
	});

	test("keeps its build path map explicit for every house import", async () => {
		const build = JSON.parse(await readFile(resolve(packageDirectory, "tsconfig.build.json"), "utf8")) as {
			compilerOptions?: { paths?: Record<string, string[]> };
		};
		for (const name of ALLOWED_WORKSPACE) {
			expect(build.compilerOptions?.paths?.[name], `${name} must resolve to a sibling dist`).toBeDefined();
		}
	});

	test("serves a self-contained WebUI without dynamic imports or HTML injection", async () => {
		const web = resolve(packageDirectory, "web");
		const index = await readFile(resolve(web, "index.html"), "utf8");
		expect(index).not.toMatch(/https?:\/\//);
		expect(index).toContain('src="./app.js"');
		const script = await readFile(resolve(web, "app.js"), "utf8");
		expect(script).not.toContain("innerHTML");
		expect(script).not.toMatch(/\bimport\s*\(/);
	});
});
