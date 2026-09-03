import { Effect } from "effect";
import { AbortedError } from "./retry.ts";

/**
 * Create an operation-local signal for public APIs whose signal is optional.
 * Works with both Effect and Promise-based APIs.
 */
export function operationSignal(signal?: AbortSignal): AbortSignal {
	return signal ?? new AbortController().signal;
}

/**
 * Convert an AbortSignal reason to an Error, preserving the original reason if available.
 */
function abortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	return new AbortedError();
}

/**
 * Effect version: Race an Effect with an AbortSignal.
 * The operation will be interrupted if the signal aborts.
 */
export function raceWithAbortSignal<T, E>(
	operation: Effect.Effect<T, E>,
	signal: AbortSignal,
): Effect.Effect<T, E | AbortedError> {
	if (signal.aborted) {
		return Effect.fail(abortReason(signal) as AbortedError);
	}

	// Create an effect that rejects when the signal aborts
	const abortEffect = Effect.tryPromise({
		try: () => {
			if (signal.aborted) {
				return Promise.reject(abortReason(signal));
			}
			return new Promise<never>((_, reject) => {
				signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
			});
		},
		catch: (error) => {
			if (error instanceof AbortedError) return error;
			if (error instanceof Error && error.name === "AbortError") return new AbortedError();
			return new AbortedError();
		}
	});

	// raceFirst: the first completion wins, including failures. `Effect.race`
	// waits for the first *success*, which would ignore the abort failure and
	// keep waiting for the operation.
	return Effect.raceFirst(operation, abortEffect);
}
