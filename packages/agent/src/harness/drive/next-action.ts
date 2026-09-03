import type {
	OperationState,
	LaneState,
	Control,
	Generation,
	CheckpointPhase,
	ToolBatch,
	Deferred,
	StructuralDecision,
	SummaryGeneration,
	CompactionState,
	NavigationState,
	RunState,
	RunPhase,
} from "../state/index.ts";
import type { OperationError } from "../state/operation-state.ts";
import type {
	EffectPlan,
	EffectOutput,
	SettledAssistantMessage,
	ToolCallSpec,
	DriveState,
	ToolBatchContext,
	RuntimeSnapshot,
	CurrentOperation,
	EffectKey,
	LiveEffect,
	TelemetryContext,
	HookName,
} from "./types.ts";
import type {
	Effects,
	CurrentOp,
	SettlementOutput,
	SettlementResult,
	OperationResult,
	ToolSettlement,
} from "./effects.ts";
import type { AgentMessage } from "../../types.ts";

export interface DriveInputs {
	running: ReadonlyMap<EffectKey, EffectPlan>;
	deferredPollsRemaining: 0 | 1;
	deferredCancellations: ReadonlySet<string>;
	loaded: ReadonlyMap<string, unknown>;
	runtime: RuntimeSnapshot;
	now: number;
}

export type Action =
	| { kind: "transition"; next: OperationState; telemetryContext: TelemetryContext; expectedConfigurationSeq?: number }
	| { kind: "dispatch"; intent?: OperationState; effect: EffectPlan; consumeDeferredPoll?: true }
	| { kind: "await_effect"; key: EffectKey }
	| { kind: "wait"; until: number; telemetryContext: TelemetryContext }
	| { kind: "finish"; result: OperationResult }
	| { kind: "suspend"; result: OperationResult };

export function nextAction(
	state: OperationState,
	inputs: DriveInputs,
): Action {
	switch (state.kind) {
		case "run":
			return nextRunAction(state, inputs);
		case "compaction":
			return nextCompactionAction(state, inputs);
		case "navigation":
			return nextNavigationAction(state, inputs);
	}
}

function nextRunAction(state: RunState, inputs: DriveInputs): Action {
	const baseTelemetry = {} as TelemetryContext;
	const now = inputs.now;

	switch (state.phase.kind) {
	case "checkpoint":
			return handleCheckpoint(state, inputs.runtime, baseTelemetry);

		case "assistant":
			return handleAssistant(state.control, state.phase.generation, inputs, baseTelemetry);

		case "tools":
			return handleTools(state.control, state.phase.batch, inputs, baseTelemetry);

		case "compaction":
			return handleInRunCompaction(state.control, state.phase, inputs, baseTelemetry);

		case "deferred":
			return handleDeferred(state.control, state.phase.deferred, inputs, baseTelemetry);

		case "failure_drain":
			return handleFailureDrain(
				state as RunState & { phase: Extract<RunPhase, { kind: "failure_drain" }> },
				inputs,
				baseTelemetry,
			);
	}
}

function handleCheckpoint(
	state: RunState,
	runtime: RuntimeSnapshot,
	telemetry: TelemetryContext,
): Action {
	const phase = state.phase as CheckpointPhase;
	const { control, inbox, settings } = state;

	if (control.status === "cancel_requested" && isInboxEmpty(inbox)) {
		const result: OperationResult = {
			operationId: "",
			lane: "",
			kind: "run",
			outcome: "aborted",
			leafId: null,
		};
		return { kind: "finish", result };
	}

	if (phase.continuation.kind === "need_assistant") {
		const context = buildGenerationContext(phase.triggerEntryId, runtime, phase.continuation.overflowRecoveryUsed);
		const ready: Generation = {
			status: "ready",
			context,
			nextAttempt: 1,
		};
		const nextPhase: RunPhase = { kind: "assistant", generation: ready };
		return {
			kind: "transition",
			next: { kind: "run", control, settings, phase: nextPhase, inbox, latestAssistantEntryId: state.latestAssistantEntryId },
			telemetryContext: telemetry,
		};
	}

	if (phase.continuation.kind === "may_finish" && isInboxEmpty(inbox)) {
		const result: OperationResult = {
			operationId: "",
			lane: "",
			kind: "run",
			outcome: "completed",
			leafId: null,
			...(phase.continuation.includeFinalAssistant
				? { runCompletion: "assistant" as const }
				: { runCompletion: "terminated_tools" as const }),
		};
		return { kind: "finish", result };
	}

	const checkpointPhase: CheckpointPhase = {
		...phase,
		skipInboxOnce: undefined,
	};
	return {
		kind: "transition",
		next: { kind: "run", control, settings, phase: checkpointPhase, inbox, latestAssistantEntryId: state.latestAssistantEntryId },
		telemetryContext: telemetry,
	};
}

function handleAssistant(
	control: Control,
	gen: Generation,
	inputs: DriveInputs,
	telemetry: TelemetryContext,
): Action {
	if (gen.status === "ready") {
		return {
			kind: "dispatch",
			effect: {
				kind: "assistant",
				key: effectKey("assistant", gen.context.stepId, gen.nextAttempt),
				generation: { status: "effect_pending", context: gen.context, attempt: gen.nextAttempt, responseEntryId: "", usageId: "", intendedOutputLimit: 0, contextWindow: 0 },
				streamOptions: gen.context.streamOptions,
				telemetryContext: telemetry,
			},
		};
	}

	if (gen.status === "retry_wait") {
		if (inputs.now < gen.notBefore) {
			return { kind: "wait", until: gen.notBefore, telemetryContext: telemetry };
		}
		const ready: Generation = { status: "ready", context: gen.context, nextAttempt: gen.nextAttempt };
		return {
			kind: "transition",
			next: { kind: "run", control: { status: "running" }, phase: { kind: "assistant", generation: ready }, inbox: { steer: [], followUp: [], writes: [] }, latestAssistantEntryId: null, settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 }, steeringMode: "all", followUpMode: "all", toolExecution: "parallel" } } as OperationState,
			telemetryContext: telemetry,
		};
	}

	if (gen.status === "effect_pending") {
		const key = effectKey("assistant", gen.context.stepId, gen.attempt);
		const live = inputs.running.get(key);
		if (live) {
			return { kind: "await_effect", key };
		}
		const classification = classifyPending(gen, control);
		if (classification.kind === "still_pending") {
			const newGen: Generation = {
				status: "ready",
				context: gen.context,
				nextAttempt: gen.attempt + 1,
			};
			return {
				kind: "transition",
				next: { kind: "run", control: { status: "running" }, phase: { kind: "assistant", generation: newGen }, inbox: { steer: [], followUp: [], writes: [] }, latestAssistantEntryId: null, settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 }, steeringMode: "all", followUpMode: "all", toolExecution: "parallel" } } as OperationState,
				telemetryContext: telemetry,
			};
		}
		return classification.action;
	}

	throw new Error(`unknown generation status`);
}

type ClassificationResult =
	| { kind: "still_pending" }
	| { kind: "action"; action: Action };

function classifyPending(gen: Extract<Generation, { status: "effect_pending" }>, control: Control): ClassificationResult {
	if (control.status === "cancel_requested") {
		return { kind: "action", action: { kind: "finish", result: { operationId: "", lane: "", kind: "run", outcome: "aborted", leafId: null } as OperationResult } };
	}
	return { kind: "still_pending" };
}

function handleTools(
	control: Control,
	batch: ToolBatch,
	inputs: DriveInputs,
	telemetry: TelemetryContext,
): Action {
	const pendingIndex = batch.calls.findIndex((c) => c.status === "planned");
	if (pendingIndex >= 0) {
		const call = batch.calls[pendingIndex]!;
		const plan: EffectPlan = {
			kind: "tool",
			key: effectKey("tool", batch.assistantEntryId, pendingIndex),
			assistantEntryId: batch.assistantEntryId,
			sourceIndex: call.sourceIndex,
			argsKey: "",
			batchId: batch.assistantEntryId,
			planFromEffect: "never",
			telemetryContext: telemetry,
		};
		const intent: OperationState = { kind: "run", control, phase: { kind: "tools", batch }, inbox: { steer: [], followUp: [], writes: [] }, latestAssistantEntryId: null, settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 }, steeringMode: "all", followUpMode: "all", toolExecution: "parallel" } } as OperationState;
		return { kind: "dispatch", intent, effect: plan };
	}

	const awaitIndex = batch.calls.findIndex((c) => c.status === "effect_pending");
	if (awaitIndex >= 0) {
		const key = effectKey("tool", batch.assistantEntryId, awaitIndex);
		return { kind: "await_effect", key };
	}

	const allTerminated = batch.calls.every((c) => c.status === "completed" && c.terminate);
	if (allTerminated) {
		const nextPhase: RunPhase = {
			kind: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: false },
			triggerEntryId: "",
		};
		return {
			kind: "transition",
			next: { kind: "run", control, phase: nextPhase, inbox: { steer: [], followUp: [], writes: [] }, latestAssistantEntryId: null, settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 }, steeringMode: "all", followUpMode: "all", toolExecution: "parallel" } } as OperationState,
			telemetryContext: telemetry,
		};
	}

	const nextPhase: RunPhase = {
		kind: "checkpoint",
		continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
		triggerEntryId: batch.assistantEntryId,
	};
	return {
		kind: "transition",
		next: { kind: "run", control, phase: nextPhase, inbox: { steer: [], followUp: [], writes: [] }, latestAssistantEntryId: null, settings: { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 }, steeringMode: "all", followUpMode: "all", toolExecution: "parallel" } } as OperationState,
		telemetryContext: telemetry,
	};
}

function handleInRunCompaction(
	control: Control,
	phase: {
		readonly kind: "compaction";
		readonly reason: "threshold" | "overflow";
		readonly structural: StructuralDecision;
		readonly resumeAfter: CheckpointPhase;
	},
	inputs: DriveInputs,
	telemetry: TelemetryContext,
): Action {
	return handleStructural(control, phase.structural, inputs, telemetry);
}

function handleStructural(
	control: Control,
	structural: StructuralDecision,
	inputs: DriveInputs,
	telemetry: TelemetryContext,
): Action {
	if (structural.status === "deciding") {
		return { kind: "dispatch", effect: { kind: "hook", key: effectKey("hook", structural.taskId, 0), name: "before_compaction", event: { taskId: structural.taskId }, telemetryContext: telemetry } };
	}

	const gen = structural.generation;
	if (gen.status === "ready") {
			return {
				kind: "dispatch",
				effect: {
					kind: "summary",
				key: effectKey("summary", structural.taskId, gen.nextAttempt),
				generation: { status: "effect_pending", context: gen.context, attempt: gen.nextAttempt, usageIds: [] },
				streamOptions: gen.context.streamOptions,
				telemetryContext: telemetry,
			},
		};
	}

	if (gen.status === "retry_wait") {
		if (inputs.now < gen.notBefore) {
			return { kind: "wait", until: gen.notBefore, telemetryContext: telemetry };
		}
		return {
			kind: "transition",
			next: { kind: "compaction", control, customInstructions: undefined, structural: { taskId: structural.taskId, status: "generating", generation: { status: "ready", context: gen.context, nextAttempt: gen.nextAttempt } } } as OperationState,
			telemetryContext: telemetry,
		};
	}

	if (gen.status === "effect_pending") {
		const key = effectKey("summary", structural.taskId, gen.attempt);
		if (inputs.running.has(key)) {
			return { kind: "await_effect", key };
		}
		return {
			kind: "transition",
			next: { kind: "compaction", control, customInstructions: undefined, structural: { taskId: structural.taskId, status: "generating", generation: { status: "ready", context: gen.context, nextAttempt: gen.attempt + 1 } } } as OperationState,
			telemetryContext: telemetry,
		};
	}

	throw new Error(`unknown structural status`);
}

function handleDeferred(
	control: Control,
	deferred: Deferred,
	inputs: DriveInputs,
	telemetry: TelemetryContext,
): Action {
	if (deferred.status === "suspended") {
		if (inputs.deferredPollsRemaining === 0) {
			return { kind: "suspend", result: { operationId: "", lane: "", kind: "run", outcome: "failed", leafId: null, error: { code: "deferred_timeout", message: "no deferred poll permits" } } as OperationResult };
		}
		const nextDeferred: Deferred = { ...deferred, status: "effect_pending", poll: deferred.poll + 1, responseEntryId: `deferred-resp-${deferred.poll + 1}`, usageId: `deferred-usage-${deferred.poll + 1}` };
		return {
			kind: "dispatch",
			effect: {
				kind: "deferred_fetch",
				key: effectKey("deferred", deferred.sourceEntryId, deferred.poll + 1),
				deferred: nextDeferred,
				streamOptions: deferred.streamOptions,
				telemetryContext: telemetry,
			},
			consumeDeferredPoll: true,
		};
	}

	if (deferred.status === "effect_pending") {
		const key = effectKey("deferred", deferred.sourceEntryId, deferred.poll);
		if (inputs.running.has(key)) {
			return { kind: "await_effect", key };
		}
		return { kind: "suspend", result: { operationId: "", lane: "", kind: "run", outcome: "failed", leafId: null, error: { code: "deferred_unknown", message: "deferred effect not found" } } as OperationResult };
	}

	throw new Error(`unknown deferred status`);
}


function handleFailureDrain(
	state: RunState & { phase: Extract<RunPhase, { kind: "failure_drain" }> },
	_inputs: DriveInputs,
	telemetry: TelemetryContext,
): Action {
	const { control, phase, inbox, settings, latestAssistantEntryId } = state;
	if (control.status === "cancel_requested") {
		return { kind: "finish", result: { operationId: "", lane: "", kind: "run", outcome: "aborted", leafId: null } as OperationResult };
	}

	if (inbox.steer.length || inbox.followUp.length || inbox.writes.length) {
		return {
			kind: "transition",
			next: { kind: "run", control, phase: { kind: "checkpoint", continuation: { kind: "need_assistant", overflowRecoveryUsed: false }, triggerEntryId: "" }, inbox: { steer: [], followUp: [], writes: [] }, latestAssistantEntryId, settings },
			telemetryContext: telemetry,
		};
	}

	return { kind: "finish", result: { operationId: "", lane: "", kind: "run", outcome: "failed", leafId: null, error: phase.error } as OperationResult };
}

function nextCompactionAction(state: CompactionState, inputs: DriveInputs): Action {
	const telemetry = {} as TelemetryContext;
	return handleStructural(state.control, state.structural, inputs, telemetry);
}

function nextNavigationAction(state: NavigationState, inputs: DriveInputs): Action {
	const telemetry = {} as TelemetryContext;
	if (state.summarize === false) {
		if (state.phase.kind === "ready_to_commit") {
			return { kind: "finish", result: { operationId: "", lane: "", kind: "navigation", outcome: "completed", leafId: state.targetId } as OperationResult };
		}
	}
	if (state.summarize === true && state.phase.kind === "summary") {
		return handleStructural(state.control, state.phase.structural, inputs, telemetry);
	}
	return { kind: "finish", result: { operationId: "", lane: "", kind: "navigation", outcome: "completed", leafId: null } as OperationResult };
}

export function effectKey(kind: string, id: string, attempt: number): EffectKey {
	return `${kind}:${id}:${attempt}`;
}

function buildGenerationContext(
	triggerEntryId: string,
	runtime: RuntimeSnapshot,
	overflowRecoveryUsed: boolean,
): import("../state/index.js").GenerationContext {
	return {
		stepId: `step-${triggerEntryId}`,
		triggerEntryId,
		configuration: runtime.configuration,
		streamOptions: runtime.streamOptions,
		retryPolicy: runtime.retryPolicy,
		overflowRecoveryUsed,
	};
}

function isInboxEmpty(inbox: import("../state/index.js").Inbox): boolean {
	return inbox.steer.length === 0 && inbox.followUp.length === 0 && inbox.writes.length === 0;
}

function makeRunStateBase(state: RunState): Omit<RunState, "phase"> {
	return {
		kind: "run",
		control: state.control,
		settings: state.settings,
		inbox: state.inbox,
		latestAssistantEntryId: state.latestAssistantEntryId,
	};
}
