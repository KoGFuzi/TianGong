import type { OperationState } from "../state/operation-state.ts";
import type {
	CurrentOperation,
	DriveState,
	EffectKey,
	EffectOutput,
	EffectPlan,
	RuntimeSnapshot,
} from "./types.ts";
import type { Action, DriveInputs } from "./next-action.ts";
import type { Effects, OperationResult, SettlementOutput } from "./effects.ts";
import { nextAction } from "./next-action.ts";
import { classifyGeneration } from "./classification.ts";

/**
 * Runtime adapter for the Part 4 interpreter. Storage and external effects
 * are deliberately injected, so the driver is independent of Memory/JSONL
 * implementations and can be gated by manual-drive tests.
 */
export interface DriverRuntime {
	load(operationId: string): Promise<CurrentOperation>;
	loadInputs(current: CurrentOperation, drive: DriveState): Promise<DriveInputs>;
	commitTransition(current: CurrentOperation, next: OperationState): Promise<CurrentOperation | undefined>;
	commitEffectSettlement(
		current: CurrentOperation,
		plan: EffectPlan,
		output: SettlementOutput,
	): Promise<CurrentOperation | undefined>;
	/**
	 * Applies the pure generation classification result to the durable state.
	 * Keeping this separate from `commitEffectSettlement` lets providers remain
	 * unaware of overflow/retry policy and makes the classification testable.
	 */
	commitGenerationSettlement?(
		current: CurrentOperation,
		plan: Extract<EffectPlan, { kind: "assistant" }>,
		classification: ReturnType<typeof classifyGeneration>,
	): Promise<CurrentOperation | undefined>;
	commitTerminal(current: CurrentOperation, result: OperationResult): Promise<CurrentOperation | undefined>;
	makeEffect(plan: EffectPlan): Promise<EffectOutput>;
	getRuntimeSnapshot(current: CurrentOperation): RuntimeSnapshot;
	manual?: boolean;
	awaitAction?(action: Action): Promise<void>;
}

export interface DriveResult {
	readonly result: OperationResult;
	readonly steps: number;
}

/**
 * Drives one accepted operation until terminal or suspension. There is no
 * provider/tool work in the mutation line: actions commit intent first,
 * install a process-local promise, and settle through the injected runtime.
 */
export async function drive(
	runtime: DriverRuntime,
	initial: CurrentOperation,
	driveState: DriveState,
	options: { readonly maxSteps?: number } = {},
): Promise<DriveResult> {
	let current = initial;
	let steps = 0;
	const maxSteps = options.maxSteps ?? 10_000;

	while (steps++ < maxSteps) {
		const inputs = await runtime.loadInputs(current, driveState);
		const action = nextAction(current.state, {
			...inputs,
			runtime: runtime.getRuntimeSnapshot(current),
			now: Date.now(),
		});

		if (runtime.manual && runtime.awaitAction) await runtime.awaitAction(action);

		switch (action.kind) {
			case "transition": {
				const updated = await runtime.commitTransition(current, action.next);
				if (!updated) return { result: externalFinalization(current), steps };
				current = updated;
				break;
			}

			case "dispatch": {
				if (action.intent) {
					const updated = await runtime.commitTransition(current, action.intent);
					if (!updated) return { result: externalFinalization(current), steps };
					current = updated;
				}
				if (action.consumeDeferredPoll) driveState.deferredPollsRemaining = 0;
				const promise = runtime.makeEffect(action.effect);
				driveState.running.set(action.effect.key, { plan: action.effect, promise });
				break;
			}

			case "await_effect": {
				const live = driveState.running.get(action.key);
				if (!live) {
					// A missing live effect is the normal post-crash position. Replan
					// from durable effect_pending state.
					break;
				}
				driveState.running.delete(action.key);
				const output = await live.promise;
				const settled = await settleOutput(runtime, current, live.plan, output);
				if (!settled) return { result: externalFinalization(current), steps };
				current = settled;
				break;
			}

			case "wait":
				await sleepUntil(action.until);
				break;

			case "suspend":
				return { result: action.result, steps };

			case "finish": {
				const updated = await runtime.commitTerminal(current, action.result);
				return { result: updated ? action.result : externalFinalization(current), steps };
			}
		}
	}

	throw new Error(`Operation interpreter exceeded ${maxSteps} steps`);
}

async function settleOutput(
	runtime: DriverRuntime,
	current: CurrentOperation,
	plan: EffectPlan,
	output: EffectOutput,
): Promise<CurrentOperation | undefined> {
	if (plan.kind === "cancel_deferred") return current;
	if (plan.kind === "assistant" && output.kind === "assistant" && runtime.commitGenerationSettlement) {
		const classification = classifyGeneration({
			control: current.state.kind === "run" ? current.state.control : { status: "running" },
			message: output.message.message as never,
			attempt: plan.generation.attempt,
			maxAttempts: plan.generation.context.retryPolicy.maxAttempts,
			intendedOutputLimit: plan.generation.intendedOutputLimit,
			contextWindow: plan.generation.contextWindow,
		});
		return runtime.commitGenerationSettlement(current, plan, classification);
	}
	return runtime.commitEffectSettlement(current, plan, output as SettlementOutput);
}

function externalFinalization(current: CurrentOperation): OperationResult {
	return {
		operationId: current.operationId,
		lane: current.lane,
		kind: current.kind,
		outcome: "failed",
		leafId: current.leafId,
		error: { code: "external_finalization", message: "Operation was finalized outside this driver" },
	};
}

function sleepUntil(until: number): Promise<void> {
	const delay = Math.max(0, until - Date.now());
	return new Promise((resolve) => setTimeout(resolve, delay));
}
