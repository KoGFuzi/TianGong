/**
 * Resets the monotonic generator state. Test-only: earlier tests calling
 * `uuidv7()` with the real clock leave `lastOrdinaryTimestamp` in the future
 * relative to a fake clock, which would otherwise leak across suites that
 * share the module instance.
 */
export declare function resetUuidv7State(): void;
/** Generate a time-ordered UUIDv7. A supplied timestamp is preserved for follower ids. */
export declare function uuidv7(timestampMs?: number): string;
