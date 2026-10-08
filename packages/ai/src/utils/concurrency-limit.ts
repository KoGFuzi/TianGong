import { operationSignal, raceWithAbortSignal } from "./abort.ts";

function abortReason(signal?: AbortSignal): unknown {
	if (signal?.reason !== undefined) return signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

/**
 * Bounded admission for outbound provider requests, bucketed by provider id so one provider
 * saturating cannot starve another.
 *
 * This is a ceiling, not a queue with a deadline: a caller that cannot be admitted fails fast with
 * {@link ConcurrencyLimitError}. That is deliberate. An agent already has its own retry budget, and
 * blocking here would hold a slot open while the same provider is refusing requests — converting a
 * 429 into latency instead of into an error the caller can see and report.
 */
export class ConcurrencyLimitError extends Error {
	readonly providerId: string;
	readonly limit: number;

	constructor(providerId: string, limit: number) {
		super(`Provider ${providerId} is at its concurrency limit (${limit} in flight)`);
		this.name = "ConcurrencyLimitError";
		this.providerId = providerId;
		this.limit = limit;
	}
}

export interface ConcurrencyLimiterOptions {
	/**
	 * Maximum concurrent operations per bucket. Zero or a negative value disables admission control
	 * for every bucket.
	 */
	limit?: number;
}

export class ConcurrencyLimiter {
	readonly #limit: number;
	readonly #inFlight = new Map<string, number>();

	constructor(options: ConcurrencyLimiterOptions = {}) {
		this.#limit = options.limit ?? 0;
	}

	/** Configured ceiling; zero means unlimited. */
	get limit(): number {
		return this.#limit;
	}

	/** Operations currently admitted for one bucket. */
	inFlight(bucket: string): number {
		return this.#inFlight.get(bucket) ?? 0;
	}

	/**
	 * Take one slot for `bucket`, or reject with {@link ConcurrencyLimitError} when the bucket is
	 * full. Every successful acquisition must be paired with exactly one {@link release}.
	 *
	 * Use this instead of {@link run} when the occupied resource outlives the call that started it —
	 * a streaming response holds its upstream slot until the last byte arrives, so the slot cannot be
	 * tied to the promise that opened it.
	 */
	async acquire(bucket: string, signal?: AbortSignal): Promise<void> {
		if (this.#limit <= 0) return;

		const active = this.#inFlight.get(bucket) ?? 0;
		if (active >= this.#limit) throw new ConcurrencyLimitError(bucket, this.#limit);
		this.#inFlight.set(bucket, active + 1);

		// An already-aborted or aborted-while-waiting caller must not keep the slot.
		if (operationSignal(signal).aborted) {
			this.release(bucket);
			throw abortReason(signal);
		}
	}

	/** Return a slot taken by {@link acquire}. Extra calls are ignored. */
	release(bucket: string): void {
		if (this.#limit <= 0) return;
		const active = this.#inFlight.get(bucket);
		if (active === undefined) return;
		if (active > 1) this.#inFlight.set(bucket, active - 1);
		else this.#inFlight.delete(bucket);
	}

	/**
	 * Run `operation` once a slot is free for `bucket`, holding the slot for as long as the returned
	 * promise is pending.
	 *
	 * Rejects with {@link ConcurrencyLimitError} when the bucket is already at the limit, and
	 * releases the slot on every exit path including an aborted or rejected operation.
	 */
	async run<T>(bucket: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquire(bucket, signal);
		if (this.#limit <= 0) return operation();
		try {
			return await raceWithAbortSignal(operation(), operationSignal(signal));
		} finally {
			this.release(bucket);
		}
	}
}

/**
 * Default per-provider concurrency ceiling.
 *
 * Sixteen absorbs a burst of parallel tool-driven requests without presenting the upstream
 * provider with a spike large enough to earn a 429. Callers that fan out wider, or that share one
 * provider across many sessions, should lower it through {@link CreateModelsOptions}.
 */
export const DEFAULT_PROVIDER_CONCURRENCY = 16;
