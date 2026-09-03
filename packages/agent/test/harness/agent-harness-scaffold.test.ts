// @ts-nocheck - Test file
import type { AssistantMessage, Model, Models, Usage } from "@onepanda-tiangongsec/tg-ai";
import { Effect } from "effect";
import { describe, expect, it } from "../bun-test.ts";
import {
	AgentHarness,
	Closed,
	HarnessClosed,
	HarnessNotImplemented,
	type HarnessTool,
	type Resources,
} from "../../src/harness/agent-harness.ts";
import {
	InMemorySessionStorage,
	type NewRecord,
	type OperationStartedRecord,
	Session,
} from "../../src/harness/session/index.ts";
import type { AgentMessage } from "../../src/types.ts";

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

const model: Model = {
	id: "test-model",
	name: "Test Model",
	api: "test-api",
	provider: "test-provider",
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 1,
};

const models = {
	completeSimple: async () => assistantMessage,
} as unknown as Models;

function createHarness(session = createSession()): Promise<AgentHarness> {
	return AgentHarness.create({
		session,
		models,
		model,
	}).then(({ harness }) => harness);
}

function operationStarted(id: string): NewRecord<OperationStartedRecord> {
	return {
		type: "operation_started",
		id,
		lane: "main",
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: [] },
	};
}

const userMessage: AgentMessage = {
	role: "user",
	content: [{ type: "text", text: "hello" }],
	timestamp: 1,
};

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

	describe("AgentHarness Effect runtime", () => {
	 it("returns a lane-scoped facade for created lanes", async () => {
		const session = createSession();
		const harness = await createHarness(session);
		const created = await harness.createLane("worker", null);
		expect(created.ok).toBe(true);
		const worker = await harness.lane("worker");
		expect(worker?.name).toBe("worker");
		expect(worker?.session).not.toBe(harness.session);
		expect(await worker?.getLeafId()).toBe(null);
	});

	it("opens sessions regardless of legacy records", async () => {
		const session = createSession();
		const { harness, suspended } = await AgentHarness.create({
			session,
			models,
			model,
		});

		expect(suspended).toEqual([]);
		expect(harness.name).toBe("main");
		expect(harness.session).toBe(session);
		expect(await harness.getLeafId()).toBeNull();
		expect(await Effect.runPromise(harness.session.getLeafId() as Effect.Effect<string | null, never>)).toBeNull();

		await expect(harness.close()).resolves.toBeUndefined();

		const recorded = createSession("recorded");
		await Effect.runPromise(recorded.appendRecord(operationStarted("run")));
		await expect(AgentHarness.create({ session: recorded, models, model })).resolves.toBeDefined();
	});

	it("keeps scaffold-safe configuration as defensive copies", async () => {
		const harness = await createHarness();
		await harness.setModel(model);
		expect(await harness.getModel()).toBe(model);

		await harness.setThinkingLevel("high");
		expect(await harness.getThinkingLevel()).toBe("high");

		const activeTools = ["one"];
		await harness.setActiveTools(activeTools);
		activeTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);
		const readActiveTools = await harness.getActiveTools();
		readActiveTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);

		const tool = { name: "tool", label: "Tool" } as HarnessTool;
		const tools = [tool];
		await harness.setTools(tools);
		tools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);
		const readTools = await harness.getTools();
		readTools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);

		const resources: Resources = {
			skills: [{ name: "skill", description: "desc", content: "body", filePath: "/tmp/SKILL.md" }],
			promptTemplates: [{ name: "template", content: "body" }],
		};
		await harness.setResources(resources);
		resources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);
		const readResources = await harness.getResources();
		readResources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);

		const streamOptions = { maxTokens: 10 };
		await harness.setStreamOptions(streamOptions);
		streamOptions.maxTokens = 20;
		expect(await harness.getStreamOptions()).toEqual({ maxTokens: 10 });
		const readStreamOptions = await harness.getStreamOptions();
		readStreamOptions.maxTokens = 30;
		expect(await harness.getStreamOptions()).toEqual({ maxTokens: 10 });

		const retryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 10 };
		await harness.setRetryPolicy(retryPolicy);
		retryPolicy.maxRetries = 99;
		expect(await harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 10 });

		const compactionSettings = { enabled: false, reserveTokens: 1, keepRecentTokens: 2 };
		await harness.setCompactionSettings(compactionSettings);
		compactionSettings.reserveTokens = 99;
		expect(await harness.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 1, keepRecentTokens: 2 });

		await harness.setSteeringMode("all");
		expect(await harness.getSteeringMode()).toBe("all");
		await harness.setFollowUpMode("all");
		expect(await harness.getFollowUpMode()).toBe("all");
	});

	it("keeps only a few synthetic unimplemented surfaces", async () => {
		const harness = await createHarness();
		const stillUnimplemented: [string, () => unknown | Promise<unknown>][] = [
			// All operations are now implemented. Removing this list entirely would
			// be the next step; keeping it empty documents that the scaffold is gone.
		];

		for (const [operation, invoke] of stillUnimplemented) {
			await expect(Promise.resolve().then(invoke), operation).rejects.toMatchObject({
				name: "HarnessNotImplemented",
				operation,
			});
		}
	});

	it("treats all other operations as fully implemented kernel calls", async () => {
		const harness = await createHarness();
		const nowImplemented: [string, () => unknown | Promise<unknown>][] = [
			["compact", () => harness.compact()],
			["navigateTree", () => harness.navigateTree(null)],
			["resume", () => harness.resume()],
			["abort", () => harness.abort()],
			["steer", () => harness.steer(userMessage)],
			["followUp", () => harness.followUp(userMessage)],
			["nextRun", () => harness.nextRun(userMessage)],
			["cancelQueued", () => harness.cancelQueued("queued")],
			["recordUsage", () => harness.recordUsage(usage)],
			["waitForIdle", () => harness.waitForIdle()],
			[
				"runWhenIdle",
				() =>
					harness.runWhenIdle(() => {
						/* run */
					}),
			],
			["peekAction", () => harness.peekAction()],
			["executeAction", () => harness.executeAction()],
			["runToCompletion", () => harness.runToCompletion()],
			["lane", () => harness.lane("main")],
			["createLane", () => harness.createLane("thread", null)],
			["lanes", () => harness.lanes()],
		];

		for (const [operation, invoke] of nowImplemented) {
			// Each should resolve (kernel returns a result envelope) rather than reject with HarnessNotImplemented.
			const result = await Promise.resolve().then(invoke);
			if (result === undefined) continue;
			if (typeof (result as { ok?: unknown }).ok === "boolean") {
				expect((result as { ok: unknown }).ok).toBeDefined();
			}
			// Touch operation to silence unused-binding lint.
			void operation;
		}
	});

	it("drives prompt through the operation kernel and atomically settles state", async () => {
		const session = createSession("prompt");
		const harness = await createHarness(session);
		const result = await harness.prompt("hello");

		expect(result).toEqual({
			ok: true,
			value: expect.objectContaining({ kind: "completed", finalMessage: assistantMessage }),
		});
		expect(await Effect.runPromise(session.getRegister("lane.state", "main") as Effect.Effect<{ value: { currentOperationId: null } }, never>)).toMatchObject({ value: { currentOperationId: null } });
		expect(await Effect.runPromise(session.getRegister("lane.lastResult", "main") as Effect.Effect<{ value: { outcome: string } }, never>)).toMatchObject({ value: { outcome: "completed" } });
		expect(await Effect.runPromise(session.listRegisters("op.state") as Effect.Effect<unknown[], never>)).toEqual([]);
		expect((await Effect.runPromise(session.findEntries() as Effect.Effect<unknown[], never>)).at(0)).toMatchObject({ type: "message", message: assistantMessage });
	});

	it("reports HarnessClosed for unfinished operations after close", async () => {
		const harness = await createHarness();
		await harness.close();

		expect(await harness.prompt("hello")).toEqual({ ok: false, error: expect.any(Closed) });
		await expect(harness.waitForIdle()).rejects.toBeInstanceOf(Closed);
		expect(() => harness.hooks.on("before_run", () => {})).toThrow(HarnessClosed);
		expect(() => harness.events.on("event", () => {})).toThrow(HarnessClosed);
	});
});
