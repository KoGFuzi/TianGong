import type {
	Generation,
	SummaryGeneration,
	Deferred,
	OperationState,
	LaneState,
} from "../state/index.ts";
import type { AgentMessage } from "../../types.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";
import type { LaneConfiguration } from "../state/generation.ts";

export type EffectKey = string;

export interface LiveEffect {
	plan: EffectPlan;
	promise: Promise<EffectOutput>;
}

export interface DriveState {
	deferredPollsRemaining: 0 | 1;
	running: Map<EffectKey, LiveEffect>;
	toolBatches: Map<string, ToolBatchContext>;
	deferredCancellations: Set<string>;
}

export interface ToolBatchContext {
	batchId: string;
	assistantEntryId: string;
	configuration: LaneConfiguration;
	turnId: string;
	toolContext: unknown;
}

export function newDriveState(): DriveState {
	return {
		deferredPollsRemaining: 1,
		running: new Map(),
		toolBatches: new Map(),
		deferredCancellations: new Set(),
	};
}

export type HookName =
	| "before_run"
	| "resume"
	| "transform_context"
	| "before_request"
	| "before_tool"
	| "after_response"
	| "after_tool"
	| "before_compaction"
	| "before_navigation"
	| "before_run_end";

export type TelemetryContext = unknown;

export interface CompactResult {
	readonly summary: string;
	readonly retainedTail: readonly AgentMessage[];
	readonly tokensBefore: number;
	readonly usage?: unknown;
	readonly details?: unknown;
}

export interface BranchSummaryResult {
	readonly summary: string;
	readonly usage?: unknown;
}

export type SummaryAttemptOutcome =
	| { kind: "success"; result: CompactResult | BranchSummaryResult }
	| { kind: "retry"; error: { code: string; message: string } }
	| { kind: "failure"; error: { code: string; message: string } };

export type EffectPlan = {
	telemetryContext: TelemetryContext;
} & (
	| {
			kind: "assistant";
			key: EffectKey;
			generation: Extract<Generation, { status: "effect_pending" }>;
			streamOptions: AgentHarnessStreamOptions;
	  }
	| {
			kind: "summary";
			key: EffectKey;
			generation: Extract<SummaryGeneration, { status: "effect_pending" }>;
			streamOptions: AgentHarnessStreamOptions;
	  }
	| {
			kind: "tool";
			key: EffectKey;
			assistantEntryId: string;
			sourceIndex: number;
			argsKey: string;
			batchId: string;
			planFromEffect: "safe" | "never";
	  }
	| {
			kind: "deferred_fetch";
			key: EffectKey;
			deferred: Extract<Deferred, { status: "effect_pending" }>;
			streamOptions: AgentHarnessStreamOptions;
	  }
	| {
			kind: "cancel_deferred";
			key: EffectKey;
			sourceEntryId: string;
			handle: unknown;
	  }
	| {
			kind: "hook";
			key: EffectKey;
			name: HookName;
			event: unknown;
	  }
);

export type StopReason =
	| "stop"
	| "length"
	| "toolUse"
	| "error"
	| "aborted"
	| "deferred";

export interface ToolCallSpec {
	readonly id: string;
	readonly name: string;
	readonly arguments: unknown;
}

export interface SettledAssistantMessage {
	readonly stopReason: StopReason;
	readonly message: AgentMessage;
	readonly usage?: unknown;
	readonly intent?: {
		readonly toolCalls?: readonly ToolCallSpec[];
		readonly isError?: boolean;
	};
}

export type EffectOutput =
	| { kind: "not_started"; key: EffectKey }
	| {
			kind: "assistant";
			key: EffectKey;
			message: SettledAssistantMessage;
	  }
	| {
			kind: "summary";
			key: EffectKey;
			outcome: SummaryAttemptOutcome;
	  }
	| {
			kind: "tool_raw";
			key: EffectKey;
			result: unknown;
			isError: boolean;
	  }
	| {
			kind: "deferred_fetch";
			key: EffectKey;
			message: SettledAssistantMessage;
	  }
	| {
			kind: "cancel_deferred";
			key: EffectKey;
			cancelled: boolean;
	  }
	| {
			kind: "hook";
			key: EffectKey;
			result: unknown;
	  };

export interface CurrentOperation {
	operationId: string;
	lane: string;
	kind: "run" | "compaction" | "navigation";
	operationStateSeq: number;
	laneStateSeq: number;
	leafId: string | null;
	configuration: LaneConfiguration;
	configurationSeq: number;
	state: OperationState;
	laneState: LaneState;
}

export interface RuntimeSnapshot {
	configuration: LaneConfiguration;
	configurationSeq: number;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: { maxAttempts: number; baseDelayMs: number };
}