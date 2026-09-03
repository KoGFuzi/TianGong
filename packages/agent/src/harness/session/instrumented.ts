import { Effect } from "effect";
import type { CommitResult, SessionMetadata, SessionStorage, Transaction } from "./types.ts";

export interface InstrumentedCommit {
	readonly transaction: Transaction;
	readonly result: CommitResult;
}

export interface InstrumentedSessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly commits: readonly InstrumentedCommit[];
	readonly storage: SessionStorage<TMetadata>;
	commit(tx: Transaction): Promise<CommitResult>;
}

/** Decorates a storage backend without changing its durability or ordering. */
export function instrumentSessionStorage<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
	onCommit?: (commit: InstrumentedCommit) => void,
): InstrumentedSessionStorage<TMetadata> {
	const commits: InstrumentedCommit[] = [];
	const proxy = new Proxy(storage, {
		get(target, property, receiver) {
			if (property === "commits") return commits;
			if (property === "commit") {
				return (transaction: Transaction): Promise<CommitResult> => {
					const effect = target.commit(transaction);
					return Effect.runPromise(effect as Effect.Effect<CommitResult, never>).then((result) => {
						const commit: InstrumentedCommit = {
							transaction: structuredClone(transaction),
							result: structuredClone(result),
						};
						commits.push(commit);
						onCommit?.(commit);
						return result;
					});
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	return proxy as unknown as InstrumentedSessionStorage<TMetadata>;
}
