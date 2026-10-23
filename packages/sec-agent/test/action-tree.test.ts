import { fauxAssistantMessage } from "@OnePanda-TgSec/tg-ai";
import { defineExtension, defineTask, type TaskId } from "@OnePanda-TgSec/tg-gibraltar";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionTreeKey, openSecAgent, patchActionNode, type SecAgent, TgSecActionTreeDoc } from "../src/index.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir } from "./support.ts";

afterEach(cleanupTempDirs);

const NoopTask = defineTask<{ n: number }, { phase: "run" }, null>({
	name: "test.noop",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: { run: async () => {} },
	abort: async () => {},
});

const OpenedAt = 1_700_000_000_000;

async function openedAgent(project: string, dir: string): Promise<SecAgent> {
	const { faux, models } = fauxSetup();
	faux.setResponses([fauxAssistantMessage("ok")]);
	return openSecAgent({
		context,
		project,
		lane: "redteam",
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		extensions: [defineExtension({ name: "test.noop-extension", tasks: [NoopTask] })],
		now: () => OpenedAt,
	});
}

describe("action tree", () => {
	it("seeds a delegation in the creating commit, enumerates it, and keeps attribution unique", async () => {
		const dir = await tempDir();
		const agent = await openedAgent("tree-seed", dir);
		const submission = await agent.root.submit({ type: "input", content: "delegate" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		const page = await agent.root.entries({}, 100, undefined, context);
		const forkPoint = page.items.find((entry) => entry.kind === "tg.user")!;

		const taskId = await agent.root.commit(
			(tx) => tx.createTask(NoopTask, { n: 1 }, { ownership: { kind: "conversation" } }),
			context,
		);
		const child = await agent.root.commit(
			(tx) => tx.forkConversation(agent.root.id, forkPoint.id, { ownership: { kind: "task", taskId } }),
			context,
		);

		const nodes = await agent.actionTree(context);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({
			conversationId: Number(child.id),
			parentConversationId: Number(agent.root.id),
			ownerTaskId: Number(taskId),
			at: Number(forkPoint.id),
			intent: "delegated",
			status: "open",
			summaryRef: "",
			openedAt: OpenedAt,
		});

		// Queries address the same delegation from either authority, and only that delegation.
		expect(await agent.actionTree(context, { parent: agent.root.id })).toHaveLength(1);
		expect(await agent.actionTree(context, { taskId })).toHaveLength(1);

		await agent.close(context);
	});

	it("skips ownerless conversations and rejects a fork whose owner task does not exist", async () => {
		const dir = await tempDir();
		const agent = await openedAgent("tree-owner", dir);
		const submission = await agent.root.submit({ type: "input", content: "delegate" }, context);
		await submission.wait(context);
		const page = await agent.root.entries({}, 100, undefined, context);
		const forkPoint = page.items.find((entry) => entry.kind === "tg.user")!;

		await agent.root.commit(
			(tx) => tx.forkConversation(agent.root.id, forkPoint.id, { ownership: { kind: "ownerless" } }),
			context,
		);
		expect(await agent.actionTree(context)).toEqual([]);

		const ghost = 987_654 as TaskId;
		await expect(
			agent.root.commit(
				(tx) => tx.forkConversation(agent.root.id, forkPoint.id, { ownership: { kind: "task", taskId: ghost } }),
				context,
			),
		).rejects.toThrow(/does not exist/);

		await agent.close(context);
	});

	it("patches intent, status and summary on the seeded member", async () => {
		const dir = await tempDir();
		const agent = await openedAgent("tree-patch", dir);
		const submission = await agent.root.submit({ type: "input", content: "delegate" }, context);
		await submission.wait(context);
		const page = await agent.root.entries({}, 100, undefined, context);
		const forkPoint = page.items.find((entry) => entry.kind === "tg.user")!;
		const taskId = await agent.root.commit(
			(tx) => tx.createTask(NoopTask, { n: 1 }, { ownership: { kind: "conversation" } }),
			context,
		);
		const child = await agent.root.commit(
			(tx) => tx.forkConversation(agent.root.id, forkPoint.id, { ownership: { kind: "task", taskId } }),
			context,
		);

		await agent.root.commit(
			(tx) =>
				patchActionNode(tx, child, () => OpenedAt, {
					intent: "scan targets",
					status: "done",
					summaryRef: "entry:42",
				}),
			context,
		);

		const stored = await agent.harness.snapshot(TgSecActionTreeDoc, actionTreeKey(child.id), context);
		expect(stored).toMatchObject({
			intent: "scan targets",
			status: "done",
			summaryRef: "entry:42",
			openedAt: OpenedAt,
		});
		const nodes = await agent.actionTree(context);
		expect(nodes[0]).toMatchObject({ intent: "scan targets", status: "done", summaryRef: "entry:42" });

		await agent.close(context);
	});
});
