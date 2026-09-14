// Pure-Bun file system and path primitives for the SQLite session backend.
// Replaces the node:fs/promises and node:path surface with Bun APIs
// (Bun.file, Bun.write, Bun.Glob, Bun.$) so the package carries no node:
// imports. Path handling is POSIX-style; the Bun shell builtins (mkdir, rm)
// and the realpath binary cover the operations Bun has no global API for.

/** POSIX-style path join. Accepts any number of segments; the first absolute
 * segment anchors the result and later segments are appended with separators. */
export function joinPath(...segments: Array<string>): string {
	let joined = "";
	for (const segment of segments) {
		if (segment.length === 0) continue;
		joined = joined.length === 0 ? segment : `${joined.replace(/\/+$/, "")}/${segment.replace(/^\/+/, "")}`;
	}
	return joined.length === 0 ? "." : joined;
}

export function dirName(path: string): string {
	const index = path.lastIndexOf("/");
	if (index === -1) return ".";
	if (index === 0) return "/";
	return path.slice(0, index);
}

export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/");
}

/** Path of `to` relative to `from` when `to` lies inside `from` (POSIX, lexical). */
export function relativePath(from: string, to: string): string {
	if (from === to) return "";
	const prefix = from.endsWith("/") ? from : `${from}/`;
	return to.startsWith(prefix) ? to.slice(prefix.length) : to;
}

/** Resolves symlinks via the realpath binary through Bun's shell. */
export async function realPath(path: string): Promise<string> {
	const result = await Bun.$`realpath ${path}`.quiet();
	return (await result.text()).trim();
}

export async function ensureDirectory(directory: string): Promise<void> {
	await Bun.$`mkdir -p ${directory}`.quiet();
}

export async function removeDirectoryTree(directory: string): Promise<void> {
	await Bun.$`rm -rf ${directory}`.quiet();
}

export async function fileExists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
	await Bun.write(path, contents);
}

export async function removeFile(path: string, options: { force: boolean }): Promise<void> {
	if (options.force && !(await Bun.file(path).exists())) return;
	await Bun.file(path).unlink();
}

/** Lists the names of the files directly inside a directory. A missing
 * directory yields an empty list; other errors propagate. */
export async function listDirectoryNames(directory: string): Promise<string[]> {
	try {
		return await Array.fromAsync(new Bun.Glob("*").scan({ cwd: directory, onlyFiles: true }));
	} catch (error) {
		if (isErrorWithCode(error, "ENOENT")) return [];
		throw error;
	}
}

/** Creates a unique temporary directory (with a `.keep` marker) and returns its path. */
export async function createTempDirectory(prefix: string): Promise<string> {
	const root = Bun.env.TMPDIR && Bun.env.TMPDIR.length > 0 ? Bun.env.TMPDIR : "/tmp";
	const directory = joinPath(root, `${prefix}${crypto.randomUUID()}`);
	await writeTextFile(joinPath(directory, ".keep"), "");
	return directory;
}

export function isErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
