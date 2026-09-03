import type { AssistantMessage } from "@onepanda-tiangongsec/tg-ai";
import type { CheckpointPhase } from "../state/checkpoint-phase.ts";
import type { RunPhase, RunState } from "../state/operation-state.ts";
import type { Generation } from "../state/generation.ts";
import type { Control } from "../state/control.ts";
import type { ToolBatch } from "../state/tool-batch.ts";
import type { Deferred } from "../state/deferred.ts";
import type { GenerationSettlement } from "./classification.ts";

export interface GenerationTransitionContext {
	readonly state: RunState;
	readonly generation: Extract<Generation, { status: "effect_pending" }>;
	readonly responseEntryId: string;
	readonly message: AssistantMessage;
	readonly now: number;
	readonly nextToolResultIds?: readonly string[];
	readonly deferred?: Deferred;
	readonly toolBatch?: ToolBatch;
}

/**
 * Purely applies a settled generation to the next durable run state.
 * Entry/usage publication is deliberately separate and is performed by the
 * caller in the same atomic transaction as this returned state.
 */
export function transitionGeneration(
	context: GenerationTransitionContext,
	settlement: GenerationSettlement,
): RunState {
	const { state, generation, responseEntryId } = context;
	const base = { ...state, latestAssistantEntryId: responseEntryId };

	switch (settlement.kind) {
		case "aborted":
			return {
				...base,
				phase: checkpoint(responseEntryId, { kind: "may_finish", includeFinalAssistant: true }),
			};
		case "completed":
			return {
				...base,
				phase: checkpoint(responseEntryId, { kind: "may_finish", includeFinalAssistant: true }),
			};
		case "tool_use": {
				const calls = (settlement.message.content.filter((block) => block.type === "toolCall") as Array<{
					type: "toolCall";
					id: string;
					name: string;
					arguments: Record<string, unknown>;
				}>).map((call, sourceIndex) => ({
					status: "planned" as const,
					sourceIndex,
					resultEntryId: context.nextToolResultIds?.[sourceIndex] ?? `${responseEntryId}:tool:${sourceIndex}`,
				}));
				return {
					...base,
					phase: {
						kind: "tools",
						batch: {
							assistantEntryId: responseEntryId,
							configuration: {
								model: { provider: settlement.message.provider, modelId: settlement.message.model },
								thinkingLevel: "off",
								activeToolNames: [],
							},
							turnId: responseEntryId,
							calls,
						},
					},
				};
			}
		case "deferred":
			return { ...base, phase: { kind: "deferred", deferred: context.deferred ?? ({ status: "suspended", stepId: generation.context.stepId, sourceEntryId: responseEntryId, poll: 0, configuration: generation.context.configuration, streamOptions: generation.context.streamOptions } as Deferred) } };
		case "overflow":
			return {
				...base,
				phase: {
					kind: "compaction",
					reason: "overflow",
					structural: { taskId: `${responseEntryId}:compaction`, status: "deciding" },
					resumeAfter: { kind: "checkpoint", triggerEntryId: responseEntryId, continuation: { kind: "need_assistant", overflowRecoveryUsed: true } },
				},
			};
		case "retry":
			return {
				...base,
				phase: {
					kind: "assistant",
					generation: {
						status: "retry_wait",
						context: generation.context,
						nextAttempt: settlement.nextAttempt,
						notBefore: saturatingBackoff(context.now, generation.attempt, generation.context.retryPolicy.baseDelayMs),
						errorMessage: settlement.errorMessage,
					},
				},
			};
		case "failed":
			return { ...base, phase: { kind: "failure_drain", error: { code: "provider_error", message: settlement.errorMessage }, provenance: { kind: "response", entryId: responseEntryId } } };
	}
}

function checkpoint(triggerEntryId: string, continuation: CheckpointPhase["continuation"]): CheckpointPhase {
	return { kind: "checkpoint", triggerEntryId, continuation };
}

function saturatingBackoff(now: number, attempt: number, baseDelayMs: number): number {
	const delay = baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return now + Math.min(Number.MAX_SAFE_INTEGER - now, Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER - now);
}
