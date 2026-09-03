// @ts-nocheck - Test file
import { describe, expect, it } from "../bun-test.ts";
import { nextAction, type DriveInputs } from "../../src/harness/drive/next-action.ts";
import type { RuntimeSnapshot } from "../../src/harness/drive/types.ts";
import type { RunState } from "../../src/harness/state/operation-state.ts";

const runtime: RuntimeSnapshot = {
	configuration: {
		model: { provider: "test", modelId: "model" },
		thinkingLevel: "off",
		activeToolNames: [],
	},
	configurationSeq: 1,
	streamOptions: {},
	retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
};

const inputs = (now = 0): DriveInputs => ({
	running: new Map(),
	deferredPollsRemaining: 0,
	deferredCancellations: new Set(),
	loaded: new Map(),
	runtime,
	now,
});

const runState = (phase: RunState["phase"]): RunState => ({
	kind: "run",
	control: { status: "running" },
	settings: {
		compaction: { enabled: true, keepRecentTokens: 100, reserveTokens: 10 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		toolExecution: "sequential",
	},
	phase,
	inbox: { steer: [], followUp: [], writes: [] },
	latestAssistantEntryId: null,
});

describe("Part 4 planner", () => {
	it("transitions a need-assistant checkpoint to assistant ready", () => {
		const action = nextAction(
			runState({
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: "entry-1",
			}),
			inputs(),
		);

		expect(action.kind).toBe("transition");
		if (action.kind !== "transition") return;
		expect(action.next.kind).toBe("run");
		expect(action.next.phase.kind).toBe("assistant");
		if (action.next.phase.kind !== "assistant") return;
		expect(action.next.phase.generation.status).toBe("ready");
	});

	it("waits until retry_wait reaches notBefore", () => {
		const action = nextAction(
			runState({
				kind: "assistant",
				generation: {
					status: "retry_wait",
					context: {
						stepId: "step-1",
						triggerEntryId: "entry-1",
						configuration: runtime.configuration,
						streamOptions: {},
						retryPolicy: runtime.retryPolicy,
						overflowRecoveryUsed: false,
					},
					nextAttempt: 2,
					notBefore: 100,
					errorMessage: "temporary",
				},
			}),
			inputs(50),
		);

		expect(action).toMatchObject({ kind: "wait", until: 100 });
	});

	it("plans an assistant effect from a ready generation", () => {
		const action = nextAction(
			runState({
			kind: "assistant",
			generation: {
				status: "ready",
				context: {
					stepId: "step-1",
					triggerEntryId: "entry-1",
					configuration: runtime.configuration,
					streamOptions: {},
					retryPolicy: runtime.retryPolicy,
					overflowRecoveryUsed: false,
				},
				nextAttempt: 1,
			},
		}),
		inputs(),
		);

		expect(action.kind).toBe("dispatch");
		if (action.kind !== "dispatch") return;
		expect(action.effect.kind).toBe("assistant");
		expect(action.effect.key).toBe("assistant:step-1:1");
	});
});
