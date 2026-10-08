import { describe, expect, it } from "vitest";
import type { AssistantMessageEventStream, Context, Model } from "../src/index.ts";
import { createModels, createProvider } from "../src/models.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import { DEFAULT_PROVIDER_CONCURRENCY } from "../src/utils/concurrency-limit.ts";
import { AssistantMessageEventStream as EventStream } from "../src/utils/event-stream.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

interface HeldProvider {
	model: Model<"openai-completions">;
	provider: ReturnType<typeof createProvider>;
	/** Requests that reached the provider and have not settled. */
	admitted: number;
	/**
	 * The provider-side streams, in admission order. The slot is scoped to these, not to the
	 * wrapper `Models.streamSimple` returns, because the upstream request is what occupies the slot.
	 */
	open: AssistantMessageEventStream[];
}

/**
 * A provider whose requests stay in flight until the test settles them, so the number of concurrently
 * admitted requests is observable from outside. `fauxProvider` answers from a FIFO queue and cannot
 * express "hold this open", so admission is simulated here instead.
 */
function holdingProvider(id: string): HeldProvider {
	const model = {
		api: "openai-completions",
		baseUrl: "http://localhost:0",
		contextWindow: 1000,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		id: "held",
		input: ["text"],
		maxTokens: 100,
		name: "Held",
		provider: id,
		reasoning: false,
	} as Model<"openai-completions">;
	const open: AssistantMessageEventStream[] = [];
	const held: HeldProvider = { admitted: 0, model, open, provider: undefined as unknown as HeldProvider["provider"] };
	held.provider = createProvider({
		api: {
			stream: () => new EventStream(),
			streamSimple: () => {
				held.admitted++;
				const stream = new EventStream();
				open.push(stream);
				return stream;
			},
		},
		// The request path resolves auth before admission, so the provider must be configurable.
		auth: { apiKey: { name: "Held", resolve: async () => ({ auth: {} }) } },
		id,
		models: [model],
	});
	return held;
}

/**
 * Wait until `count` requests have reached the provider.
 *
 * `Models.streamSimple` resolves auth before admission, so the request reaches the adapter several
 * microtasks later. Polling the provider's own counter observes that directly instead of guessing
 * how many ticks it takes.
 */
async function admitted(held: HeldProvider, count: number): Promise<void> {
	for (let attempt = 0; attempt < 200 && held.admitted < count; attempt++) await tick();
	expect(held.admitted).toBe(count);
}

/**
 * Observe a stream's terminal state.
 *
 * `Models.streamSimple` reports setup failures through the stream rather than by rejecting, so a
 * refusal surfaces as an assistant message carrying the limiter's message. A stream the provider
 * holds open never ends, hence the bounded wait.
 */
async function terminal(stream: AssistantMessageEventStream): Promise<{ stopReason: string; message?: string }> {
	const observed = (async () => {
		for await (const event of stream) {
			if (event.type === "error") return { message: event.error?.errorMessage, stopReason: "error" };
			if (event.type === "done") return { stopReason: event.reason };
		}
		return { stopReason: "ended" };
	})();
	const stillOpen = new Promise<{ stopReason: string }>((resolve) =>
		setTimeout(() => resolve({ stopReason: "open" }), 50),
	);
	return Promise.race([observed, stillOpen]);
}

describe("provider request concurrency", () => {
	it("refuses the request past the configured per-provider limit", async () => {
		const held = holdingProvider("held");
		const models = createModels({ providerConcurrency: 2 });
		models.setProvider(held.provider);

		const streams = [models.streamSimple(held.model, context), models.streamSimple(held.model, context)];
		await admitted(held, 2);

		const refused = await terminal(models.streamSimple(held.model, context));
		expect(refused.stopReason).toBe("error");
		expect(refused.message).toMatch(/concurrency limit \(2 in flight\)/);
		expect(refused.message).toMatch(/held/);
		// The refusal did not reach the provider.
		expect(held.admitted).toBe(2);

		for (const stream of streams) stream.end();
	});

	it("refuses with the provider id and the configured limit", async () => {
		const held = holdingProvider("held");
		const models = createModels({ providerConcurrency: 1 });
		models.setProvider(held.provider);

		const running = models.streamSimple(held.model, context);
		await admitted(held, 1);

		const refused = await terminal(models.streamSimple(held.model, context));
		expect(refused.stopReason).toBe("error");
		expect(refused.message).toBe("Provider held is at its concurrency limit (1 in flight)");
		running.end();
	});

	it("isolates providers so one saturated provider does not block another", async () => {
		const saturated = holdingProvider("held");
		const free = holdingProvider("other");
		const models = createModels({ providerConcurrency: 1 });
		models.setProvider(saturated.provider);
		models.setProvider(free.provider);

		const blocking = models.streamSimple(saturated.model, context);
		await admitted(saturated, 1);
		expect((await terminal(models.streamSimple(saturated.model, context))).stopReason).toBe("error");

		// A different provider id must still be admitted while "held" is saturated.
		const other = models.streamSimple(free.model, context);
		await admitted(free, 1);

		blocking.end();
		other.end();
	});

	it("admits every request when concurrency control is disabled", async () => {
		const held = holdingProvider("held");
		const models = createModels({ providerConcurrency: 0 });
		models.setProvider(held.provider);

		const streams = Array.from({ length: 6 }, () => models.streamSimple(held.model, context));
		// Nothing was refused, so all six reached the provider.
		await admitted(held, 6);

		for (const stream of streams) stream.end();
	});

	it("does not admit a request whose signal is already aborted", async () => {
		const held = holdingProvider("held");
		const models = createModels({ providerConcurrency: 2 });
		models.setProvider(held.provider);

		const controller = new AbortController();
		controller.abort();
		const refused = await terminal(models.streamSimple(held.model, context, { signal: controller.signal }));
		expect(refused.stopReason).toBe("error");
		expect(held.admitted).toBe(0);
	});

	it("serves a normal provider through the limiter", async () => {
		const faux = fauxProvider();
		const models = createModels({ providerConcurrency: 2 });
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("ok")]);

		const message = await models.completeSimple(faux.getModel(), context);
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
		expect(faux.state.callCount).toBe(1);
	});

	it("releases the slot after a failed request so the next one is admitted", async () => {
		const failing = fauxProvider();
		const models = createModels({ providerConcurrency: 1 });
		models.setProvider(failing.provider);
		const model = failing.getModel();

		// The faux queue is empty, so the provider reports an error rather than hanging.
		const failed = await models.completeSimple(model, context);
		expect(failed.stopReason).toBe("error");

		// A leaked slot would refuse this instead of running it.
		const recovered = fauxProvider();
		recovered.setResponses([fauxAssistantMessage("ok")]);
		models.setProvider(recovered.provider);
		await expect(models.completeSimple(model, context)).resolves.toBeDefined();
	});

	it("frees a slot once the upstream stream settles", async () => {
		const held = holdingProvider("held");
		const models = createModels({ providerConcurrency: 1 });
		models.setProvider(held.provider);

		models.streamSimple(held.model, context);
		await admitted(held, 1);
		expect((await terminal(models.streamSimple(held.model, context))).stopReason).toBe("error");

		// The slot is scoped to the provider-side stream: it stays occupied while that request is
		// still open, and returns only when the provider settles it.
		held.open[0]?.end();
		for (let attempt = 0; attempt < 200; attempt++) {
			const next = models.streamSimple(held.model, context);
			if ((await terminal(next)).stopReason === "open") {
				await admitted(held, 2);
				held.open[1]?.end();
				return;
			}
			await tick();
		}
		throw new Error("slot was never released");
	});

	it("keeps the slot while the upstream request is still running", async () => {
		const held = holdingProvider("held");
		const models = createModels({ providerConcurrency: 1 });
		models.setProvider(held.provider);

		// Ending the wrapper the caller holds does not end the upstream request, so the slot stays
		// taken. Releasing it early would admit more traffic than the provider is actually serving.
		const wrapper = models.streamSimple(held.model, context);
		await admitted(held, 1);
		wrapper.end();

		expect((await terminal(models.streamSimple(held.model, context))).stopReason).toBe("error");

		held.open[0]?.end();
	});

	it("defaults to sixteen in flight per provider", () => {
		expect(DEFAULT_PROVIDER_CONCURRENCY).toBe(16);
	});
});
