import { describe, expect, it } from "../bun-test.ts";
import type { AssistantMessage } from "@onepanda-tiangongsec/tg-ai";
import { classifyGeneration } from "../../src/harness/drive/classification.ts";
import { transitionGeneration } from "../../src/harness/drive/generation-transition.ts";
import type { RunState } from "../../src/harness/state/operation-state.ts";

const assistant = (stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "answer" }],
	api: "test",
	provider: "test",
	model: "model",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason,
	...(errorMessage ? { errorMessage } : {}),
	timestamp: 1,
});

const state = (phase: RunState["phase"]): RunState => ({
	kind: "run",
	control: { status: "running" },
	settings: {
		compaction: { enabled: true, keepRecentTokens: 100, reserveTokens: 10 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		toolExecution: "parallel",
	},
	phase,
	inbox: { steer: [], followUp: [], writes: [] },
	latestAssistantEntryId: null,
});

const pendingGeneration = {
	status: "effect_pending" as const,
	context: {
		stepId: "step-1",
		triggerEntryId: "entry-1",
		configuration: {
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off" as const,
			activeToolNames: [],
		},
		streamOptions: {},
		retryPolicy: { maxAttempts: 3, baseDelayMs: 10 },
		overflowRecoveryUsed: false,
	},
	attempt: 1,
	responseEntryId: "response-1",
	usageId: "usage-1",
	intendedOutputLimit: 100,
	contextWindow: 1000,
};

describe("generation transition", () => {
	it("moves a completed response to a finish checkpoint", () => {
		const message = assistant("stop");
		const next = transitionGeneration(
			{ state: state({ kind: "assistant", generation: pendingGeneration }), generation: pendingGeneration, responseEntryId: "response-1", message, now: 1 },
			classifyGeneration({ control: { status: "running" }, message, attempt: 1, maxAttempts: 3, intendedOutputLimit: 100, contextWindow: 1000 }),
		);
		expect(next.phase).toMatchObject({ kind: "checkpoint", continuation: { kind: "may_finish", includeFinalAssistant: true } });
		expect(next.latestAssistantEntryId).toBe("response-1");
	});

	it("moves retryable failures to retry_wait with a bounded backoff", () => {
		const message = assistant("error", "temporary network error");
		const next = transitionGeneration(
			{ state: state({ kind: "assistant", generation: pendingGeneration }), generation: pendingGeneration, responseEntryId: "response-1", message, now: 100 },
			classifyGeneration({ control: { status: "running" }, message, attempt: 1, maxAttempts: 3, intendedOutputLimit: 100, contextWindow: 1000 }),
		);
		expect(next.phase).toMatchObject({ kind: "assistant", generation: { status: "retry_wait", nextAttempt: 2, notBefore: 110 } });
	});

	it("moves an overflow response to structural compaction", () => {
		const message = assistant("error", "maximum context length exceeded");
		const next = transitionGeneration(
			{ state: state({ kind: "assistant", generation: pendingGeneration }), generation: pendingGeneration, responseEntryId: "response-1", message, now: 1 },
			classifyGeneration({ control: { status: "running" }, message, attempt: 1, maxAttempts: 3, intendedOutputLimit: 100, contextWindow: 1000 }),
		);
		expect(next.phase).toMatchObject({ kind: "compaction", reason: "overflow", structural: { status: "deciding" } });
	});
});
