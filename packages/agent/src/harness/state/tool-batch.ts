import type { LaneConfiguration } from "./generation.ts";

/**
 * ToolBatch — a batch of tool calls produced by one assistant generation.
 * The batch is cleared in source order, may dispatch in parallel, and
 * commits result entries in source order. The `op.tool_args/{opId}:{stepId}:{sourceIndex}`
 * register is written once at clearance and deleted either at the last
 * settlement (when the batch finishes) or by the terminal transaction's
 * prefix scan. See `harness.md` §3.2 / §3.8.
 */
export interface ToolBatch {
	readonly assistantEntryId: string;
	/** Producing generation/fetch snapshot; active tool names come from here. */
	readonly configuration: LaneConfiguration;
	/** The assistant generation step id; recovered tool events use it as turnId. */
	readonly turnId: string;
	readonly calls: readonly ToolCall[];
}

/**
 * ToolCall — a single tool call in a batch. `status` is monotonic:
 * `planned` → `effect_pending` (after `before_tool` clearance + `op.tool_args`
 * write) → `completed` (after effect settlement + `after_tool`).
 *
 * Blocked/invalid calls skip the intent commit and the effect but still
 * commit a synthetic result at their source position. See `harness.md` §3.8.
 */
export type ToolCall =
	| {
			readonly status: "planned";
			readonly sourceIndex: number;
			readonly resultEntryId: string;
	  }
	| {
			readonly status: "effect_pending";
			readonly sourceIndex: number;
			readonly resultEntryId: string;
			readonly replay: "never" | "safe";
	  }
	| {
			readonly status: "completed";
			readonly sourceIndex: number;
			readonly resultEntryId: string;
			readonly terminate: boolean;
	  };

export function batchAllTerminated(batch: ToolBatch): boolean {
	return batch.calls.length > 0 && batch.calls.every((call) => {
		if (call.status !== "completed") return false;
		return call.terminate;
	});
}

export function batchHasCompleted(batch: ToolBatch): boolean {
	return batch.calls.some((call) => call.status === "completed");
}