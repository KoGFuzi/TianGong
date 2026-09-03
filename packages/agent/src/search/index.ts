import type { Entry } from "../harness/session/types.ts";
import type * as Stream from "effect/Stream";

export type {
	ScanningReadable,
	ScanningReadableOptions,
	ScanningReadableSource,
	ScanningSearchTextProjector,
	ScanningSessionSearchHit,
	ScanningSessionSearchOptions,
	SessionSearchCandidate,
} from "./scanning.ts";
export { createScanningSessionSearch, scanningEntries } from "./scanning.ts";

export interface SessionSearchOptions {
	/** Restrict results to specific canonical entry types. */
	readonly entryTypes?: readonly Entry["type"][];
	/** Maximum number of hits to return. */
	readonly limit?: number;
	/** Abort signal for cancellation, e.g. search-as-you-type. */
	readonly signal?: AbortSignal;
}

export interface SessionSearchHit {
	/** Logical identifier of the session that owns the entry. */
	readonly sessionId: string;
	/** Logical identifier of the entry within that session. */
	readonly entryId: string;
}

/**
 * Effect-native view of a search. Both `search` and `searchStream` return
 * Effect Streams — there is no async/await boundary in the search pipeline.
 */
export interface EffectSessionSearch<T extends SessionSearchHit = SessionSearchHit> {
	search(text: string, options?: SessionSearchOptions): Stream.Stream<T, unknown>;
	searchStream(text: string, options?: SessionSearchOptions): Stream.Stream<T, unknown>;
}
