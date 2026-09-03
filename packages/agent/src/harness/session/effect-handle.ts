import { Effect } from "effect";
import type {
	ForkOptions,
	Session,
	SessionCreateOptions,
	SessionMetadata,
} from "./types.ts";

/**
 * Effect-native session facade. Wraps a `Session` (which exposes Effect-returning
 * methods) into a Promise-style handle that downstream consumers can await while
 * keeping the underlying storage's Effect semantics.
 */
export interface EffectSession<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly metadata: TMetadata;
	getLeafId(): Promise<string | null>;
	findEntries(query?: unknown): Promise<unknown[]>;
	findEntriesOnBranch(query?: unknown): Promise<unknown[]>;
	appendMessage(message: unknown): Promise<string>;
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
	commit(tx: unknown): Promise<unknown>;
	appendEntry(entry: unknown, lane: string): Promise<unknown>;
	appendRecord(record: unknown): Promise<unknown>;
	close(): Promise<void>;
	stats(): Promise<unknown>;
}

/**
 * Effect-style session repository. Mirrors `SessionRepo` but returns `Effect`s
 * instead of `Promise`s. This is the contract sqlite-bun's Effect facade
 * expects.
 */
export interface EffectSessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions): Effect.Effect<EffectSession<TMetadata>, never>;
	open(metadata: TMetadata): Effect.Effect<EffectSession<TMetadata>, never>;
	list(options?: TListOptions): Effect.Effect<TMetadata[], never>;
	delete(metadata: TMetadata): Effect.Effect<void, never>;
	fork(
		source: TMetadata,
		options: ForkOptions & TCreateOptions,
	): Effect.Effect<EffectSession<TMetadata>, never>;
}

/**
 * Promise-wrapping handle around a `Session`. The handle exposes Promise-returning
 * methods that run the underlying Effect via `Effect.runPromise`.
 */
export class EffectSessionHandle<TMetadata extends SessionMetadata = SessionMetadata>
	implements EffectSession<TMetadata>
{
	readonly metadata: TMetadata;

	constructor(
		private readonly session: Session<TMetadata>,
		metadata: TMetadata,
	) {
		this.metadata = metadata;
	}

	getLeafId(): Promise<string | null> {
		return Effect.runPromise(this.session.getLeafId() as Effect.Effect<string | null, never>);
	}

	findEntries(query?: unknown): Promise<unknown[]> {
		return Effect.runPromise(
			(this.session.findEntries(query as never) as Effect.Effect<unknown[], never>),
		);
	}

	findEntriesOnBranch(query?: unknown): Promise<unknown[]> {
		return Effect.runPromise(
			(this.session.findEntriesOnBranch(query as never) as Effect.Effect<unknown[], never>),
		);
	}

	appendMessage(message: unknown): Promise<string> {
		return Effect.runPromise(
			(this.session.appendMessage(message as never) as Effect.Effect<string, never>),
		);
	}

	appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return Effect.runPromise(
			(this.session.appendCustomEntry(customType, data) as Effect.Effect<string, never>),
		);
	}

	commit(tx: unknown): Promise<unknown> {
		return Effect.runPromise(
			(this.session.commit(tx as never) as Effect.Effect<unknown, never>),
		);
	}

	appendEntry(entry: unknown, lane: string): Promise<unknown> {
		return Effect.runPromise(
			(this.session.appendEntry(entry as never, lane) as Effect.Effect<unknown, never>),
		);
	}

	appendRecord(record: unknown): Promise<unknown> {
		return Effect.runPromise(
			(this.session.appendRecord(record as never) as Effect.Effect<unknown, never>),
		);
	}

	close(): Promise<void> {
		return Effect.runPromise((this.session as unknown as { close?: () => Effect.Effect<void, never> }).close?.() ?? Effect.void);
	}

	stats(): Promise<unknown> {
		return Effect.runPromise((this.session.getStats() as Effect.Effect<unknown, never>));
	}
}
