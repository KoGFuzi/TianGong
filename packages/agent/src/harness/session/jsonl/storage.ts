import { Effect } from "effect";
import { type SessionMutation, SessionState } from "../state.ts";
import {
	type BranchBounds,
	type CommitResult,
	type EffectResult,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type Register,
	type RegisterNamespace,
	type RecordQuery,
	SessionError,
	type SessionStats,
	type SessionStorage,
	type Transaction,
} from "../types.ts";
import { encodeHeader, encodeMutation, encodeTransaction, metadataFromHeader, parseHeader, parseMutation, parseTransaction } from "./codec.ts";
import { fileResult, invalidFile, JsonlDecodeError } from "./errors.ts";
import type { JsonlSessionMetadata, JsonlSessionRepoFileSystem, JsonlV4Header } from "./types.ts";

/**
 * Build a complete sibling temporary file, then atomically rename it over the destination.
 * The populate callback must create or overwrite `tempPath` with the complete file. The
 * destination is untouched until the rename commits, so a process crash while populating
 * can leave only the ignored `.tmp` file behind.
 *
 * Rejects when population or rename fails. On rejection, temporary-file removal is
 * best-effort and the original error is preserved. Callers must serialize publications to
 * the same destination because they share its deterministic `.tmp` path.
 */
async function publishFileAtomically(
	fs: JsonlSessionRepoFileSystem,
	destinationPath: string,
	populate: (tempPath: string) => Promise<void>,
): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		await populate(tempPath);
		fileResult(await fs.renameFile(tempPath, destinationPath), `Failed to publish staged file ${destinationPath}`);
	} catch (error) {
		await fs.remove(tempPath, { force: true });
		throw error;
	}
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly metadata: JsonlSessionMetadata;
	private readonly state = new SessionState();
	private tail: Promise<void> = Promise.resolve();

	constructor(fs: JsonlSessionRepoFileSystem, metadata: JsonlSessionMetadata) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
	}

	static async create(
		fs: JsonlSessionRepoFileSystem,
		path: string,
		header: JsonlV4Header,
	): Promise<JsonlSessionStorage> {
		fileResult(await fs.writeFile(path, encodeHeader(header)), `Failed to initialize session ${path}`);
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		return new JsonlSessionStorage(fs, metadataFromHeader(header, path, fileInfo.mtimeMs));
	}

	static async load(fs: JsonlSessionRepoFileSystem, path: string): Promise<JsonlSessionStorage> {
		const content = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		if (physicalLines.length === 0 || !physicalLines[0]) {
			throw invalidFile(path, 1, new JsonlDecodeError("schema", "is missing a header"));
		}
		const headerResult = parseHeader(physicalLines[0]);
		if (!headerResult.ok) throw invalidFile(path, 1, headerResult.error);
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(fs, metadataFromHeader(headerResult.value, path, fileInfo.mtimeMs));
		for (let index = 1; index < physicalLines.length; index++) {
			const line = physicalLines[index]!;
			const transactionResult = parseTransaction(line);
			const mutationResult = transactionResult.ok ? undefined : parseMutation(line);
			if (!transactionResult.ok && mutationResult?.ok === false) {
				const isTornTail = index === physicalLines.length - 1 && transactionResult.error.kind === "syntax";
				if (isTornTail) {
					// Drop the unacknowledged partial append by atomically publishing the valid prefix.
					const validPrefix = `${physicalLines.slice(0, index).join("\n")}\n`;
					await publishFileAtomically(fs, path, async (tempPath) => {
						fileResult(await fs.writeFile(tempPath, validPrefix), `Failed to stage torn-tail repair ${path}`);
					});
					return storage;
				}
				throw invalidFile(path, index + 1, mutationResult.error.kind === "syntax" ? mutationResult.error : transactionResult.error);
			}
			try {
				if (transactionResult.ok) storage.state.commit(transactionResult.value);
				else if (mutationResult?.ok === true) storage.applyMutation(mutationResult.value);
			} catch (error) {
				if (error instanceof SessionError && error.code === "invalid_entry") {
					throw invalidFile(path, index + 1, error);
				}
				throw error;
			}
		}
		if (!content.endsWith("\n")) {
			fileResult(await fs.appendFile(path, "\n"), `Failed to repair unterminated session tail ${path}`);
		}
		return storage;
	}

	async fork(path: string, header: JsonlV4Header, options: ForkOptions): Promise<JsonlSessionStorage> {
		const mutations = this.state.createForkMutations(options);
		await publishFileAtomically(this.fs, path, async (tempPath) => {
			const targetStorage = await JsonlSessionStorage.create(this.fs, tempPath, header);
			for (const mutation of mutations) {
				await targetStorage.appendMutation(mutation);
				targetStorage.applyMutation(mutation);
			}
		});
		return JsonlSessionStorage.load(this.fs, path);
	}

	async drain(): Promise<void> {
		await this.tail;
	}

	getMetadata(): EffectResult<JsonlSessionMetadata> {
		return Effect.promise(() => Promise.resolve(structuredClone(this.metadata)));
	}

	getLanes(): EffectResult<LanePointer[]> {
		return Effect.sync(() => this.state.getLanes());
	}

	commit(tx: Transaction): EffectResult<CommitResult> {
		const self = this;
		return Effect.tryPromise({
			try: () => self.enqueue(async () => {
				await self.appendTransaction(tx);
				const result = self.state.commit(tx);
				return result;
			}),
			catch: (e) => e as never,
		});
	}

	getEntries(ids: string[]): EffectResult<ReadonlyMap<string, Entry>> {
		return Effect.sync(() => structuredClone(this.state.getEntries(ids)));
	}

	getRegister<N extends RegisterNamespace>(namespace: N, key: string): EffectResult<Register<N> | undefined> {
		return Effect.sync(() => {
			const register = this.state.getRegister(namespace, key);
			return register === undefined ? undefined : structuredClone(register);
		});
	}

	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): EffectResult<Register<N>[]> {
		return Effect.sync(() => structuredClone(this.state.listRegisters(namespace, keyPrefix)));
	}

	createLane(lane: string, at: string | null): EffectResult<void> {
		return Effect.tryPromise({
			try: () => this.enqueue(async () => {
				this.state.validateNewLane(lane);
				this.state.validateTarget(at);
				const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: at };
				await this.appendMutation(mutation);
				this.applyMutation(mutation);
			}),
			catch: (e) => e as never,
		});
	}

	moveLane(lane: string, to: string | null): EffectResult<void> {
		return Effect.tryPromise({
			try: () => this.enqueue(async () => {
				this.state.requireLane(lane);
				this.state.validateTarget(to);
				const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: to };
				await this.appendMutation(mutation);
				this.applyMutation(mutation);
			}),
			catch: (e) => e as never,
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): EffectResult<TEntry> {
		return Effect.tryPromise({
			try: () => this.enqueue(async () => {
				const parentId = this.state.requireLane(lane);
				this.state.validateUnusedId(newEntry.id);
				const entry = {
					...structuredClone(newEntry),
					parentId,
					seq: this.state.nextSequence,
					timestamp: Date.now(),
				} as unknown as TEntry;
				const mutation: SessionMutation = { kind: "entry", lane, entry };
				await this.appendMutation(mutation);
				this.applyMutation(mutation);
				return structuredClone(entry);
			}),
			catch: (e) => e as never,
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): EffectResult<TRecord> {
		return Effect.tryPromise({
			try: () => this.enqueue(async () => {
				this.state.requireLane(newRecord.lane);
				this.state.validateUnusedId(newRecord.id);
				const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
				if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
					throw new SessionError(
						"storage",
						`Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
					);
				}
				const record = {
					...structuredClone(newRecord),
					seq: this.state.nextSequence,
					timestamp: Date.now(),
				} as unknown as TRecord;
				const mutation: SessionMutation = { kind: "record", record };
				await this.appendMutation(mutation);
				this.applyMutation(mutation);
				return structuredClone(record);
			}),
			catch: (e) => e as never,
		});
	}

	getEntry(id: string): EffectResult<Entry | undefined> {
		return Effect.sync(() => {
			const entry = this.state.getEntry(id);
			return entry === undefined ? undefined : structuredClone(entry);
		});
	}

	findEntries(query: EntryQuery = {}): EffectResult<Entry[]> {
		return Effect.sync(() => structuredClone(this.state.findEntries(query)));
	}

	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): EffectResult<Entry[]> {
		return Effect.sync(() => structuredClone(this.state.findEntriesOnBranch(query)));
	}

	findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): EffectResult<Extract<LaneRecord, { type: K }>[]>;
	findRecords(query?: RecordQuery): EffectResult<LaneRecord[]>;
	findRecords(query: RecordQuery = {}): EffectResult<LaneRecord[]> {
		return Effect.sync(() => structuredClone(this.state.findRecords(query)));
	}

	findOpenOperations(lane: string, options?: { limit?: number }): EffectResult<OperationStartedRecord[]> {
		return Effect.sync(() => structuredClone(this.state.findOpenOperations(lane, options)));
	}

	getLog(options: LogOptions = {}): EffectResult<LogItem[]> {
		return Effect.sync(() => structuredClone(this.state.getLog(options)));
	}

	getName(): EffectResult<string | undefined> {
		return Effect.sync(() => this.state.getName());
	}

	setName(name: string | undefined): EffectResult<void> {
		return Effect.tryPromise({
			try: () => this.enqueue(async () => {
				const mutation: SessionMutation = { kind: "fact", seq: this.state.nextSequence, fact: "name", name };
				await this.appendMutation(mutation);
				this.applyMutation(mutation);
			}),
			catch: (e) => e as never,
		});
	}

	getLabel(id: string): EffectResult<string | undefined> {
		return Effect.sync(() => this.state.getLabel(id));
	}

	setLabel(id: string, label: string | undefined): EffectResult<void> {
		return Effect.tryPromise({
			try: () => this.enqueue(async () => {
				this.state.validateTarget(id);
				const mutation: SessionMutation = {
					kind: "fact",
					seq: this.state.nextSequence,
					fact: "label",
					targetId: id,
					label,
				};
				await this.appendMutation(mutation);
				this.applyMutation(mutation);
			}),
			catch: (e) => e as never,
		});
	}

	getStats(): EffectResult<SessionStats> {
		return Effect.sync(() => structuredClone(this.state.getStats()));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async appendMutation(mutation: SessionMutation): Promise<void> {
		fileResult(
			await this.fs.appendFile(this.metadata.path, encodeMutation(mutation)),
			`Failed to append session ${this.metadata.path}`,
		);
	}

	private async appendTransaction(tx: Transaction): Promise<void> {
		fileResult(
			await this.fs.appendFile(this.metadata.path, encodeTransaction(tx)),
			`Failed to append session ${this.metadata.path}`,
		);
	}

	private applyMutation(mutation: SessionMutation): void {
		this.state.applyMutation(mutation);
	}
}
