import type { AgentHarnessStreamOptions } from "../types.ts";

/**
 * Normalized retry policy — the operation-state-safe form captured inline
 * in `GenerationContext`. `maxAttempts` is `maxRetries + 1` normalized; a
 * disabled retry is one attempt. See `harness.md` §0.7 / §3.2.
 */
export interface NormalizedRetryPolicy {
	readonly maxAttempts: number;
	readonly baseDelayMs: number;
}

export interface LaneConfiguration {
	readonly model: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel: ThinkingLevel;
	readonly activeToolNames: readonly string[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "max";

/**
 * GenerationContext — an inline snapshot of the lane configuration at step
 * start. Snapshots configuration, stream options, and retry policy so that
 * recovery can report exactly what is missing without resolving anything.
 * See `harness.md` §3.2.
 */
export interface GenerationContext {
	readonly stepId: string;
	readonly triggerEntryId: string;
	/** Inline snapshot of the lane configuration at step start. */
	readonly configuration: LaneConfiguration;
	readonly streamOptions: AgentHarnessStreamOptions;
	readonly retryPolicy: NormalizedRetryPolicy;
	/** Copied from the producing checkpoint's `need_assistant` continuation so
	 * a settlement classified after crash-restore still knows whether overflow
	 * recovery was already spent. See `harness.md` §3.2. */
	readonly overflowRecoveryUsed: boolean;
}

/**
 * Generation — the assistant-generation phase of a run. `ready` →
 * `effect_pending` (after `before_request` runs and intent is committed) →
 * `retry_wait` (on a retryable error with attempts remaining) → back to
 * `ready` once `notBefore` elapses. Settlement classifies the response into
 * tools / checkpoint / compaction / deferred / failure_drain. See
 * `harness.md` §3.2 / §3.7.
 */
export type Generation =
	| {
			readonly status: "ready";
			readonly context: GenerationContext;
			readonly nextAttempt: number;
	  }
	| {
			readonly status: "effect_pending";
			readonly context: GenerationContext;
			readonly attempt: number;
			readonly responseEntryId: string;
			readonly usageId: string;
			readonly intendedOutputLimit: number;
			readonly contextWindow: number;
	  }
	| {
			readonly status: "retry_wait";
			readonly context: GenerationContext;
			readonly nextAttempt: number;
			readonly notBefore: number;
			readonly errorMessage: string;
	  };
