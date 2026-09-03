import type {
	OperationState,
	LaneState,
	Control,
	Generation,
	SummaryGeneration,
	Deferred,
	ToolCall,
} from "../state/index.ts";
import type { LaneConfiguration } from "../state/generation.ts";
import type {
	EffectPlan,
	EffectOutput,
	SettledAssistantMessage,
	SummaryAttemptOutcome,
	ToolCallSpec,
	CompactResult,
	BranchSummaryResult,
	TelemetryContext,
	HookName,
} from "./types.ts";
import type { AgentMessage } from "../../types.ts";

export interface Effects {
	commitTransition(
		current: CurrentOp,
		next: OperationState,
		telemetry: TelemetryContext,
		expectedConfigurationSeq?: number,
	): Promise<CurrentOp | undefined>;
	commitEffectSettlement(
		current: CurrentOp,
		plan: EffectPlan,
		output: SettlementOutput,
		telemetry: TelemetryContext,
	): Promise<SettlementResult>;
	commitTerminal(
		current: CurrentOp,
		result: OperationResult,
	): Promise<CurrentOp | undefined>;
	finalizeTool(
		plan: Extract<EffectPlan, { kind: "tool" }>,
		output: Extract<EffectOutput, { kind: "tool_raw" }>,
	): Promise<ToolSettlement>;
	runSummaryRequest(req: {
		taskId: string;
		attempt: number;
		requestIndex: number;
		usageId: string;
		configuration: LaneConfiguration;
		messages: readonly AgentMessage[];
		telemetryContext: TelemetryContext;
	}): Promise<SummaryRequestOutput>;
	settleSummaryRequest(
		current: CurrentOp,
		plan: {
			taskId: string;
			attempt: number;
			requestIndex: number;
			usageId: string;
		},
		response: SettledAssistantMessage,
		telemetry: TelemetryContext,
	): Promise<CurrentOp>;
	run(plan: EffectPlan): Promise<EffectOutput>;
	sleep(delayMs: number, telemetry: TelemetryContext): Promise<void>;
	runHook(name: HookName, event: unknown): Promise<unknown>;
}

export interface CurrentOp {
	operationId: string;
	lane: string;
	kind: "run" | "compaction" | "navigation";
	state: OperationState;
	operationStateSeq: number;
	laneState: LaneState;
	laneStateSeq: number;
	leafId: string | null;
	configuration: LaneConfiguration;
	configurationSeq: number;
}

export type SettlementOutput =
	| Exclude<EffectOutput, { kind: "tool_raw" }>
	| { kind: "tool"; key: string; result: ToolSettlement };

export interface ToolSettlement {
	resultEntryId: string;
	terminate: boolean;
	message: AgentMessage;
	usage?: unknown;
}

export interface SettlementResult {
	current: CurrentOp;
	dispatch?: EffectPlan;
	suspend?: OperationResult;
	consumeDeferredPoll?: true;
}

export type OperationResult = RunOutcome | CompactionOutcome | NavigationOutcome;

export interface RunOutcome {
	operationId: string;
	lane: string;
	kind: "run";
	outcome: "completed" | "aborted" | "failed" | "declined";
	leafId: string | null;
	finalAssistantEntryId?: string;
	runCompletion?: "assistant" | "terminated_tools";
	error?: { code: string; message: string };
}

export interface CompactionOutcome {
	operationId: string;
	lane: string;
	kind: "compaction";
	outcome: "completed" | "aborted" | "failed" | "declined";
	leafId: string | null;
	error?: { code: string; message: string };
}

export interface NavigationOutcome {
	operationId: string;
	lane: string;
	kind: "navigation";
	outcome: "completed" | "aborted" | "failed" | "declined";
	leafId: string | null;
	error?: { code: string; message: string };
}

export type SummaryRequestOutput =
	| { kind: "response"; message: SettledAssistantMessage }
	| { kind: "not_started" };

export interface EffectFactory {
	generateAssistant(
		configuration: LaneConfiguration,
		messages: readonly AgentMessage[],
		attempt: number,
		signal: AbortSignal,
	): Promise<SettledAssistantMessage>;
	runTool(
		name: string,
		args: unknown,
		toolContext: unknown,
		signal: AbortSignal,
	): Promise<{ result: unknown; isError: boolean }>;
	fetchDeferred(
		handle: unknown,
		options: { wait: number },
		configuration: LaneConfiguration,
		signal: AbortSignal,
	): Promise<{ message: SettledAssistantMessage } | { pending: true }>;
	cancelDeferred(handle: unknown): Promise<void>;
}
