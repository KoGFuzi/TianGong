// @ts-nocheck - Test file
import { Effect, Ref } from "effect";
import { describe, expect, it } from "../bun-test.ts";
import { createModels, type Model } from "@onepanda-tiangongsec/tg-ai";
import {
	HarnessStateTag,
	harnessLayerFromOptions,
	getActiveTools,
	getModel as getEffectModel,
	getThinkingLevel,
	runHarness,
	setActiveTools,
	setThinkingLevel,
} from "../../src/harness/effect.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import type { AgentHarnessOptions } from "../../src/harness/agent-harness.ts";

const options = (): AgentHarnessOptions => ({
	session: new Session(new InMemorySessionStorage({ id: "effect", createdAt: 1 })),
	models: createModels(),
	model: model,
});

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

describe("Effect v4 harness boundary", () => {
	it("provides immutable configuration through a shared Ref", async () => {
		const input = options();
		const layer = harnessLayerFromOptions(input);
		const model = await runHarness(getEffectModel, layer);
		expect(model).toBe(input.model);
		await runHarness(setThinkingLevel("high"), layer);
		await runHarness(setActiveTools(["read"]), layer);
		expect(await runHarness(getThinkingLevel, layer)).toBe("high");
		expect(await runHarness(getActiveTools, layer)).toEqual(["read"]);
	});

	it("supports normal Effect composition", async () => {
		const input = options();
		const layer = harnessLayerFromOptions(input);
		const result = await runHarness(
			Effect.gen(function* () {
				const state = yield* Effect.service(HarnessStateTag);
				return (yield* Ref.get(state)).lane;
			}),
			layer,
		);
		expect(result).toBeDefined();
	});
});
