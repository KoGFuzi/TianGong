import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { bundlePluginPackage, bundlePlugins, createPluginBundleLoader, readPluginBundleManifest } from "../src/bundler.ts";
import { createFacetHost, defineFacet, defineService } from "../src/index.ts";

interface GenerationValue {
	read(): string;
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];
const GenerationValue = defineService<GenerationValue>("test.bundle.generation", { local: true });

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("plugin bundles", () => {
	test("builds independent content-addressed entries and loads fresh reloadable generations", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-test-"));
		temporaryDirectories.push(directory);
		const sourceDirectory = join(directory, "src");
		const outputDirectory = join(directory, "bundle");
		await mkdir(sourceDirectory);
		await writeFile(
			join(sourceDirectory, "helper.ts"),
			'export const decorate = (value: string): string => "generation:" + value;\n',
		);
		const entryPath = join(sourceDirectory, "entry.ts");
		const presentationPath = join(sourceDirectory, "presentation.ts");
		await writeGeneration(entryPath, "A");
		await writeFile(presentationPath, 'export default { id: "bundle-presentation", setup() {} };\n');
		const pluginEntries = { presentation: presentationPath, worker: entryPath };

		const firstBuild = await bundlePlugins({
			plugin: { id: "test-bundle", version: "1" },
			entries: pluginEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		const firstEntry = firstBuild.manifest.entries.worker!;
		expect(firstEntry.file).toMatch(/^plugin-[a-f0-9]{12}-[a-z0-9]+\.js$/i);
		expect(firstEntry.sourceMap).toBe(`${firstEntry.file}.map`);
		expect(firstEntry.externalImports).toEqual(["@onepanda-tiangongsec/tg-chord"]);
		expect(firstBuild.manifest.entries.presentation!.file).not.toBe(firstEntry.file);
		expect((await readdir(outputDirectory)).filter((path) => path.endsWith(".js"))).toHaveLength(2);
		const firstSource = await readFile(join(outputDirectory, firstEntry.file), "utf8");
		expect(firstSource).toContain("@onepanda-tiangongsec/tg-chord");
		expect((await readFile(firstBuild.manifestPath, "utf8")).endsWith("\n")).toBe(true);

		const presentation = await createPluginBundleLoader({
			manifestPath: firstBuild.manifestPath,
			entry: "presentation",
		}).load();
		expect(presentation.facets.map(({ id }) => id)).toEqual(["bundle-presentation"]);
		await presentation.dispose();

		const secondBuild = await bundlePlugins({
			plugin: { id: "test-bundle", version: "1" },
			entries: pluginEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		expect(secondBuild.manifest.entries.worker).toEqual(firstEntry);

		const loader = createPluginBundleLoader({ manifestPath: secondBuild.manifestPath, entry: "worker" });
		const loadedA = await loader.load();

		let retained: GenerationValue | undefined;
		const consumer = defineFacet({
			id: "bundle-consumer",
			setup(env) {
				retained = env.use(GenerationValue);
			},
		});
		const host = await createFacetHost({ facets: [consumer, ...loadedA.facets] });
		expect(retained!.read()).toBe("generation:A");

		await writeGeneration(entryPath, "B");
		const thirdBuild = await bundlePlugins({
			plugin: { id: "test-bundle", version: "2" },
			entries: pluginEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		expect(thirdBuild.manifest.entries.worker!.file).not.toBe(firstEntry.file);
		const loadedB = await loader.load();
		await host.reload(loadedB.facets);
		await loadedA.dispose();
		expect(retained!.read()).toBe("generation:B");

		await host.dispose();
		await loadedB.dispose();
	});

	test("loads host externals through the runtime import graph", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-external-test-"));
		temporaryDirectories.push(directory);
		const entryPath = join(directory, "entry.ts");
		const outputDirectory = join(directory, "bundle");
		await writeFile(
			entryPath,
			'import { createContextKey } from "@onepanda-tiangongsec/tg-chord/context";\n' +
				"const key = createContextKey(\"test\");\n" +
				'export default { id: "external-facet", setup() {} };\n',
		);
		const result = await bundlePlugins({
			plugin: { id: "external-bundle" },
			entries: { worker: entryPath },
			outdir: outputDirectory,
		});
		const entry = result.manifest.entries.worker!;
		const source = await readFile(join(outputDirectory, entry.file), "utf8");
		expect(source).toContain("@onepanda-tiangongsec/tg-chord/context");
		const loaded = await createPluginBundleLoader({
			manifestPath: result.manifestPath,
			entry: "worker",
		}).load();
		expect(loaded.facets.map(({ id }) => id)).toEqual(["external-facet"]);
		await loaded.dispose();
	});

	test("builds plugin packages from conventional and configured entries", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-package-test-"));
		temporaryDirectories.push(directory);
		const sourceDirectory = join(directory, "src");
		await mkdir(sourceDirectory);
		await Promise.all([
			writeFile(
				join(directory, "package.json"),
				`${JSON.stringify({
					name: "@example/conventional-plugin",
					version: "1.2.3",
					peerDependencies: { "@example/host": "^1.0.0" },
				})}\n`,
			),
			writeFile(
				join(sourceDirectory, "worker.ts"),
				'import "@example/host/plugin"; export default { id: "package-worker", setup() {} };\n',
			),
			writeFile(join(sourceDirectory, "ui.ts"), 'export default { id: "package-ui", setup() {} };\n'),
			writeFile(join(sourceDirectory, "contract.ts"), "export const ignored = true;\n"),
			writeFile(join(sourceDirectory, "configured.ts"), 'export default { id: "configured-ui", setup() {} };\n'),
		]);

		const conventional = await bundlePluginPackage({
			packagePath: directory,
			outdir: join(directory, "build"),
			defaultEntries: { worker: "src/worker.ts", ui: "src/ui.ts", browser: "src/browser.ts" },
		});
		expect(conventional.packageDirectory).toBe(directory);
		expect(conventional.manifest.plugin).toEqual({ id: "@example/conventional-plugin", version: "1.2.3" });
		expect(Object.keys(conventional.manifest.entries)).toEqual(["ui", "worker"]);
		expect(conventional.manifest.entries.worker?.externalImports).toEqual(["@example/host/plugin"]);
		expect(conventional.manifest.entries.ui?.sourceMap).toMatch(/\.js\.map$/u);

		await writeFile(
			join(directory, "package.json"),
			`${JSON.stringify({
				name: "@example/conventional-plugin",
				version: "2.0.0",
				chord: { entries: { worker: false, ui: "src/configured.ts" }, sourceMap: false },
			})}\n`,
		);
		const configured = await bundlePluginPackage({
			packagePath: join(directory, "package.json"),
			outdir: join(directory, "build"),
			defaultEntries: { worker: "src/worker.ts", ui: "src/ui.ts" },
		});
		expect(Object.keys(configured.manifest.entries)).toEqual(["ui"]);
		expect(configured.manifest.entries.ui?.sourceMap).toBeUndefined();
		const loaded = await createPluginBundleLoader({
			manifestPath: configured.manifestPath,
			entry: "ui",
		}).load();
		expect(loaded.facets.map(({ id }) => id)).toEqual(["configured-ui"]);
		await loaded.dispose();
	});

	test("rejects invalid plugin package entry configuration", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-package-test-"));
		temporaryDirectories.push(directory);
		await writeFile(
			join(directory, "package.json"),
			`${JSON.stringify({
				name: "invalid-plugin",
				version: "1.0.0",
				chord: { entries: { ui: "../outside.ts" } },
			})}\n`,
		);
		await expect(bundlePluginPackage({ packagePath: directory, outdir: join(directory, "build") })).rejects.toThrow(
			"escapes the package directory",
		);
	});

	test("rejects corrupt entries and invalid module exports", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-test-"));
		temporaryDirectories.push(directory);
		const entryPath = join(directory, "entry.ts");
		const outputDirectory = join(directory, "bundle");
		await writeFile(entryPath, "export default { id: 'missing-setup' };\n");
		const result = await bundlePlugins({
			plugin: { id: "invalid-bundle" },
			entries: { invalid: entryPath },
			outdir: outputDirectory,
		});
		const loader = createPluginBundleLoader({ manifestPath: result.manifestPath, entry: "invalid" });
		await expect(loader.load()).rejects.toThrow("has no setup function");

		const manifest = await readPluginBundleManifest(result.manifestPath);
		await writeFile(join(outputDirectory, manifest.entries.invalid!.file), "export default {};\n");
		await expect(loader.load()).rejects.toThrow("integrity check failed");
	});
});

async function writeGeneration(path: string, generation: string): Promise<void> {
	await writeFile(
		path,
		`import "@onepanda-tiangongsec/tg-chord";\n` +
			`import { decorate } from "./helper.ts";\n` +
			`const Value = { id: "test.bundle.generation", local: true };\n` +
			`export default { id: "bundle-provider", setup(env) {\n` +
			`  env.provide(Value, { read() { return decorate(${JSON.stringify(generation)}); } });\n` +
			`}};\n`,
	);
}
