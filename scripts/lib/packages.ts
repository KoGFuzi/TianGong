import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the TianGong workspace root. */
export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The npm scope every house package publishes under. */
export const HOUSE_SCOPE = "@OnePanda-TgSec";

/** House packages whose name carries the `tg-` prefix. `chord` is the one house package without it. */
export const HOUSE_NAMES = [
	"@OnePanda-TgSec/tg-agent-core",
	"@OnePanda-TgSec/tg-ai",
	"@OnePanda-TgSec/chord",
	"@OnePanda-TgSec/tg-gibraltar",
	"@OnePanda-TgSec/tg-telemetry",
	"@OnePanda-TgSec/tg-tui",
] as const;

/**
 * Packages migrated verbatim from the pi agent project. Their manifest, source, and public
 * names stay exactly as upstream published them; only the workspace that hosts them is ours.
 * See `docs/provenance.md` for the full statement.
 */
export const VENDORED_PACKAGES = {
	"@earendil-works/pi-codemode": {
		directory: "packages/codemode",
		version: "1.0.1",
		upstreamProject: "pi agent",
		upstreamPackage: "@earendil-works/pi-codemode",
		upstreamRepository: "https://github.com/earendil-works/pi",
		upstreamDirectory: "packages/codemode",
		upstreamAuthor: "Earendil Works",
		role: "QuickJS/WASI sandbox where the only capability is calling injected tools",
		adopted: "2026-10-04",
	},
	"@earendil-works/pi-mcp": {
		directory: "packages/mcp",
		version: "1.0.1",
		upstreamProject: "pi agent",
		upstreamPackage: "@earendil-works/pi-mcp",
		upstreamRepository: "https://github.com/earendil-works/pi",
		upstreamDirectory: "packages/mcp",
		upstreamAuthor: "Earendil Works",
		role: "Standalone Model Context Protocol client, transports, and OAuth subset",
		adopted: "2026-10-04",
	},
} as const;

export type VendoredPackageName = keyof typeof VENDORED_PACKAGES;

/** Every specifier a house package is allowed to borrow from the vendored upstream set. */
export const VENDORED_SPECIFIERS: readonly string[] = Object.keys(VENDORED_PACKAGES);

/**
 * Upstream names that house packages used before adoption. House **code** may not import them;
 * house **documentation** may, because a changelog entry and a provenance section have to name
 * what the package was called before. Each one appears in the mapping table in `docs/provenance.md`.
 */
export const FORMER_SPECIFIERS = {
	"@earendil-works/pi-ai": "@OnePanda-TgSec/tg-ai",
	"@earendil-works/chord": "@OnePanda-TgSec/chord",
	"@earendil-works/pi-durable": "@OnePanda-TgSec/tg-gibraltar",
	"@earendil-works/pi-tui": "@OnePanda-TgSec/tg-tui",
	"@earendil-works/pi-telemetry": "@OnePanda-TgSec/tg-telemetry",
	"@earendil-works/pi-agent-core": "@OnePanda-TgSec/tg-agent-core",
} as const;

/** Specifiers house code may import: our own packages plus the two vendored ones. */
export const ALLOWED_HOUSE_SPECIFIERS: readonly string[] = [...HOUSE_NAMES, ...VENDORED_SPECIFIERS];

export type PackageOrigin = "house" | "vendored";

const MANIFEST_SUFFIX = "/package.json";

export interface WorkspacePackage {
	/** Path relative to the repo root, e.g. `packages/ai`. */
	directory: string;
	/** Absolute path of the package directory. */
	path: string;
	/** Absolute path of the package manifest. */
	manifestPath: string;
	name: string;
	version: string;
	origin: PackageOrigin;
	manifest: Record<string, unknown>;
}

interface Manifest {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	[key: string]: unknown;
}

/** Reads every package manifest one directory level below `packages`, in sorted order. */
export async function listPackages(root: string = repoRoot()): Promise<WorkspacePackage[]> {
	const packagesDirectory = resolve(root, "packages");
	const entries = [...new Bun.Glob(`*${MANIFEST_SUFFIX}`).scanSync({ cwd: packagesDirectory })].sort();
	const packages: WorkspacePackage[] = [];

	for (const entry of entries) {
		const manifestPath = resolve(packagesDirectory, entry);
		const manifest = (await Bun.file(manifestPath).json()) as Manifest;
		const name = manifest.name ?? "";
		if (!name) throw new Error(`${entry} has no "name"`);
		packages.push({
			directory: `packages/${entry.slice(0, entry.length - MANIFEST_SUFFIX.length)}`,
			path: resolve(packagesDirectory, entry.slice(0, entry.length - MANIFEST_SUFFIX.length)),
			manifestPath,
			name,
			version: manifest.version ?? "0.0.0",
			origin: name in VENDORED_PACKAGES ? "vendored" : "house",
			manifest: manifest as Record<string, unknown>,
		});
	}

	return packages;
}

/** Workspace package names a package declares as a runtime dependency. */
export function workspaceDependencies(pkg: WorkspacePackage, packages: WorkspacePackage[]): string[] {
	const manifest = pkg.manifest as Manifest;
	const declared = { ...manifest.dependencies, ...manifest.peerDependencies };
	const byName = new Map(packages.map((candidate) => [candidate.name, candidate]));
	return Object.keys(declared)
		.filter((name) => byName.has(name))
		.map((name) => byName.get(name)!.directory);
}

/**
 * Dependency-first package order via depth-first topological sort. Cycles are reported
 * instead of silently dropping a package.
 */
export function buildOrder(packages: WorkspacePackage[]): WorkspacePackage[] {
	const byDirectory = new Map(packages.map((pkg) => [pkg.directory, pkg]));
	const state = new Map<string, "visiting" | "done">();
	const ordered: WorkspacePackage[] = [];
	const path: string[] = [];

	const visit = (pkg: WorkspacePackage): void => {
		const status = state.get(pkg.directory);
		if (status === "done") return;
		if (status === "visiting") {
			throw new Error(`Dependency cycle: ${[...path, pkg.directory].join(" -> ")}`);
		}
		state.set(pkg.directory, "visiting");
		path.push(pkg.directory);
		for (const dependency of workspaceDependencies(pkg, packages).sort()) {
			visit(byDirectory.get(dependency)!);
		}
		path.pop();
		state.set(pkg.directory, "done");
		ordered.push(pkg);
	};

	for (const pkg of [...packages].sort((a, b) => a.directory.localeCompare(b.directory))) visit(pkg);
	return ordered;
}

/** Runs a Bun script inside a package, streaming its output, and exits the process on failure. */
export async function runInPackage(pkg: WorkspacePackage, script: string, args: string[] = []): Promise<void> {
	process.stdout.write(`\n[1m> ${pkg.name}: bun run ${[script, ...args].join(" ")}[0m\n`);
	const proc = Bun.spawn(["bun", "run", script, ...args], {
		cwd: pkg.path,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		process.stderr.write(`\n[31m${pkg.name}: "bun run ${script}" failed with exit code ${exitCode}[0m\n`);
		process.exit(exitCode);
	}
}
