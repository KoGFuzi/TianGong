import { Effect } from "effect";
import { uuidv7 } from "@onepanda-tiangongsec/tg-ai";
import type { AgentMessage } from "../../types.ts";
import {
	type BranchBounds,
	type CommitResult,
	type Entry,
	type EntryQuery,
	type IdGenerator,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type PromiseSessionStorage,
	type PromiseSessionTree,
	type RecordBase,
	type RecordQuery,
	type Register,
	type RegisterNamespace,
	type SessionCreateOptions,
	type SessionMetadata,
	type SessionRepo,
	type SessionStats,
	type SessionStorage,
	type SessionTree,
	type Transaction,
} from "./types.ts";
import type { EffectResult } from "./types.ts";
import { SessionError } from "./types.ts";

type JsonValidationFrame = { value: unknown } | { exit: object };

function invalidPayload(reason: string): never {
	throw new SessionError("invalid_payload", `Durable payload ${reason}`);
}

function assertValidLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new SessionError("invalid_query", "limit must be a positive integer");
	}
}

function assertValidCursor(afterSeq: number | undefined): void {
	if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
		throw new SessionError("invalid_query", "cursor sequence must be a non-negative integer");
	}
}

export function assertJsonSerializable(value: unknown): void {
	const active = new WeakSet<object>();
	const stack: JsonValidationFrame[] = [{ value }];
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if ("exit" in frame) {
			active.delete(frame.exit);
			continue;
		}
		const candidate = frame.value;
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
			continue;
		}
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) invalidPayload("contains a non-finite number");
			continue;
		}
		if (typeof candidate !== "object") invalidPayload(`contains ${typeof candidate}`);
		if (active.has(candidate)) invalidPayload("contains a cycle");
		active.add(candidate);
		stack.push({ exit: candidate });

		if (Array.isArray(candidate)) {
			if (Object.getPrototypeOf(candidate) !== Array.prototype) {
				invalidPayload("contains a non-standard array");
			}
			if (
				Object.getOwnPropertySymbols(candidate).length > 0 ||
				Object.getOwnPropertyNames(candidate).length !== candidate.length + 1
			) {
				invalidPayload("contains an array with unsupported properties");
			}
			for (let index = candidate.length - 1; index >= 0; index--) {
				if (!Object.hasOwn(candidate, index)) invalidPayload("contains a sparse array");
				const descriptor = Object.getOwnPropertyDescriptor(candidate, index)!;
				if (!("value" in descriptor)) invalidPayload("contains an array accessor");
				stack.push({ value: descriptor.value });
			}
			continue;
		}

		const prototype = Object.getPrototypeOf(candidate);
		if (prototype !== Object.prototype && prototype !== null) {
			invalidPayload("contains a non-plain object");
		}
		if (Object.getOwnPropertySymbols(candidate).length > 0) {
			invalidPayload("contains a symbol-keyed property");
		}
		const keys = Object.keys(candidate);
		if (Object.getOwnPropertyNames(candidate).length !== keys.length) {
			invalidPayload("contains a non-enumerable property");
		}
		for (let index = keys.length - 1; index >= 0; index--) {
			const descriptor = Object.getOwnPropertyDescriptor(candidate, keys[index]!)!;
			if (!("value" in descriptor)) invalidPayload("contains an accessor");
			stack.push({ value: descriptor.value });
		}
	}
}

function validateTx(tx: Transaction): void {
	for (const write of tx.writes) {
		if (write.kind === "entry" || write.kind === "usage" || (write.kind === "register" && write.op === "set")) {
			assertJsonSerializable(write.kind === "entry" ? write.entry : write.kind === "usage" ? write.row : write.value);
		}
	}
}

/** Effect-first session backed by a SessionStorage. */
export class Session<TMetadata extends SessionMetadata = SessionMetadata> implements SessionTree {
	private readonly storage: SessionStorage<TMetadata>;
	readonly idGenerator: IdGenerator;
	readonly metadata: TMetadata;

	constructor(storage: SessionStorage<TMetadata>, options: { idGenerator?: IdGenerator; metadata?: TMetadata } = {}) {
		this.storage = storage;
		this.idGenerator = options.idGenerator ?? { next: () => uuidv7() };
		this.metadata = options.metadata ?? ({} as TMetadata);
	}

	getMetadata(): EffectResult<TMetadata> {
		return this.storage.getMetadata();
	}

	commit(tx: Transaction): EffectResult<CommitResult> {
		const self = this;
		for (const write of tx.writes) {
			if (write.kind === "entry" || write.kind === "usage" || (write.kind === "register" && write.op === "set")) {
				try {
					assertJsonSerializable(write.kind === "entry" ? write.entry : write.kind === "usage" ? write.row : write.value);
				} catch (e) {
					if (e instanceof SessionError) return Effect.fail(e) as EffectResult<CommitResult>;
					return Effect.fail(new SessionError("invalid_payload", `Durable payload ${(e as Error).message}`)) as EffectResult<CommitResult>;
				}
			}
		}
		return self.storage.commit(tx) as EffectResult<CommitResult>;
	}

	getEntries(ids: string[]): EffectResult<ReadonlyMap<string, Entry>> {
		return this.storage.getEntries(ids) as EffectResult<ReadonlyMap<string, Entry>>;
	}

	getRegister<N extends RegisterNamespace>(namespace: N, key: string): EffectResult<Register<N> | undefined> {
		return this.storage.getRegister(namespace, key) as EffectResult<Register<N> | undefined>;
	}

	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): EffectResult<Register<N>[]> {
		return this.storage.listRegisters(namespace, keyPrefix) as EffectResult<Register<N>[]>;
	}

	view(lane: string): SessionTree {
		if (lane === "main") return this;
		const self = this;
		const runIfEffect = <T>(value: T | Effect.Effect<T, never>): T | Promise<T> => {
			if (Effect.isEffect(value)) return Effect.runPromise(value);
			return value;
		};
		return {
			getLeafId: () => self.getLeafIdForLane(lane),
			getEntry: (id) => self.getEntry(id),
			getStats: () => self.getStats(),
			getRegister: (namespace, key) => self.getRegister(namespace, key),
			listRegisters: (namespace, keyPrefix) => self.listRegisters(namespace, keyPrefix),
			getName: () => self.getName(),
			setName: (name) => self.setName(name),
			getLabel: (targetId) => self.getLabel(targetId),
			setLabel: (targetId, label) => self.setLabel(targetId, label),
			findEntries: (query) => self.findEntries(query),
			findEntry: (query) => self.findEntry(query),
			findEntriesOnBranch: (query) => self.findEntriesOnBranch(query, lane),
			findEntryOnBranch: (query) => self.findEntryOnBranch(query, lane),
			appendMessage: (message) => self.appendMessageToLane(lane, message),
			appendCustomEntry: (customType, data) => self.appendCustomEntryToLane(lane, customType, data),
		};
	}

	getLeafId(): EffectResult<string | null> {
		return this.getLeafIdForLane("main");
	}

	getEntry(id: string): EffectResult<Entry | undefined> {
		return this.storage.getEntry(id) as EffectResult<Entry | undefined>;
	}

	getStats(): EffectResult<SessionStats> {
		return this.storage.getStats() as EffectResult<SessionStats>;
	}

	getName(): EffectResult<string | undefined> {
		return this.storage.getName() as EffectResult<string | undefined>;
	}

	setName(name: string | undefined): EffectResult<void> {
		return this.storage.setName(name) as EffectResult<void>;
	}

	getLabel(targetId: string): EffectResult<string | undefined> {
		return this.storage.getLabel(targetId) as EffectResult<string | undefined>;
	}

	setLabel(targetId: string, label: string | undefined): EffectResult<void> {
		return this.storage.setLabel(targetId, label) as EffectResult<void>;
	}

	findEntries(query?: EntryQuery): EffectResult<Entry[]> {
		const self = this;
		const q = query ?? {};
		if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit <= 0)) {
			return Effect.fail(new SessionError("invalid_query", "limit must be a positive integer")) as EffectResult<Entry[]>;
		}
		if (q.cursor?.afterSeq !== undefined && (!Number.isInteger(q.cursor.afterSeq) || q.cursor.afterSeq < 0)) {
			return Effect.fail(new SessionError("invalid_query", "cursor sequence must be a non-negative integer")) as EffectResult<Entry[]>;
		}
		return self.storage.findEntries(q) as EffectResult<Entry[]>;
	}

	findEntry(query?: EntryQuery): EffectResult<Entry | undefined> {
		const self = this;
		const q = query ?? {};
		if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit <= 0)) {
			return Effect.fail(new SessionError("invalid_query", "limit must be a positive integer")) as EffectResult<Entry | undefined>;
		}
		if (q.cursor?.afterSeq !== undefined && (!Number.isInteger(q.cursor.afterSeq) || q.cursor.afterSeq < 0)) {
			return Effect.fail(new SessionError("invalid_query", "cursor sequence must be a non-negative integer")) as EffectResult<Entry | undefined>;
		}
		return self.findEntries({ ...q, limit: 1 }).pipe(Effect.map((entries) => entries[0])) as EffectResult<Entry | undefined>;
	}

	findEntriesOnBranch(query?: EntryQuery & BranchBounds, defaultLane = "main"): EffectResult<Entry[]> {
		const self = this;
		const q = (query ?? {}) as EntryQuery & BranchBounds;
		if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit <= 0)) {
			return Effect.fail(new SessionError("invalid_query", "limit must be a positive integer")) as EffectResult<Entry[]>;
		}
		if (q.cursor?.afterSeq !== undefined && (!Number.isInteger(q.cursor.afterSeq) || q.cursor.afterSeq < 0)) {
			return Effect.fail(new SessionError("invalid_query", "cursor sequence must be a non-negative integer")) as EffectResult<Entry[]>;
		}
		if (q.start !== undefined) {
			return self.storage.findEntriesOnBranch(q as EntryQuery & BranchBounds & { start: string }) as EffectResult<Entry[]>;
		}
		return self.getLeafIdForLane(defaultLane).pipe(
			Effect.flatMap((start) => {
				if (start === null) return Effect.succeed([]);
				return self.storage.findEntriesOnBranch({ ...q, start });
			}),
		) as EffectResult<Entry[]>;
	}

	findEntryOnBranch(query?: EntryQuery & BranchBounds, defaultLane = "main"): EffectResult<Entry | undefined> {
		const self = this;
		const q = query ?? {};
		if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit <= 0)) {
			return Effect.fail(new SessionError("invalid_query", "limit must be a positive integer")) as EffectResult<Entry | undefined>;
		}
		if (q.cursor?.afterSeq !== undefined && (!Number.isInteger(q.cursor.afterSeq) || q.cursor.afterSeq < 0)) {
			return Effect.fail(new SessionError("invalid_query", "cursor sequence must be a non-negative integer")) as EffectResult<Entry | undefined>;
		}
		return self.findEntriesOnBranch({ ...q, limit: 1 }, defaultLane).pipe(Effect.map((entries) => entries[0])) as EffectResult<Entry | undefined>;
	}

	appendMessage(message: AgentMessage): EffectResult<string> {
		return this.appendMessageToLane("main", message);
	}

	appendCustomEntry(customType: string, data?: unknown): EffectResult<string> {
		return this.appendCustomEntryToLane("main", customType, data);
	}

	getLanes(): EffectResult<LanePointer[]> {
		return this.storage.getLanes() as EffectResult<LanePointer[]>;
	}

	createLane(lane: string, at: string | null): EffectResult<void> {
		return this.storage.createLane(lane, at) as EffectResult<void>;
	}

	moveLane(lane: string, to: string | null): EffectResult<void> {
		return this.storage.moveLane(lane, to) as EffectResult<void>;
	}

	appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): EffectResult<TEntry> {
		const self = this;
		try {
			assertJsonSerializable(entry);
		} catch (e) {
			if (e instanceof SessionError) return Effect.fail(e) as EffectResult<TEntry>;
			return Effect.fail(new SessionError("invalid_payload", `Durable payload ${(e as Error).message}`)) as EffectResult<TEntry>;
		}
		return self.storage.appendEntry(entry, lane) as EffectResult<TEntry>;
	}

	appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): EffectResult<TRecord> {
		const self = this;
		try {
			assertJsonSerializable(record);
		} catch (e) {
			if (e instanceof SessionError) return Effect.fail(e) as EffectResult<TRecord>;
			return Effect.fail(new SessionError("invalid_payload", `Durable payload ${(e as Error).message}`)) as EffectResult<TRecord>;
		}
		return self.storage.appendRecord(record) as EffectResult<TRecord>;
	}

	findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): EffectResult<Extract<LaneRecord, { type: K }>[]>;
	findRecords(query?: RecordQuery): EffectResult<LaneRecord[]>;
	findRecords(query?: RecordQuery): EffectResult<LaneRecord[]> {
		const self = this;
		const q = query ?? {};
		if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit <= 0)) {
			return Effect.fail(new SessionError("invalid_query", "limit must be a positive integer")) as EffectResult<LaneRecord[]>;
		}
		if (q.afterSeq !== undefined && (!Number.isInteger(q.afterSeq) || q.afterSeq < 0)) {
			return Effect.fail(new SessionError("invalid_query", "cursor sequence must be a non-negative integer")) as EffectResult<LaneRecord[]>;
		}
		if (q.operationKind !== undefined && q.type !== "operation_started") {
			return Effect.fail(new SessionError("invalid_query", 'operationKind requires type "operation_started"')) as EffectResult<LaneRecord[]>;
		}
		return self.storage.findRecords(q) as EffectResult<LaneRecord[]>;
	}

	findOpenOperations(lane: string, options?: { limit?: number }): EffectResult<OperationStartedRecord[]> {
		const self = this;
		const opts = options ?? {};
		if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
			return Effect.fail(new SessionError("invalid_query", "limit must be a positive integer")) as EffectResult<OperationStartedRecord[]>;
		}
		return self.storage.findOpenOperations(lane, opts) as EffectResult<OperationStartedRecord[]>;
	}

	getLog(options?: LogOptions): EffectResult<LogItem[]> {
		const self = this;
		const opts = options ?? {};
		if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
			return Effect.fail(new SessionError("invalid_query", "limit must be a positive integer")) as EffectResult<LogItem[]>;
		}
		if (opts.afterSeq !== undefined && (!Number.isInteger(opts.afterSeq) || opts.afterSeq < 0)) {
			return Effect.fail(new SessionError("invalid_query", "cursor sequence must be a non-negative integer")) as EffectResult<LogItem[]>;
		}
		return self.storage.getLog(opts) as EffectResult<LogItem[]>;
	}

	private getLeafIdForLane(lane: string): Effect.Effect<string | null, SessionError> {
		const self = this;
		return Effect.gen(function* () {
			const lanes = yield* self.storage.getLanes();
			const pointer = lanes.find((candidate) => candidate.lane === lane);
			if (!pointer) return Effect.fail(new SessionError("invalid_lane", `Lane not found: ${lane}`));
			return Effect.succeed(pointer.leafId);
		}).pipe(Effect.flatten) as Effect.Effect<string | null, SessionError>;
	}

	private appendMessageToLane(lane: string, message: AgentMessage): Effect.Effect<string, unknown> {
		const self = this;
		return Effect.gen(function* () {
			const entry = yield* self.commitEntry({ type: "message", id: self.idGenerator.next(), message }, lane);
			return entry.id;
		});
	}

	private appendCustomEntryToLane(lane: string, customType: string, data?: unknown): Effect.Effect<string, unknown> {
		const self = this;
		return Effect.gen(function* () {
			const entry = yield* self.commitEntry(
				data === undefined
					? { type: "custom", id: self.idGenerator.next(), customType }
					: { type: "custom", id: self.idGenerator.next(), customType, data },
				lane,
			);
			return entry.id;
		});
	}

	private commitEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): EffectResult<TEntry> {
		const self = this;
		return Effect.sync(() => {
			assertJsonSerializable(entry);
			return entry;
		}).pipe(Effect.flatMap((validated) => self.storage.appendEntry(validated, lane))) as EffectResult<TEntry>;
	}
}

/** Legacy Promise-based session backed by a PromiseSessionStorage. */
export class PromiseSession<TMetadata extends SessionMetadata = SessionMetadata> implements PromiseSessionTree {
	private readonly storage: PromiseSessionStorage<TMetadata>;
	readonly idGenerator: IdGenerator;

	constructor(storage: PromiseSessionStorage<TMetadata>, options: { idGenerator?: IdGenerator } = {}) {
		this.storage = storage;
		this.idGenerator = options.idGenerator ?? { next: () => uuidv7() };
	}

	async getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	async commit(tx: Transaction): Promise<CommitResult> {
		validateTx(tx);
		return this.storage.commit(tx);
	}

	async getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		return this.storage.getEntries(ids);
	}

	async getRegister<N extends RegisterNamespace>(namespace: N, key: string): Promise<Register<N> | undefined> {
		return this.storage.getRegister(namespace, key);
	}

	async listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): Promise<Register<N>[]> {
		return this.storage.listRegisters(namespace, keyPrefix);
	}

	view(lane: string): PromiseSessionTree {
		if (lane === "main") return this;
		return {
			getLeafId: () => this.getLeafIdForLane(lane),
			getEntry: (id) => this.getEntry(id),
			getStats: () => this.getStats(),
			getName: () => this.getName(),
			setName: (name) => this.setName(name),
			getLabel: (targetId) => this.getLabel(targetId),
			setLabel: (targetId, label) => this.setLabel(targetId, label),
			findEntries: (query) => this.queryEntries(query),
			findEntry: async (query = {}) => (await this.queryEntries(query, 1))[0],
			findEntriesOnBranch: (query) => this.queryBranchEntries(lane, query),
			findEntryOnBranch: async (query = {}) => (await this.queryBranchEntries(lane, query, 1))[0],
			appendMessage: (message) => this.appendMessageToLane(lane, message),
			appendCustomEntry: (customType, data) => this.appendCustomEntryToLane(lane, customType, data),
		};
	}

	async getLeafId(): Promise<string | null> {
		return this.getLeafIdForLane("main");
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		return this.storage.getEntry(id);
	}

	async getStats(): Promise<SessionStats> {
		return this.storage.getStats();
	}

	async getName(): Promise<string | undefined> {
		return this.storage.getName();
	}

	async setName(name: string | undefined): Promise<void> {
		await this.storage.setName(name);
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return this.storage.getLabel(targetId);
	}

	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.storage.setLabel(targetId, label);
	}

	async findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.queryEntries(query);
	}

	async findEntry(query: EntryQuery = {}): Promise<Entry | undefined> {
		return (await this.queryEntries(query, 1))[0];
	}

	async findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]> {
		return this.queryBranchEntries("main", query);
	}

	async findEntryOnBranch(query: EntryQuery & BranchBounds = {}): Promise<Entry | undefined> {
		return (await this.queryBranchEntries("main", query, 1))[0];
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendMessageToLane("main", message);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendCustomEntryToLane("main", customType, data);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.storage.getLanes();
	}

	async createLane(lane: string, at: string | null): Promise<void> {
		await this.storage.createLane(lane, at);
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		await this.storage.moveLane(lane, to);
	}

	async appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.commitEntry(entry, lane);
	}

	async appendRecord<TNewRecord extends NewRecord>(
		record: TNewRecord,
	): Promise<TNewRecord & Pick<RecordBase, "seq" | "timestamp">>;
	async appendRecord(record: NewRecord): Promise<LaneRecord> {
		return this.commitRecord(record);
	}

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]> {
		return this.queryRecords(query);
	}

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		assertValidLimit(options?.limit);
		return this.storage.findOpenOperations(lane, options);
	}

	async getLog(options?: LogOptions): Promise<LogItem[]> {
		return this.queryLog(options);
	}

	private async getLeafIdForLane(lane: string): Promise<string | null> {
		const pointer = (await this.getLanes()).find((candidate) => candidate.lane === lane);
		if (!pointer) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		return pointer.leafId;
	}

	private async queryEntries(query: EntryQuery = {}, resultLimit = query.limit): Promise<Entry[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		return this.storage.findEntries(resultLimit === query.limit ? query : { ...query, limit: resultLimit });
	}

	private async queryBranchEntries(
		defaultLane: string,
		query: EntryQuery & BranchBounds = {},
		resultLimit = query.limit,
	): Promise<Entry[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		const start = query.start ?? (await this.getLeafIdForLane(defaultLane));
		if (start === null) return [];
		const storageQuery = resultLimit === query.limit ? query : { ...query, limit: resultLimit };
		return this.storage.findEntriesOnBranch({ ...storageQuery, start });
	}

	private async queryRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.afterSeq);
		if (query.operationKind !== undefined && query.type !== "operation_started") {
			throw new SessionError("invalid_query", 'operationKind requires type "operation_started"');
		}
		return this.storage.findRecords(query);
	}

	private async queryLog(options: LogOptions = {}): Promise<LogItem[]> {
		assertValidLimit(options.limit);
		assertValidCursor(options.afterSeq);
		return this.storage.getLog(options);
	}

	private async appendMessageToLane(lane: string, message: AgentMessage): Promise<string> {
		const entry = await this.commitEntry({ type: "message", id: this.idGenerator.next(), message }, lane);
		return entry.id;
	}

	private async appendCustomEntryToLane(lane: string, customType: string, data?: unknown): Promise<string> {
		const entry = await this.commitEntry(
			data === undefined
				? { type: "custom", id: this.idGenerator.next(), customType }
				: { type: "custom", id: this.idGenerator.next(), customType, data },
			lane,
		);
		return entry.id;
	}

	private async commitEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		assertJsonSerializable(entry);
		return this.storage.appendEntry(entry, lane);
	}

	private async commitRecord<TNewRecord extends NewRecord>(
		record: TNewRecord,
	): Promise<TNewRecord & Pick<RecordBase, "seq" | "timestamp">> {
		assertJsonSerializable(record);
		return this.storage.appendRecord<LaneRecord>(record) as unknown as Promise<
			TNewRecord & Pick<RecordBase, "seq" | "timestamp">
		>;
	}
}
