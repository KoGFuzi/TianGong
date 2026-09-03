import { describe, expect, it } from "../bun-test.ts";
import { drive, newDriveState, type CurrentOperation, type DriverRuntime, type RuntimeSnapshot } from "../../src/harness/drive/index.ts";
import type { RunState } from "../../src/harness/state/operation-state.ts";

const runtimeSnapshot: RuntimeSnapshot = {
	configuration: {
		model: { provider: "test", modelId: "model" },
		thinkingLevel: "off",
		activeToolNames: [],
	},
	configurationSeq: 1,
	streamOptions: {},
	retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
};

function current(): CurrentOperation {
	const state: RunState = {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 },
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			toolExecution: "sequential",
		},
		phase: {
			kind: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: false },
			triggerEntryId: "entry-1",
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
	return {
		operationId: "operation-1",
		lane: "main",
		kind: "run",
		state,
		operationStateSeq: 1,
		laneState: { currentOperationId: "operation-1", pendingNextRun: [] },
		laneStateSeq: 1,
		leafId: "entry-1",
		configuration: runtimeSnapshot.configuration,
		configurationSeq: 1,
	};
}

describe("Effect interpreter", () => {
	it("executes a finish action and commits the terminal transaction", async () => {
		let terminalResult: unknown;
		const runtime: DriverRuntime = {
			load: async () => current(),
			loadInputs: async () => ({ running: new Map(), deferredPollsRemaining: 0, deferredCancellations: new Set(), loaded: new Map(), runtime: runtimeSnapshot, now: Date.now() }),
			commitTransition: async () => current(),
			commitEffectSettlement: async () => current(),
			commitTerminal: async (_current, result) => {
				terminalResult = result;
				return current();
			},
			makeEffect: async () => ({ kind: "not_started", key: "none" }),
			getRuntimeSnapshot: () => runtimeSnapshot,
		};

		const result = await drive(runtime, current(), newDriveState(), { maxSteps: 2 });
		expect(result.result.outcome).toBe("completed");
		expect(terminalResult).toMatchObject({ outcome: "completed" });
	});
});
