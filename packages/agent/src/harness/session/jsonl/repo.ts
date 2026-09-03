import { Effect } from "effect";
import { uuidv7 } from "@onepanda-tiangongsec/tg-ai";
import { assertJsonSerializable, Session } from "../session.ts";
import {
	type ForkOptions,
	SessionError,
	type SessionMetadata,
	type SessionRepo,
} from "../types.ts";
import { metadataFromHeader, parseHeader } from "./codec.ts";
import { fileResult } from "./errors.ts";
import { JsonlSessionStorage } from "./storage.ts";
import type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoFileSystem,
	JsonlSessionRepoOptions,
	JsonlV4Header,
} from "./types.ts";

function effectStorage(storage: JsonlSessionStorage) {
	return new Proxy(storage, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const result = (value as (...a: unknown[]) => unknown).apply(target, args);
				if (Effect.isEffect(result)) return result;
				return Effect.promise(async () => result);
			};
		},
	}) as unknown as import("../types.ts").SessionStorage<JsonlSessionMetadata>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function validateSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new SessionError(
			"invalid_payload",
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

function rethrowAsUnknown(e: unknown): never {
	throw e;
}

const passthroughCatch = (e: unknown): never => { throw e; };
const noError: never = undefined as never;
const ignoreError = (_e: unknown): never => { throw undefined as never; };
const rethrow = (e: unknown): never => { throw e; };

function jsonlSessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

async function jsonlSessionsRoot(options: JsonlSessionRepoOptions): Promise<string> {
	return fileResult(
		await options.fs.absolutePath(options.sessionsRoot),
		`Failed to resolve sessions root ${options.sessionsRoot}`,
	);
}

async function jsonlSessionDirectory(
	fs: JsonlSessionRepoFileSystem,
	sessionsRoot: string,
	cwd: string,
): Promise<string> {
	return fileResult(
		await fs.joinPath([sessionsRoot, jsonlSessionDirectoryName(cwd)]),
		`Failed to resolve sessions directory for ${cwd}`,
	);
}

async function jsonlSessionDirectories(options: JsonlSessionRepoOptions, cwd?: string): Promise<string[]> {
	const sessionsRoot = await jsonlSessionsRoot(options);
	if (cwd !== undefined) {
		const resolvedCwd = fileResult(await options.fs.absolutePath(cwd), `Failed to resolve session cwd ${cwd}`);
		const directory = await jsonlSessionDirectory(options.fs, sessionsRoot, resolvedCwd);
		return fileResult(await options.fs.exists(directory), `Failed to check sessions directory ${directory}`)
			? [directory]
			: [];
	}
	if (!fileResult(await options.fs.exists(sessionsRoot), `Failed to check sessions directory ${sessionsRoot}`))
		return [];
	return fileResult(await options.fs.listDir(sessionsRoot), `Failed to list sessions directory ${sessionsRoot}`)
		.filter((entry) => entry.kind === "directory" || entry.kind === "symlink")
		.map((entry) => entry.path);
}

export async function listJsonlSessionMetadata(
	options: JsonlSessionRepoOptions,
	query: JsonlSessionListOptions = {},
): Promise<JsonlSessionMetadata[]> {
	const metadata: JsonlSessionMetadata[] = [];
	for (const directory of await jsonlSessionDirectories(options, query.cwd)) {
		const files = fileResult(
			await options.fs.listDir(directory),
			`Failed to list sessions directory ${directory}`,
		).filter((entry) => entry.kind !== "directory" && entry.name.endsWith(".jsonl"));
		for (const file of files) {
			const [firstLine] = fileResult(
				await options.fs.readTextLines(file.path, { maxLines: 1 }),
				`Failed to read session header ${file.path}`,
			);
			if (!firstLine) continue;
			const headerResult = parseHeader(firstLine);
			if (!headerResult.ok) continue;
			metadata.push(metadataFromHeader(headerResult.value, file.path, file.mtimeMs));
		}
	}
	return metadata.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

async function loadJsonlSessionStorage(
	options: JsonlSessionRepoOptions,
	metadata: JsonlSessionMetadata,
): Promise<JsonlSessionStorage> {
	if (!fileResult(await options.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
		throw new SessionError("not_found", `Session not found: ${metadata.id}`);
	}
	const storage = await JsonlSessionStorage.load(options.fs, metadata.path);
	const loadedMetadata = await Effect.runPromise(
		storage.getMetadata() as Effect.Effect<JsonlSessionMetadata, never>,
	);
	if (loadedMetadata.id !== metadata.id) {
		throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
	}
	return storage;
}

export { loadJsonlSessionStorage };

function sessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${id}.jsonl`;
}

export class JsonlSessionRepo
	implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private readonly activeCreateDestinations = new Set<string>();
	private rootPromise: Promise<string> | undefined;

	constructor(options: JsonlSessionRepoOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	create(options: JsonlSessionCreateOptions): Effect.Effect<Session<JsonlSessionMetadata>, SessionError> {
		const self = this;
		return Effect.flatMap(
			Effect.tryPromise({
				try: () => self.resolveCreateDestination(options),
				catch: rethrow,
			}),
			(destination) => {
				const key = `${destination.cwd}\0${destination.id}`;
				if (this.activeCreateDestinations.has(key)) {
					return Effect.fail(new SessionError("already_exists", `Session already exists: ${destination.id}`));
				}
				this.activeCreateDestinations.add(key);
				return Effect.flatMap(
					Effect.tryPromise({
						try: () => this.prepareCreate(destination, options),
						catch: rethrow,
					}),
					(prepared) =>
						Effect.flatMap(
							Effect.tryPromise({
								try: () => JsonlSessionStorage.create(this.fs, prepared.path, prepared.header),
								catch: (e) => {
									this.activeCreateDestinations.delete(key);
									return e as never;
								},
							}),
							(storage) =>
								Effect.flatMap(
									Effect.tryPromise({
										try: () => Effect.runPromise(storage.getMetadata() as Effect.Effect<JsonlSessionMetadata, never>),
										catch: rethrow,
									}),
									(metadata) => {
										this.activeCreateDestinations.delete(key);
										return Effect.succeed(new Session(effectStorage(storage), { metadata }));
									},
								),
						),
				);
			},
		);
	}

	open(metadata: JsonlSessionMetadata): Effect.Effect<Session<JsonlSessionMetadata>> {
		return Effect.tryPromise({
			try: () => loadJsonlSessionStorage({ fs: this.fs, sessionsRoot: this.sessionsRootInput }, metadata),
			catch: (e: unknown) => e as never,
		}).pipe(Effect.map((storage) => new Session(effectStorage(storage as unknown as JsonlSessionStorage), { metadata })));
	}

	list(options: JsonlSessionListOptions = {}): Effect.Effect<JsonlSessionMetadata[]> {
		return Effect.tryPromise({
			try: () => this.listDirect(options),
			catch: (e: unknown) => e as never,
		});
	}

	delete(metadata: JsonlSessionMetadata): Effect.Effect<void> {
		return Effect.tryPromise({
			try: async () => {
				const result = await this.fs.remove(metadata.path, { force: true });
				fileResult(result, `Failed to delete session ${metadata.path}`);
			},
			catch: (e: unknown) => e as never,
		});
	}

	fork(
		source: JsonlSessionMetadata,
		options: ForkOptions & JsonlSessionCreateOptions,
	): Effect.Effect<Session<JsonlSessionMetadata>, SessionError> {
		const createOptions = {
			...options,
			parentSessionId: options.parentSessionId ?? source.id,
		};
		return Effect.flatMap(
			Effect.tryPromise({ try: () => this.resolveCreateDestination(createOptions), catch: rethrow }),
			(destination) => {
				const key = `${destination.cwd}\0${destination.id}`;
				if (this.activeCreateDestinations.has(key)) {
					return Effect.fail(new SessionError("already_exists", `Session already exists: ${destination.id}`));
				}
				this.activeCreateDestinations.add(key);
				return Effect.flatMap(
					Effect.tryPromise({ try: () => this.prepareCreate(destination, createOptions), catch: rethrow }),
					(prepared) =>
						Effect.flatMap(
							Effect.tryPromise({ try: () => this.loadStorage(source), catch: rethrow }),
							(sourceStorage) =>
								Effect.flatMap(
									Effect.tryPromise({
										try: () => sourceStorage.fork(prepared.path, prepared.header, options),
										catch: (e) => {
											this.activeCreateDestinations.delete(key);
											return e as never;
										},
									}),
									(storage) =>
										Effect.flatMap(
											Effect.tryPromise({
												try: () => Effect.runPromise(storage.getMetadata() as Effect.Effect<JsonlSessionMetadata, never>),
												catch: rethrow,
											}),
											(metadata) => {
												this.activeCreateDestinations.delete(key);
												return Effect.succeed(new Session(effectStorage(storage), { metadata }));
											},
										),
								),
						),
				);
			},
		);
	}

	private async loadStorage(metadata: JsonlSessionMetadata): Promise<JsonlSessionStorage> {
		return loadJsonlSessionStorage({ fs: this.fs, sessionsRoot: this.sessionsRootInput }, metadata);
	}

	private async resolveCreateDestination(options: JsonlSessionCreateOptions): Promise<{ id: string; cwd: string }> {
		const id = options.id ?? uuidv7();
		validateSessionId(id);
		const cwd = fileResult(await this.fs.absolutePath(options.cwd), `Failed to resolve session cwd ${options.cwd}`);
		return { id, cwd };
	}

	private async prepareCreate(
		destination: { id: string; cwd: string },
		options: JsonlSessionCreateOptions,
	): Promise<{
		header: JsonlV4Header;
		path: string;
	}> {
		const { id, cwd } = destination;
		if (await this.sessionIdExists(id, cwd)) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}

		const createdAt = Date.now();
		const sessionDirectory = await this.sessionDirectory(cwd);
		const path = fileResult(
			await this.fs.joinPath([sessionDirectory, sessionFileName(createdAt, id)]),
			`Failed to resolve path for session ${id}`,
		);
		if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id,
			createdAt,
			cwd,
			parentSessionId: options.parentSessionId,
			metadata: options.metadata,
		};
		fileResult(await this.fs.createDir(sessionDirectory, { recursive: true }), `Failed to create sessions directory`);
		return { header, path };
	}

	private async listDirect(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		return listJsonlSessionMetadata({ fs: this.fs, sessionsRoot: this.sessionsRootInput }, options);
	}

	private async sessionIdExists(id: string, cwd: string): Promise<boolean> {
		const suffix = `_${id}.jsonl`;
		const directory = await this.sessionDirectory(cwd);
		if (!fileResult(await this.fs.exists(directory), `Failed to check sessions directory ${directory}`)) return false;
		const files = fileResult(await this.fs.listDir(directory), `Failed to list sessions directory ${directory}`);
		return files.some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix));
	}

	private async sessionDirectory(cwd: string): Promise<string> {
		return fileResult(
			await this.fs.joinPath([await this.root(), jsonlSessionDirectoryName(cwd)]),
			`Failed to resolve sessions directory for ${cwd}`,
		);
	}

	private root(): Promise<string> {
		this.rootPromise ??= this.fs
			.absolutePath(this.sessionsRootInput)
			.then((result) => fileResult(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
		return this.rootPromise;
	}
}
