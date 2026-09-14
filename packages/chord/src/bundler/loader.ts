import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Facet, FacetLoader, LoadedFacets } from "../types.ts";
import {
	PLUGIN_BUNDLE_FORMAT,
	PLUGIN_BUNDLE_FORMAT_VERSION,
	PLUGIN_BUNDLE_MANIFEST_FILE,
	type PluginBundleEntry,
	type PluginBundleManifest,
} from "./manifest.ts";

export type PluginBundleExternalResolver = (specifier: string) => string | URL | undefined;

export interface PluginBundleLoaderOptions {
	readonly manifestPath: string | URL;
	readonly entry: string;
	/** Verify the entry's SHA-256 integrity before evaluating it. Defaults to true. */
	readonly verifyIntegrity?: boolean;
	/** Resolve host-provided external imports when the bundle is outside the host's package tree. */
	readonly resolveExternal?: PluginBundleExternalResolver;
}

/** Read and validate a versioned plugin bundle manifest. */
export async function readPluginBundleManifest(path: string | URL): Promise<PluginBundleManifest> {
	const manifestPath = toFilePath(path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read plugin bundle manifest ${manifestPath}`, { cause: error });
	}
	return validateManifest(parsed, manifestPath);
}

/** Create a reusable loader for one opaque entry in a plugin bundle manifest. */
export function createPluginBundleLoader(options: PluginBundleLoaderOptions): FacetLoader {
	if (options.entry.length === 0) throw new TypeError("Plugin bundle entry name must not be empty");
	const manifestPath = toFilePath(options.manifestPath);
	return {
		async load(): Promise<LoadedFacets> {
			const manifest = await readPluginBundleManifest(manifestPath);
			const entry = manifest.entries[options.entry];
			if (entry === undefined) {
				throw new Error(`Plugin bundle ${manifest.plugin.id} has no entry named ${options.entry}`);
			}
			const modulePath = resolveBundleFile(manifestPath, entry.file, "entry");
			const source = await readFile(modulePath, "utf8");
			if (options.verifyIntegrity !== false) verifySource(source, entry);
			const url = pathToFileURL(modulePath);
			const exported = await import(url.href);
			let facets = facetsFromModule(exported, manifest.plugin.id, options.entry);
			let disposed = false;
			return {
				get facets() {
					return facets;
				},
				async dispose() {
					if (disposed) return;
					disposed = true;
					facets = Object.freeze([]);
				},
			};
		},
	};
}

function toFilePath(path: string | URL): string {
	if (typeof path === "string") return resolve(path);
	if (path.protocol !== "file:") throw new TypeError(`Plugin bundle manifest must be a file URL, not ${path.protocol}`);
	return fileURLToPath(path);
}

function resolveBundleFile(manifestPath: string, file: string, label: string): string {
	if (file.length === 0 || isAbsolute(file) || basename(file) !== file || file === "." || file === "..") {
		throw new Error(`Plugin bundle ${label} must be a filename relative to its manifest`);
	}
	return resolve(dirname(manifestPath), file);
}

function verifySource(source: string, entry: PluginBundleEntry): void {
	const expected = parseIntegrity(entry.integrity);
	const actual = Bun.SHA256.hash(source, "base64");
	if (actual !== expected) throw new Error(`Plugin bundle integrity check failed for ${entry.file}`);
}

function parseIntegrity(integrity: string): string {
	const prefix = "sha256-";
	if (!integrity.startsWith(prefix) || integrity.length === prefix.length) {
		throw new Error("Plugin bundle entry has an invalid SHA-256 integrity value");
	}
	return integrity.slice(prefix.length);
}

function facetsFromModule(imported: unknown, pluginId: string, entryName: string): readonly Facet[] {
	if (!isRecord(imported)) throw new Error(`Plugin bundle entry ${pluginId}/${entryName} did not export a module`);
	const exported = imported.default;
	const candidates: readonly unknown[] = Array.isArray(exported) ? (exported as readonly unknown[]) : [exported];
	if (candidates.length === 0) {
		throw new Error(`Plugin bundle entry ${pluginId}/${entryName} exported no plugins`);
	}
	const facets: Facet[] = [];
	for (const candidate of candidates) {
		if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) {
			throw new Error(`Plugin bundle entry ${pluginId}/${entryName} has a plugin with an invalid ID`);
		}
		if (typeof candidate.setup !== "function") {
			throw new Error(`Plugin bundle entry ${pluginId}/${entryName} plugin ${candidate.id} has no setup function`);
		}
		facets.push(candidate as unknown as Facet);
	}
	const ids = facets.map(({ id }) => id);
	if (new Set(ids).size !== ids.length) {
		throw new Error(`Plugin bundle entry ${pluginId}/${entryName} exports duplicate plugin IDs`);
	}
	return Object.freeze(facets);
}

function validateManifest(value: unknown, path: string): PluginBundleManifest {
	if (!isRecord(value) || value.format !== PLUGIN_BUNDLE_FORMAT) {
		throw new Error(`Invalid plugin bundle manifest format in ${path}`);
	}
	if (value.formatVersion !== PLUGIN_BUNDLE_FORMAT_VERSION) {
		throw new Error(`Unsupported plugin bundle manifest version in ${path}: ${String(value.formatVersion)}`);
	}
	if (!isRecord(value.plugin) || typeof value.plugin.id !== "string" || value.plugin.id.length === 0) {
		throw new Error(`Plugin bundle manifest has an invalid plugin identity in ${path}`);
	}
	if (
		value.plugin.version !== undefined &&
		(typeof value.plugin.version !== "string" || value.plugin.version.length === 0)
	) {
		throw new Error(`Plugin bundle manifest has an invalid plugin version in ${path}`);
	}
	if (!isRecord(value.entries) || Object.keys(value.entries).length === 0) {
		throw new Error(`Plugin bundle manifest has no entries in ${path}`);
	}
	const entries: Record<string, PluginBundleEntry> = {};
	for (const [name, candidate] of Object.entries(value.entries)) {
		if (name.length === 0 || !isRecord(candidate)) {
			throw new Error(`Plugin bundle manifest has an invalid entry in ${path}`);
		}
		if (typeof candidate.file !== "string") throw new Error(`Plugin bundle entry ${name} has no file`);
		resolveBundleFile(path, candidate.file, `entry ${name}`);
		if (typeof candidate.integrity !== "string") throw new Error(`Plugin bundle entry ${name} has no integrity`);
		parseIntegrity(candidate.integrity);
		if (
			!Array.isArray(candidate.externalImports) ||
			candidate.externalImports.some((item: unknown) => typeof item !== "string")
		) {
			throw new Error(`Plugin bundle entry ${name} has invalid external imports`);
		}
		const externalImports = Object.freeze([...(candidate.externalImports as readonly string[])]);
		if (new Set(externalImports).size !== externalImports.length) {
			throw new Error(`Plugin bundle entry ${name} has duplicate external imports`);
		}
		if (candidate.sourceMap !== undefined) {
			if (typeof candidate.sourceMap !== "string")
				throw new Error(`Plugin bundle entry ${name} has an invalid source map`);
			resolveBundleFile(path, candidate.sourceMap, `entry ${name} source map`);
		}
		entries[name] = Object.freeze({
			file: candidate.file,
			integrity: candidate.integrity,
			externalImports,
			...(candidate.sourceMap === undefined ? {} : { sourceMap: candidate.sourceMap }),
		});
	}
	return Object.freeze({
		format: PLUGIN_BUNDLE_FORMAT,
		formatVersion: PLUGIN_BUNDLE_FORMAT_VERSION,
		plugin: Object.freeze({
			id: value.plugin.id,
			...(value.plugin.version === undefined ? {} : { version: value.plugin.version }),
		}),
		entries: Object.freeze(entries),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
