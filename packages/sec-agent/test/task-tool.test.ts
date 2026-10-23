import { fauxAssistantMessage, fauxText, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import { AgentDoc, type ConversationId, defineExtension } from "@OnePanda-TgSec/tg-gibraltar";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskTool, openSecAgent } from "../src/index.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir } from "./support.ts";

afterEach(cleanupTempDirs);

const ChildPolicyExtensions = ["test-child"];

describe("task tool", () => {
	it("delegates to a policy-bound child conversation and returns its summary", async () => {
		const dir = await tempDir();
		const { faux, models } = fauxSetup();
		faux.setResponses([
			fauxAssistantMessage([fauxText("delegating"), fauxToolCall("task", { intent: "solve 42" }, { id: "t1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("child answer: 42"),
			fauxAssistantMessage("the child reported back"),
		]);

		const taskTool = createTaskTool({
			lane: "redteam",
			policies: {
				redteam: { extensions: ChildPolicyExtensions, model: fauxModel },
				ctf: { extensions: [] },
				src: { extensions: [] },
			},
			now: () => 5,
		});
		const agent = await openSecAgent({
			context,
			project: "task-tool",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
			now: () => 5,
			extensions: [
				defineExtension({ name: "test-child", tools: [] }),
				defineExtension({ name: "sec-test-task", tools: [taskTool] }),
			],
		});

		const submission = await agent.root.submit({ type: "input", content: "delegate this" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		// The child's summary reached the parent's transcript as the tool result.
		const page = await agent.root.entries({}, 100, undefined, context);
		const toolResult = page.items.find((entry) => entry.kind === "tg.tool-result");
		expect(toolResult).toBeDefined();
		const resultText = JSON.stringify(toolResult?.model);
		expect(resultText).toContain("child answer: 42");

		// The delegation is attributed to the tool task, with the intent and outcome recorded.
		const nodes = await agent.actionTree(context);
		expect(nodes).toHaveLength(1);
		const childId = nodes[0]!.conversationId;
		expect(childId).not.toBe(Number(agent.root.id));
		expect(nodes[0]).toMatchObject({
			parentConversationId: Number(agent.root.id),
			intent: "solve 42",
			status: "done",
			openedAt: 5,
		});
		expect(nodes[0]!.ownerTaskId).toBeGreaterThan(0);
		expect(nodes[0]!.summaryRef).toMatch(/^[1-9][0-9]*$/);

		// The child selects exactly the static policy extensions and the policy model.
		const childAgent = await agent.harness.snapshot(AgentDoc, childId as ConversationId, context);
		expect(childAgent).toMatchObject({ extensions: ChildPolicyExtensions, model: fauxModel });

		await agent.close(context);
	}, 30_000);

	it("records a failed child settlement and closes the tree node", async () => {
		const dir = await tempDir();
		const { faux, models } = fauxSetup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { intent: "broken delegation" }, { id: "t1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("gave up"),
		]);

		// A child with no model cannot generate: its delegation settles unanswered without any provider call.
		const taskTool = createTaskTool({
			lane: "ctf",
			policies: {
				redteam: { extensions: [] },
				ctf: { extensions: ChildPolicyExtensions, model: null },
				src: { extensions: [] },
			},
			now: () => 9,
		});
		const agent = await openSecAgent({
			context,
			project: "task-fail",
			lane: "ctf",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
			now: () => 9,
			extensions: [
				defineExtension({ name: "test-child", tools: [] }),
				defineExtension({ name: "sec-test-task", tools: [taskTool] }),
			],
		});

		const submission = await agent.root.submit({ type: "input", content: "delegate" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		const nodes = await agent.actionTree(context);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ intent: "broken delegation", status: "failed", summaryRef: "", openedAt: 9 });

		await agent.close(context);
	}, 30_000);
});
