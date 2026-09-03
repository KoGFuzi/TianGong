import { describe, expect, it } from "../bun-test.ts";
import type { AssistantMessage } from "@onepanda-tiangongsec/tg-ai";
import { classifyGeneration } from "../../src/harness/drive/classification.ts";

const message = (stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "result" }],
	api: "test",
	provider: "test",
	model: "test",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason,
	...(errorMessage ? { errorMessage } : {}),
	timestamp: 1,
});

const base = {
	control: { status: "running" as const },
	attempt: 1,
	maxAttempts: 3,
	intendedOutputLimit: 100,
	contextWindow: 1000,
};

describe("generation settlement classification", () => {
	it("prioritizes durable cancellation", () => {
		const result = classifyGeneration({ ...base, control: { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] }, message: message("error") });
		expect(result.kind).toBe("aborted");
		expect(result.message.stopReason).toBe("aborted");
	});

	it("recognizes context overflow before retry", () => {
		const result = classifyGeneration({ ...base, message: message("error", "maximum context length exceeded") });
		expect(result.kind).toBe("overflow");
	});

	it("schedules retry while attempts remain", () => {
		const result = classifyGeneration({ ...base, message: message("error", "temporary network error") });
		expect(result).toMatchObject({ kind: "retry", nextAttempt: 2 });
	});
});
