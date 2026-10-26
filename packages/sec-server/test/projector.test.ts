import { fauxAssistantMessage } from "@OnePanda-TgSec/tg-ai";
import type { AgentEvent, ConversationId, EntryId, SubmissionId, TaskId } from "@OnePanda-TgSec/tg-gibraltar";
import { AgentDoc, UsageDoc } from "@OnePanda-TgSec/tg-gibraltar";
import { describe, expect, test } from "vitest";
import type { SecEventFrame, SecServerFrame, SecSnapshotFrame } from "../src/contract.ts";
import { projectSecGraph, type SecProjectionAction, type SecProjectionInput } from "../src/projection.ts";
import { initialRunState, SecGraphProjector, SecRunProjector } from "../src/projector.ts";

const ROOT = 1;
const CONVERSATION = 1 as ConversationId;

function input(actions: readonly SecProjectionAction[] = [], now = 1000): SecProjectionInput {
	return {
		project: "demo",
		target: "https://demo.local",
		rootConversationId: ROOT,
		actions,
		evidence: [],
		now,
	};
}

function action(overrides: Partial<SecProjectionAction> = {}): SecProjectionAction {
	return {
		conversationId: 2,
		parentConversationId: ROOT,
		ownerTaskId: 11,
		at: 20,
		intent: "service: 8080/http nginx",
		openedAt: 20,
		status: "open",
		summaryRef: "",
		...overrides,
	};
}

function eventFrame(frame: SecServerFrame): SecEventFrame {
	if (frame.type === "snapshot" || frame.type === "pong")
		throw new Error(`expected an event frame, got ${frame.type}`);
	return frame;
}

function snapshotFrame(frame: SecServerFrame): SecSnapshotFrame {
	if (frame.type !== "snapshot") throw new Error(`expected a snapshot frame, got ${frame.type}`);
	return frame;
}

function snapshotEvent(inbox = 0): Extract<AgentEvent, { type: "snapshot" }> {
	return {
		type: "snapshot",
		entries: [],
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: Array.from({ length: inbox }, (_, index) => ({
			id: (index + 1) as SubmissionId,
			mode: "steer" as const,
		})),
		agent: AgentDoc.definition.initial(),
		usage: UsageDoc.definition.initial(),
	};
}

function entry(
	kind: string,
	model: Extract<AgentEvent, { type: "message_end" }>["entry"]["model"],
): Extract<AgentEvent, { type: "message_end" }>["entry"] {
	return { id: 1 as EntryId, conversationId: CONVERSATION, kind, model };
}

describe("SecGraphProjector", () => {
	test("sends the whole graph and run state on the first projection", () => {
		const run = { running: true, queued: 2, turn: 1 };
		const projector = new SecGraphProjector(run);
		const frames = projector.update(input());
		const frame = snapshotFrame(frames[0]!);

		expect(frames).toHaveLength(1);
		expect(frame.ts).toBe(1000);
		expect(frame.payload).toEqual(projectSecGraph(input()));
		expect(frame.running).toBe(true);
		expect(frame.queued).toBe(2);
		expect(projector.current()).toEqual(frame.payload);
	});

	test("emits nothing when the projection did not change", () => {
		const projector = new SecGraphProjector();
		projector.update(input());
		expect(projector.update(input())).toEqual([]);
	});

	test("itemizes a new action as node, edge and intent frames", () => {
		const projector = new SecGraphProjector();
		projector.update(input());

		const frames = projector.update(input([action()]));
		expect(frames.map((frame) => frame.type)).toEqual(["node", "edge", "intent"]);

		const node = eventFrame(frames[0]!);
		expect(node.payload).toMatchObject({ id: "service:action-2", type: "service", status: "open" });
		const edge = eventFrame(frames[1]!);
		expect(edge.payload).toMatchObject({ id: "contains:target:demo->service:action-2", weight: 0.5 });
		const intent = eventFrame(frames[2]!);
		expect(intent.payload).toMatchObject({ id: "intent:conv-2", status: "open" });
	});

	test("itemizes a status change on the node, its edge and its intent", () => {
		const projector = new SecGraphProjector();
		projector.update(input([action()]));

		const frames = projector.update(input([action({ status: "done" })]));
		expect(frames.map((frame) => frame.type)).toEqual(["node", "edge", "intent"]);
		for (const frame of frames) expect(eventFrame(frame).ts).toBe(1000);
		expect(eventFrame(frames[0]!).payload).toMatchObject({ id: "service:action-2", status: "done" });
		expect(eventFrame(frames[1]!).payload).toMatchObject({ weight: 1 });
		expect(eventFrame(frames[2]!).payload).toMatchObject({ status: "verified", est_success: 1 });
	});

	test("adds an rce_path frame when a sink appears", () => {
		const projector = new SecGraphProjector();
		projector.update(input());

		const frames = projector.update(input([action({ intent: "foothold: shell" })]));
		expect(frames.map((frame) => frame.type)).toEqual(["node", "edge", "intent", "rce_path"]);
		expect(eventFrame(frames[3]!).payload).toMatchObject({
			path: ["target:demo", "foothold:action-2"],
			frontier_mode: false,
		});
	});

	test("resynchronizes with a snapshot when an id disappears", () => {
		const projector = new SecGraphProjector();
		projector.update(input([action()]));

		const frames = projector.update(input());
		expect(frames).toHaveLength(1);
		const frame = snapshotFrame(frames[0]!);
		expect(frame.payload.nodes.map((node) => node.key)).toEqual(["target:demo"]);
	});

	test("publishes to every subscriber even when one throws", () => {
		const projector = new SecGraphProjector();
		const received: SecServerFrame[] = [];
		projector.subscribe(() => {
			throw new Error("broken client");
		});
		const unsubscribe = projector.subscribe((frame) => received.push(frame));

		projector.publish({ type: "pong", ts: 1 });
		unsubscribe();
		projector.publish({ type: "pong", ts: 2 });

		expect(received).toEqual([{ type: "pong", ts: 1 }]);
	});
});

describe("SecRunProjector", () => {
	test("adopts the attach-time snapshot", () => {
		const projector = new SecRunProjector();
		projector.adopt(snapshotEvent(2));
		expect(projector.state).toEqual({ running: false, queued: 2, turn: 0 });
	});

	test("tracks run state across turns", () => {
		const projector = new SecRunProjector();
		const events: AgentEvent[] = [{ type: "run_start", inputs: [] }, { type: "turn_start" }];
		const frames = projector.apply(events, 10);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({
			type: "status",
			ts: 10,
			payload: { status: "running", turn: 1, running: true, queued: 0 },
		});
		expect(projector.state).toEqual({ running: true, queued: 0, turn: 1 });

		const end = projector.apply([{ type: "run_end", inputs: [] }], 20);
		expect(end[0]).toMatchObject({ type: "status", payload: { status: "idle", turn: 1, running: false } });
	});

	test("updates the queued count from the inbox", () => {
		const projector = new SecRunProjector();
		projector.adopt(snapshotEvent(1));

		const frames = projector.apply(
			[
				{
					type: "inbox_update",
					items: [
						{ id: 1 as SubmissionId, mode: "steer" },
						{ id: 2 as SubmissionId, mode: "followUp" },
					],
				},
			],
			10,
		);
		expect(frames[0]).toMatchObject({ type: "status", payload: { queued: 2 } });
	});

	test("redacts evidence bodies from tool arguments", () => {
		const projector = new SecRunProjector();
		const frames = projector.apply(
			[
				{
					type: "tool_execution_start",
					toolCallId: "call-1",
					toolName: "sec_http",
					args: {
						url: "https://demo.local/admin",
						requestBase64: "AAAA",
						nested: { body: "secret" },
					},
				},
			],
			10,
		);

		expect(frames).toEqual([
			{
				type: "tool",
				ts: 10,
				payload: {
					callId: "call-1",
					name: "sec_http",
					status: "start",
					args: {
						url: "https://demo.local/admin",
						requestBase64: "[omitted 3 bytes]",
						nested: { body: "[omitted 4 bytes]" },
					},
				},
			},
		]);
	});

	test("projects an assistant message as a thought", () => {
		const projector = new SecRunProjector();
		const frames = projector.apply(
			[{ type: "message_end", entry: entry("tg.assistant", [fauxAssistantMessage("the path is open")]) }],
			10,
		);
		expect(frames).toEqual([{ type: "thought", ts: 10, payload: { text: "the path is open" } }]);
	});

	test("projects a sec.steer entry as user steering", () => {
		const projector = new SecRunProjector();
		const frames = projector.apply(
			[
				{
					type: "message_end",
					entry: entry("sec.steer", [{ role: "user", content: "try the left branch", timestamp: 1 }]),
				},
			],
			10,
		);
		expect(frames).toEqual([
			{ type: "steer", ts: 10, payload: { content: "try the left branch", queued: false, from: "user" } },
		]);
	});

	test("turns harness failures and retries into log frames", () => {
		const projector = new SecRunProjector();
		const frames = projector.apply(
			[
				{ type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "rate limited" },
				{ type: "task_failed", taskId: 7 as TaskId, kind: "generation", message: "boom" },
			],
			10,
		);
		expect(frames).toEqual([
			{ type: "log", ts: 10, payload: { level: "warn", message: "provider retry 1: rate limited" } },
			{ type: "log", ts: 10, payload: { level: "error", message: "task generation failed: boom" } },
		]);
	});

	test("adopts a mid-stream snapshot from an overflowing watch", () => {
		const projector = new SecRunProjector();
		projector.apply([{ type: "run_start", inputs: [] }], 1);
		projector.apply([{ type: "turn_start" }], 2);

		const frames = projector.apply([snapshotEvent(3)], 3);
		expect(projector.state).toEqual({ running: false, queued: 3, turn: 1 });
		expect(frames[0]).toMatchObject({ type: "status", payload: { status: "idle", turn: 1, queued: 3 } });
	});

	test("starts from an idle state", () => {
		expect(initialRunState()).toEqual({ running: false, queued: 0, turn: 0 });
	});
});
