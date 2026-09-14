import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type {
	PluginBundleEntry,
	PluginBundleManifest,
} from "./manifest.ts";
import {
	PLUGIN_BUNDLE_FORMAT,
	PLUGIN_BUNDLE_FORMAT_VERSION,
	PLUGIN_BUNDLE_MANIFEST_FILE,
} from "./manifest.ts";

export interface BundlePluginsOptions {
	readonly plugin: {
		readonly id: string;
		readonly version?: string;
	};
	/** Opaque application-selected entry names mapped to TypeScript or JavaScript source files. */
	readonly entries: Readonly<Record<string, string>>;
	readonly outdir: string;
	readonly workingDirectory?: string;
	/** Additional package imports intentionally left for the loading application to resolve. */
	readonly external?: readonly string[];
	readonly sourceMap?: boolean;
	readonly minify?: boolean;
	readonly define?: Readonly<Record<string, string>>;
}

export interface BundlePluginsResult {
	readonly manifest: PluginBundleManifest;
	readonly manifestPath: string;
}

/** Bundle each opaque plugin entry into an independent content-addressed ESM file. */
export async function bundlePlugins(options: BundlePluginsOptions): Promise<BundlePluginsResult> {
	validateOptions(options);
	const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
	const outputDirectory = resolve(workingDirectory, options.outdir);
	const outputParent = dirname(outputDirectory);
	await mkdir(outputParent, { recursive: true });
	const temporaryDirectory = join(outputParent, `.${basename(outputDirectory)}.tmp-${randomUUID()}`);
	await mkdir(temporaryDirectory);
	try {
		const entries: Record<string, PluginBundleEntry> = {};
		for (const [entryName, source] of Object.entries(options.entries).sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			entries[entryName] = await bundleEntry({
				entryName,
				source: resolve(workingDirectory, source),
				temporaryDirectory,
				workingDirectory,
				options,
			});
		}
		const manifest: PluginBundleManifest = Object.freeze({
			format: PLUGIN_BUNDLE_FORMAT,
			formatVersion: PLUGIN_BUNDLE_FORMAT_VERSION,
			plugin: Object.freeze({
				id: options.plugin.id,
				...(options.plugin.version === undefined ? {} : { version: options.plugin.version }),
			}),
			entries: Object.freeze(entries),
		});
		await writeFile(join(temporaryDirectory, PLUGIN_BUNDLE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
		await replaceDirectory(temporaryDirectory, outputDirectory);
		return Object.freeze({
			manifest,
			manifestPath: join(outputDirectory, PLUGIN_BUNDLE_MANIFEST_FILE),
		});
	} catch (error) {
		await rm(temporaryDirectory, { force: true, recursive: true });
		throw error;
	}
}

async function bundleEntry(input: {
	readonly entryName: string;
	readonly source: string;
	readonly temporaryDirectory: string;
	readonly workingDirectory: string;
	readonly options: BundlePluginsOptions;
}): Promise<PluginBundleEntry> {
	const entryPrefix = `plugin-${shortHash(input.entryName)}`;
	const external = [...new Set(["@onepanda-tiangongsec/tg-chord", "@onepanda-tiangongsec/tg-chord/*", ...(input.options.external ?? [])])];
	const result = await Bun.build({
		entrypoints: [input.source],
		outdir: input.temporaryDirectory,
		naming: `${entryPrefix}-[hash].js`,
		format: "esm",
		target: "bun",
		external,
		sourcemap: input.options.sourceMap === true ? "external" : "none",
		minify: input.options.minify ?? false,
		define: input.options.define,
	});
	if (!result.success) {
		const diagnostics = result.logs.map((log) => log.message).join("\n");
		throw new Error(`Could not bundle plugin entry ${input.entryName}${diagnostics ? `\n${diagnostics}` : ""}`);
	}

	const outputs = result.outputs.filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
	if (outputs.length !== 1) {
		throw new Error(`Plugin entry ${input.entryName} did not produce exactly one JavaScript file`);
	}
	const output = outputs[0]!;
	const file = relative(input.temporaryDirectory, output.path);
	if (file.length === 0 || file.startsWith(`..${sep}`) || basename(file) !== file) {
		throw new Error(`Plugin entry ${input.entryName} produced an invalid output path`);
	}
	const sourceMap = input.options.sourceMap === true ? `${file}.map` : undefined;

	const contents = await readFile(output.path);
	if (sourceMap !== undefined) await stat(join(input.temporaryDirectory, sourceMap));
	const externalImports = Object.freeze(
		[...new Set(collectExternalImports(contents.toString("utf8"), external))].sort(),
	);

	return Object.freeze({
		file,
		integrity: `sha256-${createHash("sha256").update(contents).digest("base64")}`,
		externalImports,
		...(sourceMap === undefined ? {} : { sourceMap }),
	});
}

const IMPORT_SPECIFIER = /(?:import|export)\s*(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gu;

function collectExternalImports(source: string, external: readonly string[]): string[] {
	const set = new Set<string>();
	for (const [, specifier] of source.matchAll(IMPORT_SPECIFIER)) {
		if (specifier !== undefined && external.some((pattern) => matchesExternal(specifier, pattern))) {
			set.add(specifier);
		}
	}
	return [...set];
}

function matchesExternal(specifier: string, pattern: string): boolean {
	if (pattern === specifier) return true;
	if (pattern.endsWith("/*") && specifier.startsWith(pattern.slice(0, -1))) return true;
	return false;
}

function validateOptions(options: BundlePluginsOptions): void {
	if (options.plugin.id.length === 0) throw new TypeError("Plugin bundle plugin ID must not be empty");
	if (options.plugin.version !== undefined && options.plugin.version.length === 0) {
		throw new TypeError("Plugin bundle plugin version must not be empty");
	}
	const entries = Object.entries(options.entries);
	if (entries.length === 0) throw new TypeError("Plugin bundle must contain at least one entry");
	for (const [name, source] of entries) {
		if (name.length === 0) throw new TypeError("Plugin bundle entry name must not be empty");
		if (source.length === 0) throw new TypeError(`Plugin bundle entry ${name} must have a source path`);
	}
	for (const external of options.external ?? []) {
		if (external.length === 0) throw new TypeError("Plugin bundle external import must not be empty");
	}
}

async function replaceDirectory(temporaryDirectory: string, outputDirectory: string): Promise<void> {
	const backupDirectory = `${outputDirectory}.old-${randomUUID()}`;
	let movedExisting = false;
	try {
		await rename(outputDirectory, backupDirectory);
		movedExisting = true;
	} catch (error) {
		if (!isMissingPath(error)) throw error;
	}
	try {
		await rename(temporaryDirectory, outputDirectory);
	} catch (error) {
		if (movedExisting) await rename(backupDirectory, outputDirectory);
		throw error;
	}
	if (movedExisting) await rm(backupDirectory, { force: true, recursive: true });
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isMissingPath(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
