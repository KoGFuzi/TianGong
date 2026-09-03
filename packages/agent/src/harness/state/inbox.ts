/**
 * Inbox — queued inputs whose payloads live in their own `pending.entry/{id}`
 * registers. Queue lists carry only the ids. See `harness.md` §3.2.
 */
export interface Inbox {
	/** Reserved entry ids; payloads in `pending.entry/{id}`. */
	readonly steer: readonly string[];
	/** Reserved entry ids; payloads in `pending.entry/{id}`. */
	readonly followUp: readonly string[];
	/**
	 * Reserved entry ids of deferred tree writes that arrived while the run
	 * was active; reconciled during the checkpoint procedure. Payloads
	 * are in `pending.entry/{id}` plus a `PendingEntry` envelope. See
	 * `harness.md` §3.11.
	 */
	readonly writes: readonly string[];
}

export const EMPTY_INBOX: Inbox = Object.freeze({
	steer: Object.freeze([]) as readonly string[],
	followUp: Object.freeze([]) as readonly string[],
	writes: Object.freeze([]) as readonly string[],
});
