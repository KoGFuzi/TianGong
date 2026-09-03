import type { LaneConfiguration, NormalizedRetryPolicy } from "./generation.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";

/**
 * StructuralDecision — the `deciding` / `generating` phase of a
 * structural operation. The state carries only `taskId`; the durable
 * preparation is held in `op.preparation/{operationId}:{taskId}` and
 * located by that deterministic key. See `harness.md` §3.9.
 */
export type StructuralDecision =
	| { readonly taskId: string; readonly status: "deciding" }
	| {
			readonly taskId: string;
			readonly status: "generating";
			readonly generation: SummaryGeneration;
	  };

/**
 * SummaryGeneration — one structural attempt may make one or two provider
 * requests using the existing compaction implementation. The
 * `usageIds[]` array covers every nested request. After one nested
 * request returns, its `request` slot is cleared and a fresh request
 * intent is committed before request two begins. See `harness.md` §3.2.
 */
export type SummaryGeneration =
	| {
			readonly status: "ready";
			readonly context: SummaryContext;
			readonly nextAttempt: number;
	  }
	| {
			readonly status: "effect_pending";
			readonly context: SummaryContext;
			readonly attempt: number;
			/** Current nested request intent; absent between requests. */
			readonly request?: { readonly index: number; readonly usageId: string };
			readonly usageIds: readonly string[];
	  }
	| {
			readonly status: "retry_wait";
			readonly context: SummaryContext;
			readonly nextAttempt: number;
			readonly notBefore: number;
			readonly errorMessage: string;
	  };

export interface SummaryContext {
	readonly taskId: string;
	readonly resultEntryId: string;
	readonly kind: "compaction" | "branch_summary";
	readonly configuration: LaneConfiguration;
	readonly streamOptions: AgentHarnessStreamOptions;
	readonly retryPolicy: NormalizedRetryPolicy;
	readonly reason?: "manual" | "threshold" | "overflow";
}
