// @ts-nocheck - Test file
import { Effect, Exit } from "effect";
import { describe, expect, it } from "../bun-test.ts";
import type { Model } from "@onepanda-tiangongsec/tg-ai";
import {
	InMemoryOperationStore,
	OperationKernelTag,
	OperationNotFound,
	makeEffectOperationLayer,
	type OperationEffects,
} from "../../src/harness/operation.ts";
import type { AssistantMessage, DeferredHandle, AgentToolResult } from "@onepanda-tiangongsec/tg-ai";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "complete" }],
	api: "test",
	provider: "test",
	model: "test",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 1,
};

const errorMessage: AssistantMessage = {
	...message,
	stopReason: "error",
	errorMessage: "temporary network error",
};

const toolMessage: AssistantMessage = {
	...message,
	content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
	stopReason: "toolUse",
};

const parallelToolMessage: AssistantMessage = {
	...message,
	content: [
		{ type: "toolCall", id: "call-1", name: "first", arguments: {} },
		{ type: "toolCall", id: "call-2", name: "second", arguments: {} },
	],
	stopReason: "toolUse",
};

const overflowMessage: AssistantMessage = {
	...message,
	stopReason: "error",
	errorMessage: "maximum context length exceeded",
};

const deferredMessage: AssistantMessage = {
	...message,
	stopReason: "deferred",
	deferred: { provider: "test", modelId: "test-model", api: "test-api", id: "deferred-1" } satisfies DeferredHandle,
};

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

const testEffects = (extras: Partial<OperationEffects> = {}): OperationEffects => ({
	generate: (() => Effect.succeed({ message })) as OperationEffects["generate"],
	...extras,
} as OperationEffects);

describe("Effect operation kernel", () => {
	it("persists intent, settles, and removes operation state", async () => {
		const store = new InMemoryOperationStore();
		const layer = makeEffectOperationLayer(store, testEffects(), model);
		const accepted = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		const result = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(accepted.id).toBe(result.operationId);
		expect(result.outcome).toBe("completed");
		expect((result as { finalMessage?: AssistantMessage }).finalMessage).toEqual(message);
	});

	it("rejects a second operation while the lane is occupied", async () => {
		const store = new InMemoryOperationStore();
		const layer = makeEffectOperationLayer(store, testEffects(), model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		const exit = await Effect.runPromiseExit(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		expect(exit._tag).toBe("Failure");
	});

	it("persists a retryable failed attempt before succeeding", async () => {
		const store = new InMemoryOperationStore();
		let attempts = 0;
		const effects: OperationEffects = {
			generate: () => Effect.succeed({ message: ++attempts === 1 ? errorMessage : message }),
		} as OperationEffects;
		const layer = makeEffectOperationLayer(store, effects, model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		const result = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));

		expect(attempts).toBe(2);
		expect(result.outcome).toBe("completed");
	});

	it("settles tool-use output while keeping the operation open", async () => {
		const store = new InMemoryOperationStore();
		const effects: OperationEffects = {
			generate: () => Effect.succeed({ message: toolMessage }),
		} as OperationEffects;
		const layer = makeEffectOperationLayer(store, effects, model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));

		const current = await Effect.runPromise(store.load("main"));
		expect(current.lane.currentOperationId).toBeDefined();
		expect(current.state?.program?.phase.kind).toBe("tools");
	});

	it("executes a durable tool batch and advances to a checkpoint", async () => {
		const store = new InMemoryOperationStore();
		let executions = 0;
		const effects: OperationEffects = {
			generate: () => Effect.succeed({ message: toolMessage }),
			executeTool: ({ name, args }) => {
				executions++;
				expect(name).toBe("read");
				expect(args).toEqual({ path: "README.md" });
				return Effect.succeed({ result: { content: [{ type: "text", text: "contents" }], details: {} }, isError: false });
			},
			toolReplay: () => "safe" as const,
		} as OperationEffects;
		const layer = makeEffectOperationLayer(store, effects, model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));

		const current = await Effect.runPromise(store.load("main"));
		expect(executions).toBe(1);
		expect(current.state?.program?.phase).toMatchObject({
			kind: "checkpoint",
			continuation: { kind: "need_assistant" },
		});
	});

	it("dispatches parallel tools concurrently but settles them in source order", async () => {
		const store = new InMemoryOperationStore();
		let active = 0;
		let maxActive = 0;
		const order: string[] = [];
		const effects: OperationEffects = {
			generate: () => Effect.succeed({ message: parallelToolMessage }),
			executeTool: ({ name }) => {
				active++;
				maxActive = Math.max(maxActive, active);
				return Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, name === "first" ? 10 : 1))).pipe(
					Effect.tap(() => Effect.sync(() => {
						active--;
						order.push(name);
					})),
					Effect.map(() => ({ result: { content: [{ type: "text", text: name }], details: {} }, isError: false } satisfies { readonly result: AgentToolResult<unknown>; readonly isError: boolean })),
				);
			},
		} as OperationEffects;
		const layer = makeEffectOperationLayer(store, effects, model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		const current = await Effect.runPromise(store.load("main"));
		expect(maxActive).toBe(2);
		expect(order).toEqual(["second", "first"]);
		expect(current.state?.program?.phase.kind).toBe("checkpoint");
	});

	it("drives an overflow phase into failure_drain when no compaction input exists", async () => {
		const store = new InMemoryOperationStore();
		const effects: OperationEffects = {
			generate: () => Effect.succeed({ message: overflowMessage }),
			summarize: () => Effect.die(new Error("summary should not start without preparation")),
		} as OperationEffects;
		const layer = makeEffectOperationLayer(store, effects, model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(((await Effect.runPromise(store.load("main"))).state?.program?.phase.kind)).toBe("compaction");

		const result = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(result.outcome).toBe("failed");
		expect(((await Effect.runPromise(store.load("main"))).state?.program?.phase.kind)).toBe("failure_drain");
	});

	it("polls a deferred response once per resume", async () => {
		const store = new InMemoryOperationStore();
		let polls = 0;
		const effects: OperationEffects = {
			generate: () => Effect.succeed({ message: deferredMessage }),
			fetchDeferred: ({ handle, poll }) => {
				expect(handle).toEqual(deferredMessage.deferred);
				polls++;
				return Effect.succeed({ pending: polls === 1, message: polls === 1 ? deferredMessage : message });
			},
		} as OperationEffects;
		const layer = makeEffectOperationLayer(store, effects, model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(((await Effect.runPromise(store.load("main"))).state?.program?.phase.kind)).toBe("deferred");
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(polls).toBe(1);
		expect(((await Effect.runPromise(store.load("main"))).state?.program?.phase.kind)).toBe("deferred");
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(polls).toBe(2);
		expect(((await Effect.runPromise(store.load("main"))).state?.program?.phase.kind)).toBe("checkpoint");
	});

	it("requests provider cancellation for an active deferred handle", async () => {
		const store = new InMemoryOperationStore();
		let cancelled: DeferredHandle | undefined;
		const effects: OperationEffects = {
			generate: () => Effect.succeed({ message: deferredMessage }),
			cancelDeferred: (handle) => {
				cancelled = handle as DeferredHandle;
				return Effect.void;
			},
		} as OperationEffects;
		const layer = makeEffectOperationLayer(store, effects, model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.abort("main")), Effect.provide(layer)));
		expect(cancelled).toEqual(deferredMessage.deferred);
		const result = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(result.outcome).toBe("aborted");
	});

	it("replays the same deferred poll after an effect crash", async () => {
		const store = new InMemoryOperationStore();
		let polls: number[] = [];
		let crashed = true;
		const effects: OperationEffects = {
			generate: () => Effect.succeed({ message: deferredMessage }),
			fetchDeferred: ({ poll }) => {
				polls.push(poll);
				if (crashed) {
					crashed = false;
					return Effect.fail(new Error("provider disconnected"));
				}
				return Effect.succeed({ pending: false, message });
			},
		} as OperationEffects;
		const layer = makeEffectOperationLayer(store, effects, model);
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		const failedResume = await Effect.runPromiseExit(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(failedResume._tag).toBe("Failure");
		const recovered = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(recovered.outcome).toBe("completed");
		expect(polls).toEqual([1, 1]);
	});

	it("rejects a transition carrying a stale register sequence", async () => {
		const store = new InMemoryOperationStore();
		const layer = makeEffectOperationLayer(store, testEffects(), model);
		const accepted = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		const snapshot = await Effect.runPromise(store.load("main"));
		await Effect.runPromise(store.commit({
			expectedOperationId: accepted.id,
			meta: accepted,
			state: snapshot.state,
			lane: snapshot.lane,
		}));
		await expect(Effect.runPromise(store.commit({
			expectedOperationId: accepted.id,
			expectedLaneStateSeq: 1,
			expectedOperationStateSeq: 1,
			meta: accepted,
			state: snapshot.state,
			lane: snapshot.lane,
		}))).rejects.toThrow("stale");
	});

	it("aborts and terminally cleans up an accepted operation", async () => {
		const store = new InMemoryOperationStore();
		const layer = makeEffectOperationLayer(store, testEffects(), model);
		const accepted = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.accept("main", [])), Effect.provide(layer)));
		const abortResult = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.abort("main")), Effect.provide(layer)));
		expect(abortResult.runId).toBe(accepted.id);
		expect(abortResult.steer).toEqual([]);
		expect(abortResult.followUp).toEqual([]);
		const terminal = await Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)));
		expect(terminal.outcome).toBe("aborted");
		await expect(Effect.runPromise(Effect.service(OperationKernelTag).pipe(Effect.flatMap((kernel) => kernel.resume("main")), Effect.provide(layer)))).rejects.toBeInstanceOf(OperationNotFound);
	});
});
