import { Effect } from "effect";
import { uuidv7 } from "@onepanda-tiangongsec/tg-ai";
import { Session } from "./session.ts";
import { SessionState } from "./state.ts";
import {
	type BranchBounds,
	type CommitResult,
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
	type SessionCreateOptions,
	type SessionMetadata,
	type SessionRepo,
	type SessionStorage,
	type SessionStats,
	type Transaction,
} from "./types.ts";
import type { EffectResult } from "./types.ts";

function withJsonClone<T>(producer: () => T): Effect.Effect<T, never> {
	return Effect.sync(() => structuredClone(producer()));
}

function notFound(id: string): SessionError {
	return new SessionError("not_found", `Session not found: ${id}`);
}

function alreadyExists(id: string): SessionError {
	return new SessionError("already_exists", `Session already exists: ${id}`);
}

export class InMemorySessionStorage implements SessionStorage {
	private readonly metadata: SessionMetadata;
	private readonly state = new SessionState();

	constructor(metadata: SessionMetadata) {
		this.metadata = structuredClone(metadata);
	}

	fork(metadata: SessionMetadata, options: ForkOptions & SessionCreateOptions): InMemorySessionStorage {
		const storage = new InMemorySessionStorage(metadata);
		for (const mutation of this.state.createForkMutations(options)) storage.state.applyMutation(mutation);
		return storage;
	}

	getMetadata(): EffectResult<SessionMetadata> {
		return withJsonClone(() => this.metadata);
	}

	commit(tx: Transaction): EffectResult<CommitResult> {
		return Effect.sync(() => this.state.commit(tx));
	}

	getEntries(ids: string[]): EffectResult<ReadonlyMap<string, Entry>> {
		return withJsonClone(() => this.state.getEntries(ids));
	}

	getRegister<N extends RegisterNamespace>(namespace: N, key: string): EffectResult<Register<N> | undefined> {
		return Effect.sync(() => {
			const register = this.state.getRegister(namespace, key);
			return register === undefined ? undefined : structuredClone(register);
		});
	}

	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): EffectResult<Register<N>[]> {
		return withJsonClone(() => this.state.listRegisters(namespace, keyPrefix));
	}

	getLanes(): EffectResult<LanePointer[]> {
		return Effect.sync(() => this.state.getLanes());
	}

	createLane(lane: string, at: string | null): EffectResult<void> {
		return Effect.sync(() => {
			this.state.validateNewLane(lane);
			this.state.validateTarget(at);
			this.state.applyMutation({ kind: "lane", seq: this.state.nextSequence, lane, leafId: at });
		});
	}

	moveLane(lane: string, to: string | null): EffectResult<void> {
		return Effect.sync(() => {
			this.state.requireLane(lane);
			this.state.validateTarget(to);
			this.state.applyMutation({ kind: "lane", seq: this.state.nextSequence, lane, leafId: to });
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): EffectResult<TEntry> {
		return Effect.sync(() => {
			const parentId = this.state.requireLane(lane);
			this.state.validateUnusedId(newEntry.id);
			const entry = {
				...structuredClone(newEntry),
				parentId,
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TEntry;
			this.state.applyMutation({ kind: "entry", lane, entry });
			return structuredClone(entry);
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): EffectResult<TRecord> {
		return Effect.sync(() => {
			this.state.requireLane(newRecord.lane);
			this.state.validateUnusedId(newRecord.id);
			const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
			if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
				throw new SessionError("storage", `Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`);
			}
			const record = {
				...structuredClone(newRecord),
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TRecord;
			this.state.applyMutation({ kind: "record", record });
			return structuredClone(record);
		});
	}

	getEntry(id: string): EffectResult<Entry | undefined> {
		return Effect.sync(() => {
			const entry = this.state.getEntry(id);
			return entry === undefined ? undefined : structuredClone(entry);
		});
	}

	findEntries(query: EntryQuery = {}): EffectResult<Entry[]> {
		return withJsonClone(() => this.state.findEntries(query));
	}

	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): EffectResult<Entry[]> {
		return withJsonClone(() => this.state.findEntriesOnBranch(query));
	}

	findRecords(query: RecordQuery = {}): EffectResult<LaneRecord[]> {
		return withJsonClone(() => this.state.findRecords(query));
	}

	findOpenOperations(lane: string, options?: { limit?: number }): EffectResult<OperationStartedRecord[]> {
		return withJsonClone(() => this.state.findOpenOperations(lane, options));
	}

	getLog(options: LogOptions = {}): EffectResult<LogItem[]> {
		return withJsonClone(() => this.state.getLog(options));
	}

	getName(): EffectResult<string | undefined> {
		return Effect.sync(() => this.state.getName());
	}

	setName(name: string | undefined): EffectResult<void> {
		return Effect.sync(() => {
			this.state.applyMutation({ kind: "fact", seq: this.state.nextSequence, fact: "name", name });
		});
	}

	getLabel(id: string): EffectResult<string | undefined> {
		return Effect.sync(() => this.state.getLabel(id));
	}

	setLabel(id: string, label: string | undefined): EffectResult<void> {
		return Effect.sync(() => {
			this.state.validateTarget(id);
			this.state.applyMutation({
				kind: "fact",
				seq: this.state.nextSequence,
				fact: "label",
				targetId: id,
				label,
			});
		});
	}

	getStats(): EffectResult<SessionStats> {
		return withJsonClone(() => this.state.getStats());
	}
}

export class InMemorySessionRepo implements SessionRepo {
	private readonly sessions = new Map<string, InMemorySessionStorage>();

	create(options: SessionCreateOptions = {}): EffectResult<Session<SessionMetadata>> {
		const id = options.id ?? uuidv7();
		if (this.sessions.has(id)) {
			return Effect.fail(alreadyExists(id));
		}
		const metadata = { id, createdAt: Date.now(), parentSessionId: options.parentSessionId } as SessionMetadata;
		const storage = new InMemorySessionStorage(metadata);
		this.sessions.set(id, storage);
		return Effect.succeed(new Session<SessionMetadata>(storage, { metadata }));
	}

	open(metadata: SessionMetadata): EffectResult<Session<SessionMetadata>> {
		const storage = this.sessions.get(metadata.id);
		if (!storage) return Effect.fail(notFound(metadata.id));
		return Effect.succeed(new Session<SessionMetadata>(storage, { metadata }));
	}

	list(_options?: void): EffectResult<SessionMetadata[]> {
		const self = this;
		const effects = Array.from(self.sessions.values()).map((s) => s.getMetadata());
		return Effect.all(effects);
	}

	delete(metadata: SessionMetadata): EffectResult<void> {
		return Effect.sync(() => this.sessions.delete(metadata.id));
	}

	fork(source: SessionMetadata, options: ForkOptions & SessionCreateOptions = {}): EffectResult<Session<SessionMetadata>> {
		const sourceStorage = this.sessions.get(source.id);
		if (!sourceStorage) return Effect.fail(notFound(source.id));
		const id = options.id ?? uuidv7();
		if (this.sessions.has(id)) {
			return Effect.fail(alreadyExists(id));
		}
		return Effect.sync(() => {
			const storage = sourceStorage.fork(
				{ id, createdAt: Date.now(), parentSessionId: options.parentSessionId ?? source.id },
				options,
			);
			this.sessions.set(id, storage);
			return new Session<SessionMetadata>(storage);
		});
	}

	private requireStorage(id: string): InMemorySessionStorage {
		const storage = this.sessions.get(id);
		if (!storage) throw notFound(id);
		return storage;
	}
}

export function effectInMemorySessionRepo(): SessionRepo {
	return new InMemorySessionRepo();
}
