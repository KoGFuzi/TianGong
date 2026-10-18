import type { Context } from "@OnePanda-TgSec/chord";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type Dir, type Dirent, type Stats, type WriteStream } from "node:fs";
import {
	access,
	appendFile,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	opendir,
	open as openFile,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamDecoder } from "./decode.ts";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	type FileListEntry,
	type FileListing,
	type FileWatcher,
	type LineScan,
	type ListFilesOptions,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputInfo,
	type TextLine,
	type TextLineReader,
	toError,
	type WatchChange,
	type WatchTarget,
} from "./index.ts";
import { LineScanner } from "./line-scan.ts";
import { NodeFileWatcher, type NodeWatchOptions } from "./node-watch.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const EXIT_STDIO_GRACE_MS = 100;
const SPILL_HIGH_WATER_MARK = 1024 * 1024;
/** Largest single read of a `BinaryReader`, so a huge `length` allocates only as much as the file yields. */
const BINARY_READ_CHUNK = 1024 * 1024;

type SpillChunk = string | Uint8Array;

function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

function resolvePath(cwd: string, path: string): string {
	let normalized = path;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Keep malformed URLs as ordinary paths so filesystem methods preserve their non-throwing contract.
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: basename(path),
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	const nodeError = isNodeError(error) ? error : undefined;
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	if (nodeError) {
		const message = nodeError.message;
		switch (nodeError.code) {
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}

function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	return ok({ shell: "sh", args: ["-c"] });
}

function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	if (!inheritEnv) return { ...extraEnv };
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", () => {});
		} catch {
			// Ignore errors.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

function waitForChildProcess(
	child: ChildProcess,
	spillIsDraining: () => boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finalize = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise({ code: exitCode, signal: exitSignal });
		};
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize();
		};
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => {
				if (spillIsDraining()) armIdleTimer();
				else finalize();
			}, EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
			exitCode = code;
			exitSignal = signal;
			finalize();
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

/** Strict LF reader; Node readline does not report whether its final line was newline-terminated. */
class NodeTextLineReader implements TextLineReader {
	private readonly file: Awaited<ReturnType<typeof openFile>>;
	private readonly path: string;
	private readonly decoder = new StreamDecoder();
	private readonly chunk = new Uint8Array(64 * 1024);
	private byteOffset = 0;
	private buffered = "";
	private ended = false;
	private closed = false;

	constructor(file: Awaited<ReturnType<typeof openFile>>, path: string) {
		this.file = file;
		this.path = path;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));

		try {
			while (true) {
				const newline = this.buffered.indexOf("\n");
				if (newline !== -1) {
					const text = this.buffered.slice(0, newline);
					this.buffered = this.buffered.slice(newline + 1);
					return ok({ text, terminated: true });
				}
				if (this.ended) {
					if (this.buffered.length === 0) return ok(undefined);
					const text = this.buffered;
					this.buffered = "";
					return ok({ text, terminated: false });
				}

				// Explicit positions allow an aborted read to be retried without skipping bytes.
				const { bytesRead } = await this.file.read(this.chunk, 0, this.chunk.length, this.byteOffset);
				const afterReadAbort = abortResult<TextLine | undefined>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				this.byteOffset += bytesRead;
				if (bytesRead === 0) {
					this.buffered += this.decoder.decode();
					this.ended = true;
				} else {
					this.buffered += this.decoder.decode(this.chunk.subarray(0, bytesRead));
				}
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.buffered = "";
		try {
			await this.file.close();
		} catch {
			// Closing is best-effort, including after cancellation or an earlier I/O failure.
		}
	}
}

function closedResult<TValue>(what: string, path: string): Result<TValue, FileError> {
	return err(new FileError("invalid", `${what} is closed`, path));
}

class NodeBinaryReader implements BinaryReader {
	private readonly file: FileHandle;
	private readonly path: string;
	private closed = false;

	constructor(file: FileHandle, path: string) {
		this.file = file;
		this.path = path;
	}

	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const aborted = abortResult<FileInfo>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		try {
			return fileInfoFromStats(this.path, await this.file.stat());
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const aborted = abortResult<Uint8Array>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.path));
		}
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (total < length) {
				const chunk = new Uint8Array(Math.min(length - total, BINARY_READ_CHUNK));
				const { bytesRead } = await this.file.read(chunk, 0, chunk.length, offset + total);
				const afterReadAbort = abortResult<Uint8Array>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				if (bytesRead === 0) break;
				chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
				total += bytesRead;
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
		if (chunks.length === 1) return ok(chunks[0]!);
		const bytes = new Uint8Array(total);
		let position = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, position);
			position += chunk.length;
		}
		return ok(bytes);
	}

	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<LineScan, FileError>> {
		const aborted = abortResult<LineScan>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		let scanner: LineScanner;
		try {
			scanner = new LineScanner(options.startLine, options.endLine);
		} catch {
			return err(new FileError("invalid", "Invalid line range", this.path));
		}
		const chunk = new Uint8Array(64 * 1024);
		try {
			for (let position = 0; ; ) {
				const { bytesRead } = await this.file.read(chunk, 0, chunk.length, position);
				const afterReadAbort = abortResult<LineScan>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				if (bytesRead === 0) return ok(scanner.finish());
				scanner.push(chunk.subarray(0, bytesRead));
				position += bytesRead;
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.file.close().catch(() => undefined);
	}
}

class NodeDirReader implements DirReader {
	private readonly dir: Dir;
	private readonly path: string;
	private done = false;
	private closed = false;

	constructor(dir: Dir, path: string) {
		this.dir = dir;
		this.path = path;
	}

	async next(
		maxEntries: number,
		context: Context,
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const aborted = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Directory reader", this.path);
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.path));
		}
		const entries: FileInfo[] = [];
		try {
			while (!this.done && entries.length < maxEntries) {
				const entry = await this.dir.read();
				if (entry === null) {
					this.done = true;
					break;
				}
				const loopAbort = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.path);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(this.path, entry.name);
				let stats: Stats;
				try {
					stats = await lstat(entryPath);
				} catch (error) {
					// Removed between enumeration and lstat: not part of the listing any more.
					if (isNodeError(error) && error.code === "ENOENT") continue;
					return err(toFileError(error, entryPath));
				}
				const info = fileInfoFromStats(entryPath, stats);
				if (info.ok) entries.push(info.value);
			}
			return ok({ entries, done: this.done });
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.dir.close().catch(() => undefined);
	}
}

function symlinkRefused(path: string, cause?: Error): FileError {
	return new FileError("invalid", "Refusing to follow a symbolic link", path, cause);
}

/** The bounds of `NodeExecutionEnv.listFiles`. */
const LIST_FILES_MAX_ENTRIES = 50_000;
const LIST_FILES_DEFAULT_BYTES = 4 * 1024 * 1024;
/** The interface bound of `ListFilesOptions.maxBytes`, 15.9 MiB of listing text. */
const LIST_FILES_MAX_BYTES = 16_672_358;
const LIST_FILES_TIMEOUT_MS = 10_000;

/** Consequence of an `.gitignore` rule, or of the pattern of a negation. */
type IgnorePattern = {
	readonly negate: boolean;
	/** Only directories match, for a pattern with a trailing `/`. */
	readonly dirOnly: boolean;
	/** Matched against the whole path below its directory, not only against the last segment. */
	readonly anchored: boolean;
	/** `/`-separated glob segments; `*` and `?` within one, `**` across several. */
	readonly segments: readonly string[];
};

/** The rules of one directory: its `.gitignore`, and, at the work tree's root, the excludes and the global file. */
type IgnoreRules = readonly IgnorePattern[];

/** Parses the rules of one git-ignores file: comments and blank lines out, negations and directories marked. */
function parseIgnoreRules(content: string): IgnoreRules {
	const patterns: IgnorePattern[] = [];
	for (const rawLine of content.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "" || line.startsWith("#")) continue;
		const negate = line.startsWith("!");
		const body = negate ? line.slice(1) : line;
		if (body === "") continue;
		const dirOnly = body.endsWith("/");
		const withoutSlash = dirOnly ? body.slice(0, -1) : body;
		if (withoutSlash === "") continue;
		const anchored = withoutSlash.includes("/");
		patterns.push({
			negate,
			dirOnly,
			anchored,
			segments: withoutSlash.split("/"),
		});
	}
	return patterns;
}

/** Shell glob of one path segment: `*` matches any run of it, `?` exactly one character. */
function segmentGlob(pattern: string, value: string): boolean {
	// One asterisk stretch per backtracking loop, indexes instead of allocation: patterns repeat per entry.
	let p = 0;
	let v = 0;
	let star = -1;
	let starValue = -1;
	while (v < value.length) {
		if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
			p++;
			v++;
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p++;
			starValue = v;
		} else if (star !== -1) {
			p = star + 1;
			v = ++starValue;
		} else return false;
	}
	while (p < pattern.length && pattern[p] === "*") p++;
	return p === pattern.length;
}

/** `path` glob of one pattern: equal segment counts, with a `**` segment as any run of directories. */
function patternGlob(pattern: readonly string[], value: readonly string[]): boolean {
	if (value[0] === undefined) return pattern.length === 0 || (pattern.length === 1 && pattern[0] === "**");
	if (pattern.length === 0) return false;
	if (pattern[0] === "**") {
		for (let skip = 0; skip <= value.length; skip++) {
			if (patternGlob(pattern.slice(1), value.slice(skip))) return true;
		}
		return false;
	}
	return segmentGlob(pattern[0]!, value[0]) && patternGlob(pattern.slice(1), value.slice(1));
}

/**
 * Whether git would ignore `path` (the segments from the work tree's root; the last one is the entry): the deepest
 * directory with a rule for it decides, and within that directory the last matching rule. The `rules` array is sparse,
 * indexed by the depth of each directory below the work tree's root; unset levels hold no rules.
 */
function ignoreDecides(rules: readonly IgnoreRules[], path: readonly string[], isDir: boolean): boolean {
	for (let level = path.length - 1; level >= 0; level--) {
		const directory = rules[level];
		if (directory === undefined) continue;
		const below = path.slice(level);
		const name = below[below.length - 1]!;
		let decided: boolean | undefined;
		for (const pattern of directory) {
			const matches =
				(!pattern.dirOnly || isDir) &&
				(pattern.anchored ? patternGlob(pattern.segments, below) : segmentGlob(pattern.segments[0]!, name));
			if (matches) decided = !pattern.negate;
		}
		if (decided !== undefined) return decided;
	}
	return false;
}

/**
 * The rules of one git-ignores file, parsed; empty when the file is missing or unreadable.
 */
async function readIgnoreRules(file: string): Promise<IgnoreRules> {
	try {
		return parseIgnoreRules(await readFile(file, "utf8"));
	} catch {
		return [];
	}
}

/** The global excludes file: `XDG_CONFIG_HOME/git/ignore` with the default config directory in its place. */
function globalExcludesFile(): string {
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore");
}

/** The OS path of a relative path as `/`-separated segments, empty and duplicate parts out. */
function workPathSegments(path: string): readonly string[] {
	return path.split(/[/\\]+/).filter((part) => part !== "");
}

/** Sentinel thrown out of the walk when the caller aborted; never escapes `listFiles`. */
const ListAborted = Symbol("list files aborted");

export class NodeExecutionEnv implements ExecutionEnv {
	/** Every local environment sees the same files. */
	readonly id: string = "node:local";
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;
	private watchOptions: NodeWatchOptions;
	private activeChildPids = new Set<number>();

	constructor(options: {
		cwd: string;
		shellPath?: string;
		shellEnv?: NodeJS.ProcessEnv;
		watch?: NodeWatchOptions;
	}) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
		this.watchOptions = options.watch ?? {};
	}

	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const aborted = abortResult<FileWatcher>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const watcher = await NodeFileWatcher.open(
				targets,
				(path) => resolvePath(this.cwd, path),
				onChange,
				this.watchOptions,
			);
			const afterOpenAbort = abortResult<FileWatcher>(context.abortSignal);
			if (afterOpenAbort) {
				await watcher.close(context);
				return afterOpenAbort;
			}
			return ok(watcher);
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		// A string runs through the shell; an argv array runs its program directly, without shell parsing.
		let program: string;
		let args: readonly string[];
		let stdinCommand: string | undefined;
		if (typeof command === "string") {
			const shellConfig = await getShellConfig(this.shellPath);
			if (!shellConfig.ok) return shellConfig;
			const commandFromStdin = shellConfig.value.commandTransport === "stdin";
			program = shellConfig.value.shell;
			args = commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command];
			stdinCommand = commandFromStdin ? command : undefined;
		} else {
			const [first, ...rest] = command;
			if (first === undefined) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
			program = first;
			args = rest;
		}
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cause,
				),
			);
		}

		return await new Promise((resolvePromise) => {
			let settled = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let spillError: ExecutionError | undefined;
			let child: ReturnType<typeof spawn> | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const spillPrefix: SpillChunk[] = [];
			let spillPath: string | undefined;
			const spillQueue: SpillChunk[] = [];
			let spillStart: Promise<void> | undefined;
			let spillStream: WriteStream | undefined;
			let spillBackpressured = false;

			const onAbort = () => {
				if (child?.pid) killProcessTree(child.pid);
			};
			const failCallback = (error: unknown) => {
				if (callbackError !== undefined) return;
				const cause = toError(error);
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				onAbort();
			};
			// One decoder per stream, so a character split across chunks of one stream survives interleaving.
			const stdoutDecoder = new StreamDecoder();
			const stderrDecoder = new StreamDecoder();
			// No output reaches the caller after exec() settled, for example from a descendant holding stdio open.
			const emit = (text: string, stream: ShellOutputInfo["stream"]): void => {
				if (settled || text === "" || options?.onOutput === undefined || callbackError !== undefined) return;
				try {
					options.onOutput(text, context, { stream });
				} catch (error) {
					failCallback(error);
				}
			};
			// Output seen before the spill starts: counted against the thresholds and kept for the spill's prefix.
			let seenBytes = 0;
			let seenNewlines = 0;

			const settle = (result: Result<ShellExecResult, ExecutionError>) => {
				if (settled) return;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				if (signal) signal.removeEventListener("abort", onAbort);
				if (child?.pid) this.activeChildPids.delete(child.pid);
				resolvePromise(result);
			};
			const pauseOutput = () => {
				child?.stdout?.pause();
				child?.stderr?.pause();
			};
			const resumeOutput = () => {
				if (callbackError || spillError || timedOut || signal?.aborted || spillBackpressured) return;
				child?.stdout?.resume();
				child?.stderr?.resume();
			};
			const failSpill = (error: unknown) => {
				if (spillError !== undefined) return;
				const cause = toError(error);
				spillError = new ExecutionError(
					"unknown",
					`Failed to preserve complete shell output: ${cause.message}`,
					cause,
				);
				spillBackpressured = false;
				onAbort();
			};
			const writeSpill = (chunk: SpillChunk): void => {
				if (spillStream === undefined || chunk.length === 0) return;
				if (spillStream.write(chunk) || spillBackpressured) return;
				spillBackpressured = true;
				pauseOutput();
				spillStream.once("drain", () => {
					spillBackpressured = false;
					resumeOutput();
				});
			};
			const startSpill = (chunk: SpillChunk): void => {
				if (spillStream !== undefined) {
					writeSpill(chunk);
					return;
				}
				spillQueue.push(chunk);
				if (spillStart !== undefined) return;
				pauseOutput();
				spillStart = (async () => {
					const created = await this.createTempFile({ prefix: "tg-output-", suffix: ".log" }, context);
					if (!created.ok) throw created.error;
					spillPath = created.value;
					spillStream = createWriteStream(spillPath, { flags: "a", highWaterMark: SPILL_HIGH_WATER_MARK });
					spillStream.on("error", failSpill);
					for (const queued of spillQueue) writeSpill(queued);
					spillQueue.length = 0;
				})()
					.catch(failSpill)
					.finally(resumeOutput);
			};
			const finishSpill = async (): Promise<void> => {
				await spillStart;
				const stream = spillStream;
				if (stream === undefined || spillError !== undefined || stream.destroyed) return;
				await new Promise<void>((resolveFinish) => {
					stream.once("error", () => resolveFinish());
					stream.once("finish", resolveFinish);
					stream.end();
				});
			};

			try {
				child = spawn(program, args, {
					cwd,
					detached: process.platform !== "win32",
					env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
					stdio: [stdinCommand === undefined ? "ignore" : "pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				if (child.pid) this.activeChildPids.add(child.pid);
				if (stdinCommand !== undefined) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(stdinCommand);
				}
			} catch (error) {
				const cause = toError(error);
				settle(err(new ExecutionError("spawn_error", cause.message, cause)));
				return;
			}

			timeoutId =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							onAbort();
						}, timeoutMs);

			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			const feed = (source: ShellOutputInfo["stream"], decoder: StreamDecoder) => (chunk: Uint8Array) => {
				emit(decoder.decode(chunk), source);
				const spill = options?.spill;
				if (spill === undefined || chunk.length === 0) return;
				if (spillStart !== undefined) {
					startSpill(chunk);
					return;
				}
				seenBytes += chunk.length;
				for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) seenNewlines++;
				const lines = seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
				if (seenBytes <= spill.afterBytes && lines <= spill.afterLines) {
					spillPrefix.push(chunk);
					return;
				}
				for (const prefix of spillPrefix) startSpill(prefix);
				spillPrefix.length = 0;
				startSpill(chunk);
			};
			child.stdout?.on("data", feed("stdout", stdoutDecoder));
			child.stderr?.on("data", feed("stderr", stderrDecoder));

			void waitForChildProcess(
				child,
				() =>
					spillError === undefined &&
					spillStart !== undefined &&
					(spillStream === undefined || spillBackpressured),
			).then(
				async ({ code, signal: exitSignal }) => {
					await finishSpill();
					emit(stdoutDecoder.decode(), "stdout");
					emit(stderrDecoder.decode(), "stderr");
					if (callbackError) {
						settle(err(callbackError));
						return;
					}
					const interrupted = timedOut
						? new ExecutionError("timeout", `timeout:${options?.timeout}`)
						: signal?.aborted
							? new ExecutionError("aborted", "aborted")
							: undefined;
					if (interrupted !== undefined) {
						if (spillPath !== undefined) interrupted.spillPath = spillPath;
						settle(err(interrupted));
						return;
					}
					if (spillError) {
						settle(err(spillError));
						return;
					}
					// A process killed by a signal (e.g. OOM killer) has no exit code; map it
					// to the conventional 128 + signal number so callers do not mistake it
					// for a successful exit.
					const exitCode = code ?? (exitSignal ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1);
					settle(ok({ exitCode, ...(spillPath === undefined ? {} : { spillPath }) }));
				},
				(error: Error) => settle(err(new ExecutionError("spawn_error", error.message, error))),
			);
		});
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<TextLineReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const file = await openFile(resolved, "r");
			const afterOpenAbort = abortResult<TextLineReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await file.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeTextLineReader(file, resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<string>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<Uint8Array>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<BinaryReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		const noFollow = options?.noFollow === true;
		let file: FileHandle | undefined;
		try {
			let flags = constants.O_RDONLY;
			if (process.platform === "win32") {
				// Windows has no O_NOFOLLOW; check the final component before opening (not race-free).
				if (noFollow && (await lstat(resolved)).isSymbolicLink()) return err(symlinkRefused(resolved));
			} else {
				// Nonblocking, so opening a FIFO does not wait for a writer.
				flags |= constants.O_NONBLOCK;
				if (noFollow) flags |= constants.O_NOFOLLOW;
			}
			file = await openFile(resolved, flags);
			const stats = await file.stat();
			if (!stats.isFile()) {
				await file.close().catch(() => undefined);
				return err(
					stats.isDirectory()
						? new FileError("is_directory", "EISDIR: illegal operation on a directory, read", resolved)
						: new FileError("invalid", "Not a regular file", resolved),
				);
			}
			const afterOpenAbort = abortResult<BinaryReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await file.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeBinaryReader(file, resolved));
		} catch (error) {
			await file?.close().catch(() => undefined);
			// O_NOFOLLOW reports a final-component symlink as ELOOP (EMLINK on some BSDs).
			if (noFollow && isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
				return err(symlinkRefused(resolved, toError(error)));
			}
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await appendFile(resolved, content);
			const afterAppendAbort = abortResult<void>(signal, resolved);
			return afterAppendAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		if (!Number.isSafeInteger(size) || size < 0) {
			return err(new FileError("invalid", "File size must be a non-negative safe integer", resolved));
		}
		let file: Awaited<ReturnType<typeof openFile>> | undefined;
		try {
			file = await openFile(resolved, "r+");
			await file.truncate(size);
			const afterTruncateAbort = abortResult<void>(signal, resolved);
			return afterTruncateAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			await file?.close().catch(() => undefined);
		}
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		let file: Awaited<ReturnType<typeof openFile>> | undefined;
		try {
			file = await openFile(resolved, "r+");
			// POSIX refuses to open a directory for writing; Windows opens it, so check explicitly.
			if ((await file.stat()).isDirectory()) return err(new FileError("is_directory", "Is a directory", resolved));
			await file.sync();
			const afterSyncAbort = abortResult<void>(signal, resolved);
			return afterSyncAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			await file?.close().catch(() => undefined);
		}
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = resolvePath(this.cwd, sourcePath);
		const destination = resolvePath(this.cwd, destinationPath);
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await rename(source, destination);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<FileInfo[]>(signal, resolved);
		if (aborted) return aborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(signal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<DirReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const dir = await opendir(resolved);
			const afterOpenAbort = abortResult<DirReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await dir.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeDirReader(dir, resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listFiles(
		path: string,
		options: ListFilesOptions | undefined,
		context: Context,
	): Promise<Result<FileListing, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileListing>(context.abortSignal, resolved);
		if (aborted) return aborted;
		const maxEntries = options?.maxEntries ?? LIST_FILES_MAX_ENTRIES;
		const maxBytes = Math.min(options?.maxBytes ?? LIST_FILES_DEFAULT_BYTES, LIST_FILES_MAX_BYTES);
		const timeoutMs = options?.timeoutMs ?? LIST_FILES_TIMEOUT_MS;
		if (
			!Number.isSafeInteger(maxEntries) ||
			maxEntries < 0 ||
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 0 ||
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 0
		) {
			return err(new FileError("invalid", "listFiles bounds must be non-negative safe integers", resolved));
		}
		const deadline = Date.now() + timeoutMs;
		const encoder = new TextEncoder();
		const hidden = options?.hidden ?? true;
		const excluded = new Set(options?.exclude ?? []);
		const entries: FileListEntry[] = [];
		let bytes = 0;
		let truncated = false;
		try {
			const root = await realpath(resolved);
			// Ignore rules count only inside a git work tree, the walk from the listed directory up to whose `.git`.
			let workRoot: string | undefined;
			for (let dir = root; ; ) {
				if (await pathExists(join(dir, ".git"))) {
					workRoot = dir;
					break;
				}
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
			const respectsGitignore = (options?.gitignore ?? true) && workRoot !== undefined;
			const listedRoot = respectsGitignore ? workPathSegments(relative(workRoot!, root)) : [];
			// `rules[level]` holds the rules of the work-tree directory `level` steps in. One directory occupies each
			// level while the walk descends, so the sparse array stays coherent for the whole listing.
			const rules: IgnoreRules[] = [];
			if (respectsGitignore) {
				// Inside the work tree's root, git orders global excludes, then `.git/info/exclude`, then `.gitignore`.
				rules[0] = [
					...(await readIgnoreRules(globalExcludesFile())),
					...(await readIgnoreRules(join(workRoot!, ".git", "info", "exclude"))),
					...(await readIgnoreRules(join(workRoot!, ".gitignore"))),
				];
				// The directories between the work tree's root and the listed one are never entered; their rules first.
				for (let level = 1; level < listedRoot.length; level++) {
					const found = await readIgnoreRules(join(workRoot!, ...listedRoot.slice(0, level), ".gitignore"));
					if (found.length > 0) rules[level] = found;
				}
			}
			// One directory of the walk: false keeps going, true stopped because a bound ran out (`truncated` was set).
			const walk = async (absoluteDir: string, segments: readonly string[], level: number): Promise<boolean> => {
				if (respectsGitignore && level > 0) {
					const own = await readIgnoreRules(join(workRoot!, ...listedRoot, ...segments, ".gitignore"));
					if (own.length > 0) rules[level] = own;
				}
				// The listed directory's failure is the listing's error; a child's means a skipped subtree.
				let dirents: Dirent[] | undefined;
				if (level === 0) dirents = await readdir(absoluteDir, { withFileTypes: true });
				else {
					dirents = await readdir(absoluteDir, { withFileTypes: true }).catch(() => undefined);
					if (dirents === undefined) return false;
				}
				if (dirents === undefined) return false;
				const named = dirents.map((entry) => ({ entry, bytes: encoder.encode(entry.name) }));
				// Siblings in byte order of their names.
				named.sort((first, second) => {
					const common = Math.min(first.bytes.length, second.bytes.length);
					for (let index = 0; index < common; index++) {
						if (first.bytes[index] !== second.bytes[index]) return first.bytes[index]! - second.bytes[index]!;
					}
					return first.bytes.length - second.bytes.length;
				});
				for (const listing of named) {
					if (context.abortSignal?.aborted) throw ListAborted;
					const name = listing.entry.name;
					if (name === ".git" || (!hidden && name.startsWith(".")) || excluded.has(name)) continue;
					const kind: FileKind | undefined = listing.entry.isDirectory()
						? "directory"
						: listing.entry.isFile()
							? "file"
							: listing.entry.isSymbolicLink()
								? "symlink"
								: undefined;
					// Unsupported kinds are not listed; symlinks are listed and neither followed nor descended into.
					if (kind === undefined) continue;
					if (
						respectsGitignore &&
						ignoreDecides(rules, [...listedRoot, ...segments, name], kind === "directory")
					) {
						continue;
					}
					// Budgets are checked before an entry is emitted, so a listing that fits exactly is not truncated.
					if (
						entries.length + 1 > maxEntries ||
						bytes + listing.bytes.length + 2 > maxBytes ||
						Date.now() >= deadline
					) {
						truncated = true;
						return true;
					}
					const relativePath = segments.length === 0 ? name : [...segments, name].join("/");
					entries.push({ path: relativePath, kind });
					bytes += listing.bytes.length + 2;
					if (kind === "directory" && (await walk(join(absoluteDir, name), [...segments, name], level + 1))) {
						return true;
					}
				}
				return false;
			};
			await walk(root, [], listedRoot.length);
			return ok({ entries, truncated });
		} catch (error) {
			if (error === ListAborted) return err(new FileError("aborted", "aborted", resolved));
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			prefix ??= "tmp-";
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async cleanup(_context: Context): Promise<void> {
		for (const pid of this.activeChildPids) killProcessTree(pid);
		this.activeChildPids.clear();
	}
}

export type { NodeWatchOptions } from "./node-watch.ts";
