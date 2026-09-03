/**
 * OperationError — stable, structured error descriptor surfaced in
 * `lane.lastResult.error`, `failure_drain.error`, and tool synthetic
 * results. See `harness.md` §3.2 / §3.7 / §3.13.
 */
export interface OperationError {
	readonly code: string;
	readonly message: string;
	readonly details?: unknown;
}

import type { AgentMessage } from "../../types.ts";
import type { JsonValue } from "../session/index.ts";
import type { Control } from "./control.ts";
import type { Inbox } from "./inbox.ts";
import type { CheckpointPhase } from "./checkpoint-phase.ts";
import type { Generation } from "./generation.ts";
import type { ToolBatch } from "./tool-batch.ts";
import type { Deferred } from "./deferred.ts";
import type { StructuralDecision } from "./structural.ts";

/**
 * RunPhase — the active sub-state of a run. Mutates along:
 *   checkpoint → assistant(ready|effect_pending|retry_wait) → tools → checkpoint
 *                    └→ compaction(reason=threshold|overflow) → checkpoint
 *                    └→ deferred(suspended|effect_pending) → checkpoint
 *                    └→ failure_drain(error)
 * See `harness.md` §3.2 / §3.5.
 */
export type RunPhase =
	| CheckpointPhase
	| { readonly kind: "assistant"; readonly generation: Generation }
	| { readonly kind: "tools"; readonly batch: ToolBatch }
	| {
			readonly kind: "compaction";
			readonly reason: "threshold" | "overflow";
			readonly structural: StructuralDecision;
			readonly resumeAfter: CheckpointPhase;
	  }
	| { readonly kind: "deferred"; readonly deferred: Deferred }
	| {
			readonly kind: "failure_drain";
			readonly error: OperationError;
			readonly provenance:
				| { readonly kind: "response"; readonly entryId: string }
				| { readonly kind: "structural"; readonly taskId: string };
	  };

/**
 * RunSettings — captured atomically at acceptance; setters affect later
 * operations. See `harness.md` §3.2.
 */
export interface RunSettings {
	readonly compaction: { readonly enabled: boolean; readonly keepRecentTokens: number; readonly reserveTokens: number };
	readonly steeringMode: "all" | "one-at-a-time";
	readonly followUpMode: "all" | "one-at-a-time";
	readonly toolExecution: "sequential" | "parallel";
}

/**
 * RunState — one of the three OperationState variants. Holds the
 * lane-owned control plane, the captured run settings, the active
 * RunPhase, the inbox, and `latestAssistantEntryId` (the newest
 * settled assistant response). See `harness.md` §3.2.
 */
export interface RunState {
	readonly kind: "run";
	readonly control: Control;
	readonly settings: RunSettings;
	readonly phase: RunPhase;
	readonly inbox: Inbox;
	/** Newest durable assistant generation/fetch response in this operation. */
	readonly latestAssistantEntryId: string | null;
}

/**
 * CompactionState — the active sub-state of a compaction operation.
 * Always has a `StructuralDecision`; the generation either declines the
 * structural call (manual) and finishes `declined`, or generates the
 * summary, settles the compaction_entry + usage, and finishes `completed`
 * (or `failed` if generation failed). See `harness.md` §3.9.
 */
export interface CompactionState {
	readonly kind: "compaction";
	readonly control: Control;
	readonly customInstructions?: string;
	readonly structural: StructuralDecision;
}

/**
 * NavigationState — one of two phases. Unsummarized navigation (the
 * default) commits in `ready_to_commit` and the terminal transaction
 * publishes the leaf move (§3.10). Summarized navigation writes
 * `op.preparation` and enters `summary.deciding`. See `harness.md`
 * §3.2 / §3.10.
 */
export type NavigationState =
	| {
			readonly kind: "navigation";
			readonly control: Control;
			readonly targetId: string | null;
			readonly label?: string;
			readonly summarize: false;
			readonly phase: { readonly kind: "ready_to_commit" };
	  }
	| {
			readonly kind: "navigation";
			readonly control: Control;
			readonly targetId: string;
			readonly label?: string;
			readonly customInstructions?: string;
			readonly summarize: true;
			readonly phase: { readonly kind: "summary"; readonly structural: StructuralDecision };
	  };

/**
 * OperationState — the program counter. Total — every transition
 * overwrites the whole register. There is no "finished" member; an ended
 * operation has no state at all. See `harness.md` §3.2 / §3.13.
 */
export type OperationState = RunState | CompactionState | NavigationState;

/**
 * LaneState — the `lane.state/{lane}` register. Holds only
 * `currentOperationId` (null when idle) and the lane-owned
 * `pendingNextRun` queue. See `harness.md` §3.3.
 */
export interface LaneState {
	readonly currentOperationId: string | null;
	/** Reserved entry ids; payloads in `pending.entry/{id}`. */
	readonly pendingNextRun: readonly string[];
}

/**
 * OperationMeta — acceptance data written once at `op.meta/{id}`. See
 * `harness.md` §3.1.
 */
export interface OperationMeta {
	readonly operationId: string;
	readonly lane: string;
	readonly sourceLeafId: string | null;
	readonly startedAt: number;
	readonly intent:
		| {
				readonly kind: "run";
				readonly promptEntryIds: readonly string[];
				readonly systemPromptOverride?: string;
				readonly resumeData?: Record<string, JsonValue>;
		  }
		| { readonly kind: "compaction"; readonly customInstructions?: string }
		| {
				readonly kind: "navigation";
				readonly targetId: string | null;
				readonly summarize: boolean;
				readonly label?: string;
				readonly customInstructions?: string;
		  };
}

/**
 * LaneLastResult — the `lane.lastResult/{lane}` register written only by
 * terminal transactions. See `harness.md` §3.13.
 */
export type LaneLastResult = {
	readonly operationId: string;
	readonly kind: "run" | "compaction" | "navigation";
	readonly leafId: string | null;
	/** Newest settled assistant, when the outcome includes one (runs only). */
	readonly finalAssistantEntryId?: string;
} & (
	| { readonly outcome: "failed"; readonly error: OperationError; readonly runCompletion?: never }
	| {
			readonly outcome: "completed";
			readonly error?: never;
			readonly runCompletion?: "assistant" | "terminated_tools";
	  }
	| { readonly outcome: "declined" | "aborted"; readonly error?: never; readonly runCompletion?: never }
);
