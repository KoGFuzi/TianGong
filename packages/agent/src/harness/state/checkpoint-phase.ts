/**
 * Continuation — what the checkpoint expects next. See `harness.md` §3.2.
 */
export type Continuation =
	| { kind: "need_assistant"; overflowRecoveryUsed: boolean }
	| { kind: "may_finish"; includeFinalAssistant: boolean };

/**
 * CheckpointPhase — the dormant state of a run between turns. Holds the
 * continuation and the `triggerEntryId` for the next transition. The
 * optional `skipInboxOnce` flag is set by projecting drain and cleared
 * when generation starts (so a crash cannot accidentally widen
 * `one-at-a-time` to `all`). See `harness.md` §3.2.
 */
export interface CheckpointPhase {
	readonly kind: "checkpoint";
	readonly continuation: Continuation;
	/** Durable correlation source for the next generation step. */
	readonly triggerEntryId: string;
	/**
	 * Threshold compaction is attempted at most once per trigger boundary.
	 * Set when entering threshold compaction; cleared by the next checkpoint.
	 * See `harness.md` §3.12.
	 */
	readonly thresholdCheckedTriggerEntryId?: string;
	/** Generate before draining another queued input after one-at-a-time drain. */
	readonly skipInboxOnce?: boolean;
}
