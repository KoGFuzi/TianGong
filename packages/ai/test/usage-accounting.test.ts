import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { calculateCost } from "../src/models.ts";
import type { Model, Usage } from "../src/types.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

/** `gpt-4o-mini` resolves to the Responses API in the catalog; the completions adapter needs the api pinned. */
function completionsModel(): Model<"openai-completions"> {
	const { compat: _compat, ...base } = getModel("openai", "gpt-4o-mini");
	return { ...(base as Omit<Model<"openai-completions">, "api">), api: "openai-completions" };
}

const openaiCompletionsModel = completionsModel();
const openaiResponsesModel = getModel("openai", "gpt-5-mini");
const anthropicModel = getModel("anthropic", "claude-opus-4-8");
const mistralModel = getModel("mistral", "devstral-medium-latest");

function sseResponse(body: string): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function completionsStream(usage: Record<string, unknown>): Response {
	return sseResponse(
		`data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n` +
			`data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n` +
			"data: [DONE]\n\n",
	);
}

function emptyCostUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("usage accounting: openai-completions", () => {
	it("subtracts cached and cache-write tokens from prompt_tokens", async () => {
		const result = await streamOpenAICompletions(openaiCompletionsModel, context, {
			apiKey: "test",
			fetch: async () =>
				completionsStream({
					prompt_tokens: 5000,
					completion_tokens: 100,
					total_tokens: 5100,
					prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 500 },
					completion_tokens_details: { reasoning_tokens: 40 },
				}),
		}).result();

		const usage = result.usage;
		expect(usage.input).toBe(1500);
		expect(usage.cacheRead).toBe(3000);
		expect(usage.cacheWrite).toBe(500);
		expect(usage.output).toBe(100);
		expect(usage.reasoning).toBe(40);
		expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(5000);
	});

	it("reads DeepSeek-style prompt_cache_hit_tokens as cache reads", async () => {
		const result = await streamOpenAICompletions(openaiCompletionsModel, context, {
			apiKey: "test",
			fetch: async () =>
				completionsStream({ prompt_tokens: 5000, completion_tokens: 10, prompt_cache_hit_tokens: 1200 }),
		}).result();

		const usage = result.usage;
		expect(usage.cacheRead).toBe(1200);
		expect(usage.input).toBe(3800);
	});

	it("reads Kimi-style top-level cached_tokens as cache reads", async () => {
		const result = await streamOpenAICompletions(openaiCompletionsModel, context, {
			apiKey: "test",
			fetch: async () => completionsStream({ prompt_tokens: 5000, completion_tokens: 10, cached_tokens: 700 }),
		}).result();

		const usage = result.usage;
		expect(usage.cacheRead).toBe(700);
		expect(usage.input).toBe(4300);
	});

	it("reports no cache counters when the provider omits them", async () => {
		const result = await streamOpenAICompletions(openaiCompletionsModel, context, {
			apiKey: "test",
			fetch: async () => completionsStream({ prompt_tokens: 42, completion_tokens: 7 }),
		}).result();

		const usage = result.usage;
		expect(usage.input).toBe(42);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
	});
});

describe("usage accounting: openai-responses", () => {
	it("subtracts cached and cache-write tokens from input_tokens", async () => {
		const completed = {
			type: "response.completed",
			sequence_number: 1,
			response: {
				id: "resp_test",
				status: "completed",
				usage: {
					input_tokens: 8000,
					output_tokens: 200,
					total_tokens: 8200,
					input_tokens_details: { cached_tokens: 6000, cache_write_tokens: 1000 },
					output_tokens_details: { reasoning_tokens: 80 },
				},
			},
		};
		const result = await streamOpenAIResponses(openaiResponsesModel, context, {
			apiKey: "test",
			fetch: async () =>
				sseResponse(
					`event: response.output_text.delta\ndata: ${JSON.stringify({
						type: "response.output_text.delta",
						sequence_number: 0,
						delta: "hi",
					})}\n\n` + `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
				),
		}).result();

		const usage = result.usage;
		expect(usage.input).toBe(1000);
		expect(usage.cacheRead).toBe(6000);
		expect(usage.cacheWrite).toBe(1000);
		expect(usage.output).toBe(200);
		expect(usage.reasoning).toBe(80);
		expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(8000);
	});
});

describe("usage accounting: anthropic-messages", () => {
	function anthropicSse(inputTokens: number, cacheRead: number, cacheWrite: number, outputTokens: number): Response {
		return sseResponse(
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: {
						input_tokens: inputTokens,
						output_tokens: 0,
						cache_read_input_tokens: cacheRead,
						cache_creation_input_tokens: cacheWrite,
					},
				},
			})}\n\n` +
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: inputTokens,
						output_tokens: outputTokens,
						cache_read_input_tokens: cacheRead,
						cache_creation_input_tokens: cacheWrite,
					},
				})}\n\n` +
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		);
	}

	it("keeps Anthropic's input_tokens as-is and adds cache counters separately", async () => {
		const result = await streamAnthropic(anthropicModel, context, {
			apiKey: "test",
			fetch: async () => anthropicSse(100, 700, 200, 50),
		}).result();

		const usage = result.usage;
		expect(usage.input).toBe(100);
		expect(usage.cacheRead).toBe(700);
		expect(usage.cacheWrite).toBe(200);
		expect(usage.output).toBe(50);
		expect(usage.totalTokens).toBe(1050);
	});
});

describe("usage accounting: mistral-conversations", () => {
	it("subtracts cached prompt tokens from prompt_tokens", async () => {
		const result = await streamMistral(mistralModel, context, {
			apiKey: "test",
			fetch: async () =>
				sseResponse(
					`data: ${JSON.stringify({
						id: "mistral-response-id",
						model: mistralModel.id,
						choices: [{ index: 0, finish_reason: "stop", delta: {} }],
						usage: {
							prompt_tokens: 4000,
							completion_tokens: 60,
							prompt_tokens_details: { cached_tokens: 1500 },
						},
					})}\n\ndata: [DONE]\n\n`,
				),
		}).result();

		const usage = result.usage;
		expect(usage.input).toBe(2500);
		expect(usage.cacheRead).toBe(1500);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.input + usage.cacheRead).toBe(4000);
	});
});

describe("calculateCost", () => {
	function modelWithCost(cost: Model<"openai-completions">["cost"]): Model<"openai-completions"> {
		return { ...completionsModel(), cost };
	}

	function usage(input: number, output: number, extra?: Partial<Usage>): Usage {
		return { ...emptyCostUsage(), input, output, ...extra };
	}

	it("prices each cache class at its own rate", () => {
		const model = modelWithCost({ input: 2, output: 10, cacheRead: 0.5, cacheWrite: 4 });
		const cost = calculateCost(model, usage(1000, 2000, { cacheRead: 3000, cacheWrite: 1000 }));

		expect(cost.input).toBeCloseTo((1000 * 2) / 1_000_000, 12);
		expect(cost.output).toBeCloseTo((2000 * 10) / 1_000_000, 12);
		expect(cost.cacheRead).toBeCloseTo((3000 * 0.5) / 1_000_000, 12);
		expect(cost.cacheWrite).toBeCloseTo((1000 * 4) / 1_000_000, 12);
		expect(cost.total).toBeCloseTo(cost.input + cost.output + cost.cacheRead + cost.cacheWrite, 12);
	});

	it("charges the 1h cache-write portion at twice the input rate", () => {
		const model = modelWithCost({ input: 2, output: 10, cacheRead: 0.5, cacheWrite: 4 });
		const cost = calculateCost(model, usage(0, 0, { cacheWrite: 1000, cacheWrite1h: 600 }));

		expect(cost.cacheWrite).toBeCloseTo((400 * 4 + 600 * 2 * 2) / 1_000_000, 12);
	});

	it("selects the tier whose inputTokensAbove the request exceeds", () => {
		const model = modelWithCost({
			input: 2,
			output: 10,
			cacheRead: 0.5,
			cacheWrite: 4,
			tiers: [{ inputTokensAbove: 200_000, input: 4, output: 20, cacheRead: 1, cacheWrite: 8 }],
		});

		const below = calculateCost(model, usage(199_999, 0));
		expect(below.input).toBeCloseTo((199_999 * 2) / 1_000_000, 12);

		const above = calculateCost(model, usage(200_001, 0));
		expect(above.input).toBeCloseTo((200_001 * 4) / 1_000_000, 12);
	});

	it("counts cached and cache-write tokens when picking the tier", () => {
		const model = modelWithCost({
			input: 2,
			output: 10,
			cacheRead: 0.5,
			cacheWrite: 4,
			tiers: [{ inputTokensAbove: 200_000, input: 4, output: 20, cacheRead: 1, cacheWrite: 8 }],
		});

		// 150k uncached + 60k cache reads exceeds the 200k threshold, so the tier applies to every class.
		const cost = calculateCost(model, usage(150_000, 0, { cacheRead: 60_000 }));
		expect(cost.input).toBeCloseTo((150_000 * 4) / 1_000_000, 12);
		expect(cost.cacheRead).toBeCloseTo((60_000 * 1) / 1_000_000, 12);
	});

	it("keeps base rates when the counted total stays below the tier threshold", () => {
		const model = modelWithCost({
			input: 2,
			output: 10,
			cacheRead: 0.5,
			cacheWrite: 4,
			tiers: [{ inputTokensAbove: 200_000, input: 4, output: 20, cacheRead: 1, cacheWrite: 8 }],
		});

		const cost = calculateCost(model, usage(150_000, 0, { cacheRead: 10_000 }));
		expect(cost.input).toBeCloseTo((150_000 * 2) / 1_000_000, 12);
		expect(cost.cacheRead).toBeCloseTo((10_000 * 0.5) / 1_000_000, 12);
	});
});
