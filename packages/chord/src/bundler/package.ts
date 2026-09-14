import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bundlePlugins, type BundlePluginsOptions, type BundlePluginsResult } from "./build.ts";

export interface BundlePluginPackageOptions {
	/** Plugin package directory or its package.json path. */
	readonly packagePath: string;
	readonly outdir: string;
	/** Application conventions applied when the corresponding source file exists. */
	readonly defaultEntries?: Readonly<Record<string, string>>;
}

export interface BundlePluginPackageResult extends BundlePluginsResult {
	readonly packageDirectory: string;
	readonly packageJsonPath: string;
}

interface PluginPackageMetadata {
	readonly packageDirectory: string;
	readonly packageJsonPath: string;
	readonly name: string;
	readonly version: string;
	readonly peerDependencies: readonly string[];
	readonly configuredEntries: Readonly<Record<string, string | false>>;
	readonly external: readonly string[];
	readonly sourceMap: boolean;
}

/** Build a plugin package using package.json metadata and application-provided entry conventions. */
export async function bundlePluginPackage(options: BundlePluginPackageOptions): Promise<BundlePluginPackageResult> {
	const metadata = await readPluginPackageMetadata(options.packagePath);
	const entries = await resolvePluginEntries(metadata, options.defaultEntries ?? {});
	const external = [...metadata.peerDependencies, ...metadata.external].flatMap((specifier) => [
		specifier,
		`${specifier}/*`,
	]);
	const result = await bundlePlugins({
		plugin: { id: metadata.name, version: metadata.version },
		entries,
		outdir: options.outdir,
		workingDirectory: metadata.packageDirectory,
		external,
		sourceMap: metadata.sourceMap,
	});
	return Object.freeze({
		...result,
		packageDirectory: metadata.packageDirectory,
		packageJsonPath: metadata.packageJsonPath,
	});
}

async function readPluginPackageMetadata(packagePath: string): Promise<PluginPackageMetadata> {
	if (packagePath.length === 0) throw new TypeError("Plugin package path must not be empty");
	const candidate = resolve(packagePath);
	let packageDirectory: string;
	let packageJsonPath: string;
	let candidateStats: Awaited<ReturnType<typeof stat>>;
	try {
		candidateStats = await stat(candidate);
	} catch (error) {
		throw new Error(`Could not access plugin package ${candidate}`, { cause: error });
	}
	if (candidateStats.isDirectory()) {
		packageDirectory = await realpath(candidate);
		packageJsonPath = join(packageDirectory, "package.json");
	} else if (candidateStats.isFile() && basename(candidate) === "package.json") {
		packageJsonPath = await realpath(candidate);
		packageDirectory = dirname(packageJsonPath);
	} else {
		throw new Error(`Plugin package path must name a directory or package.json: ${candidate}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read plugin package metadata ${packageJsonPath}`, { cause: error });
	}
	if (!isRecord(parsed)) throw new Error(`Plugin package metadata must be an object: ${packageJsonPath}`);
	if (typeof parsed.name !== "string" || parsed.name.length === 0) {
		throw new Error(`Plugin package must have a non-empty name: ${packageJsonPath}`);
	}
	if (typeof parsed.version !== "string" || parsed.version.length === 0) {
		throw new Error(`Plugin package must have a non-empty version: ${packageJsonPath}`);
	}
	const peerDependencies = parsePeerDependencies(parsed.peerDependencies, packageJsonPath);
	const chord = parseChordConfiguration(parsed.chord, packageJsonPath);
	return {
		packageDirectory,
		packageJsonPath,
		name: parsed.name,
		version: parsed.version,
		peerDependencies,
		configuredEntries: chord.entries,
		external: chord.external,
		sourceMap: chord.sourceMap,
	};
}

function parsePeerDependencies(value: unknown, packageJsonPath: string): readonly string[] {
	if (value === undefined) return [];
	if (
		!isRecord(value) ||
		Object.entries(value).some(([name, version]) => name.length === 0 || typeof version !== "string")
	) {
		throw new Error(`Plugin package has invalid peerDependencies: ${packageJsonPath}`);
	}
	return Object.freeze(Object.keys(value).sort());
}

function parseChordConfiguration(
	value: unknown,
	packageJsonPath: string,
): {
	readonly entries: Readonly<Record<string, string | false>>;
	readonly external: readonly string[];
	readonly sourceMap: boolean;
} {
	if (value === undefined) return { entries: Object.freeze({}), external: Object.freeze([]), sourceMap: true };
	if (!isRecord(value)) throw new Error(`Plugin package chord configuration must be an object: ${packageJsonPath}`);
	if (Object.keys(value).some((key) => key !== "entries" && key !== "external" && key !== "sourceMap")) {
		throw new Error(`Plugin package chord configuration has an unknown field: ${packageJsonPath}`);
	}
	const entries: Record<string, string | false> = {};
	if (value.entries !== undefined) {
		if (!isRecord(value.entries)) {
			throw new Error(`Plugin package chord.entries must be an object: ${packageJsonPath}`);
		}
		for (const [name, source] of Object.entries(value.entries)) {
			if (name.length === 0 || (typeof source !== "string" && source !== false) || source === "") {
				throw new Error(`Plugin package has an invalid chord.entries entry: ${packageJsonPath}`);
			}
			entries[name] = source;
		}
	}
	let external: readonly string[] = [];
	if (value.external !== undefined) {
		if (
			!Array.isArray(value.external) ||
			value.external.some((specifier) => typeof specifier !== "string" || specifier.length === 0)
		) {
			throw new Error(`Plugin package chord.external must contain non-empty strings: ${packageJsonPath}`);
		}
		external = Object.freeze([...new Set(value.external as readonly string[])].sort());
	}
	if (value.sourceMap !== undefined && typeof value.sourceMap !== "boolean") {
		throw new Error(`Plugin package chord.sourceMap must be a boolean: ${packageJsonPath}`);
	}
	return {
		entries: Object.freeze(entries),
		external,
		sourceMap: value.sourceMap ?? true,
	};
}

async function resolvePluginEntries(
	metadata: PluginPackageMetadata,
	defaultEntries: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>>> {
	const entries: Record<string, string> = {};
	for (const [name, source] of Object.entries(defaultEntries)) {
		validateEntryMapping(name, source, "default");
		const path = resolvePackageEntry(metadata.packageDirectory, source, name);
		try {
			const entryStats = await stat(path);
			if (!entryStats.isFile()) throw new Error(`Default plugin entry ${name} is not a file: ${path}`);
			const canonicalPath = await realpath(path);
			validateCanonicalPackageEntry(metadata.packageDirectory, canonicalPath, name);
			entries[name] = canonicalPath;
		} catch (error) {
			if (isMissingPath(error)) continue;
			throw error;
		}
	}
	for (const [name, source] of Object.entries(metadata.configuredEntries)) {
		if (source === false) {
			delete entries[name];
			continue;
		}
		validateEntryMapping(name, source, "configured");
		const path = resolvePackageEntry(metadata.packageDirectory, source, name);
		let entryStats: Awaited<ReturnType<typeof stat>>;
		try {
			entryStats = await stat(path);
		} catch (error) {
			throw new Error(`Could not access configured plugin entry ${name}: ${path}`, { cause: error });
		}
		if (!entryStats.isFile()) throw new Error(`Configured plugin entry ${name} is not a file: ${path}`);
		const canonicalPath = await realpath(path);
		validateCanonicalPackageEntry(metadata.packageDirectory, canonicalPath, name);
		entries[name] = canonicalPath;
	}
	if (Object.keys(entries).length === 0) {
		throw new Error(`Plugin package ${metadata.name} has no configured or conventional entries`);
	}
	return Object.freeze(entries);
}

function validateEntryMapping(name: string, source: string, kind: string): void {
	if (name.length === 0) throw new Error(`Plugin package ${kind} entry name must not be empty`);
	if (source.length === 0) throw new Error(`Plugin package ${kind} entry ${name} must have a source path`);
}

function resolvePackageEntry(packageDirectory: string, source: string, name: string): string {
	if (isAbsolute(source)) throw new Error(`Plugin package entry ${name} must be relative to the package directory`);
	const path = resolve(packageDirectory, source);
	const relativePath = relative(packageDirectory, path);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		throw new Error(`Plugin package entry ${name} escapes the package directory`);
	}
	return path;
}

function validateCanonicalPackageEntry(packageDirectory: string, path: string, name: string): void {
	const relativePath = relative(packageDirectory, path);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`Plugin package entry ${name} resolves outside the package directory`);
	}
}

function isMissingPath(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
