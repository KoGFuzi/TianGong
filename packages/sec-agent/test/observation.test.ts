import { fauxAssistantMessage, fauxText, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import type { AgentEvent, ConversationId, EntryId, EntryRecord, SnapshotEvent } from "@OnePanda-TgSec/tg-gibraltar";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSecTurnTracker, openSecAgent, watchSecEvents } from "../src/index.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir } from "./support.ts";

afterEach(cleanupTempDirs);

function snapshotFrame(over: Partial<SnapshotEvent> = {}): SnapshotEvent {
	return {
		type: "snapshot",
		entries: [],
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
		...over,
	};
}

function assistantEntry(id: number): EntryRecord {
	return { id: id as EntryId, conversationId: 1 as ConversationId, kind: "tg.assistant" };
}

describe("sec turn tracker", () => {
	it("tracks open work through the live events", () => {
		const tracker = createSecTurnTracker();
		expect(tracker.state()).toEqual({ runOpen: false, messageOpen: false, openToolCalls: [] });
		tracker.observe({ type: "run_start", inputs: [] });
		tracker.observe({ type: "message_start", message: fauxAssistantMessage("streaming") });
		tracker.observe({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
		expect(tracker.state()).toEqual({ runOpen: true, messageOpen: true, openToolCalls: ["call-1"] });
		tracker.observe({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash" });
		tracker.observe({ type: "message_end", entry: assistantEntry(5) });
		tracker.observe({ type: "run_end", inputs: [] });
		expect(tracker.state()).toEqual({ runOpen: false, messageOpen: false, openToolCalls: [] });
	});

	it("folds a snapshot frame wholesale instead of patching (legacy P0-1)", () => {
		const tracker = createSecTurnTracker();
		tracker.observe({ type: "run_start", inputs: [] });
		tracker.observe({ type: "tool_execution_start", toolCallId: "vanished", toolName: "read", args: {} });
		// The overflow snapshot says: a run is open with a streaming partial, and the only running
		// tool is `live-1`. Everything the missed batches implied must be replaced, not merged.
		tracker.observe(
			snapshotFrame({
				run: { inputs: [] },
				generation: { attempt: 1, message: fauxAssistantMessage("partial") },
				tools: [{ callId: "live-1", name: "bash", status: "running" }],
			}),
		);
		expect(tracker.state()).toEqual({ runOpen: true, messageOpen: true, openToolCalls: ["live-1"] });
		tracker.observe(snapshotFrame());
		expect(tracker.state()).toEqual({ runOpen: false, messageOpen: false, openToolCalls: [] });
	});

	it("treats a done slot in a snapshot as closed work", () => {
		const tracker = createSecTurnTracker();
		tracker.observe({ type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: {} });
		tracker.observe(snapshotFrame({ tools: [{ callId: "call-9", name: "bash", status: "done" }] }));
		expect(tracker.state().openToolCalls).toEqual([]);
	});
});

describe("watchSecEvents", () => {
	it("isolates a throwing listener without stopping the watch (legacy P0-2)", async () => {
		const dir = await tempDir();
		const { faux, models } = fauxSetup();
		faux.setResponses([
			fauxAssistantMessage([fauxText("running"), fauxToolCall("bash", { command: "pwd" }, { id: "obs-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);
		const agent = await openSecAgent({
			context,
			project: "observe",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
		});
		const observation = await watchSecEvents({ harness: agent.harness, conversationId: agent.root.id, context });

		const delivered: (readonly AgentEvent[])[] = [];
		observation.on(() => {
			throw new Error("consumer exploded");
		});
		observation.on((events) => {
			delivered.push(events);
		});
		observation.start();

		const submission = await agent.root.submit({ type: "input", content: "pwd please" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		// The good listener saw every batch after the bad one threw, and the watch never stopped.
		expect(delivered.length).toBeGreaterThan(1);
		expect(observation.errors.length).toBeGreaterThan(0);
		expect(String(observation.errors[0])).toContain("consumer exploded");
		expect(delivered.flat().some((event) => event.type === "run_end")).toBe(true);
		// The tracker folded the same stream: after the run ends nothing is left open.
		expect(observation.state()).toEqual({ runOpen: false, messageOpen: false, openToolCalls: [] });

		await observation.stop();
		await agent.close(context);
	}, 30_000);
});
