import { InMemoryTelemetryContext, type RecordedTelemetrySpan, type TelemetrySpan } from "@OnePanda-TgSec/tg-telemetry";
import { describe, expect, it } from "vitest";
import { createModels, createProvider } from "../src/models.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	Context,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	StreamOptions,
	Usage,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const transcript = normalizeContext(context);
const imagesContext: ImagesContext = { input: [{ type: "text", text: "circle" }] };
const classifierContext: ClassifierContext = {
	state: { text: "yes" },
	questions: {
		approved: {
			type: "bool",
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

const chatModel: Model<"telemetry-chat"> = {
	id: "chat-model",
	name: "Chat Model",
	api: "telemetry-chat",
	provider: "telemetry-provider",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const imageModel: ImageModel<ImageApi> = {
	type: "image",
	id: "image-model",
	name: "Image Model",
	api: "telemetry-images",
	provider: "telemetry-images-provider",
	baseUrl: "https://example.test",
	input: ["text"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const classifierModel: ClassifierModel<ClassifierApi> = {
	type: "classifier",
	id: "classifier-model",
	name: "Classifier Model",
	api: "telemetry-classifier",
	provider: "telemetry-classifier-provider",
	baseUrl: "https://example.test",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
};

const usage: Usage = {
	input: 7,
	output: 3,
	cacheRead: 1,
	cacheWrite: 2,
	totalTokens: 12,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

/** A provider whose single chat model answers with a caller-supplied stream. */
function chatProvider(
	id: string,
	open: (model: Model<Api>, options: StreamOptions | undefined) => AssistantMessageEventStream,
) {
	const model: Model<"telemetry-chat"> = { ...chatModel, provider: id };
	const provider = createProvider({
		id,
		auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: {} }) } },
		models: [model],
		api: {
			stream: (requestModel, _context, options) => open(requestModel, options),
			streamSimple: (requestModel, _context, options) => open(requestModel, options),
		},
	});
	return { model, provider };
}

function completedMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "telemetry-chat",
		provider: "telemetry-provider",
		model: "chat-model",
		usage,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

/** Push a terminal done event on the next microtask, like a real adapter delivering its first bytes. */
function completedStream(model: Model<Api>, overrides: Partial<AssistantMessage> = {}): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = completedMessage({ api: model.api, provider: model.provider, model: model.id, ...overrides });
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
	return stream;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Observe the terminal event of a stream that may never terminate. */
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

function retryableFailure(): Error {
	const error = new Error("upstream unavailable") as Error & { status: number; headers: Headers };
	error.status = 500;
	error.headers = new Headers();
	return error;
}

function requestsIn(spans: readonly RecordedTelemetrySpan[]): readonly RecordedTelemetrySpan[] {
	return spans.filter((span) => span.name === "tg.span.provider.request");
}

function acquiresIn(spans: readonly RecordedTelemetrySpan[]): readonly RecordedTelemetrySpan[] {
	return spans.filter((span) => span.name === "tg.span.provider.acquire");
}

/** Run inside a recorded root span; requests accept a span, not a telemetry context. */
async function traced<T>(
	telemetry: InMemoryTelemetryContext,
	run: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	return telemetry.startSpan({ name: "test" }, async (span) => run(span));
}

/** Keep one root span open across several calls that must share a parent. */
async function openRoot(
	telemetry: InMemoryTelemetryContext,
): Promise<{ span: TelemetrySpan; close: () => Promise<void> }> {
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let release!: () => void;
	let span!: TelemetrySpan;
	const done = telemetry.startSpan({ name: "test" }, (startedSpan) => {
		span = startedSpan;
		markStarted();
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	await started;
	return {
		span,
		close: async () => {
			release();
			await done;
		},
	};
}

describe("provider request spans", () => {
	it("records one request span for a direct provider call", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { model, provider } = chatProvider("telemetry-provider", (requestModel) => completedStream(requestModel));

		await traced(telemetry, (root) => provider.stream(model, transcript, { telemetry: root }).result());
		await tick();

		const spans = telemetry.getSpans();
		expect(requestsIn(spans)).toHaveLength(1);
		const span = requestsIn(spans)[0]!;
		expect(span.name).toBe("tg.span.provider.request");
		expect(span.parentId).toBe(spans[0]!.id);
		expect(span.attributes).toMatchObject({
			provider: "telemetry-provider",
			api: "telemetry-chat",
			model: "chat-model",
			stopReason: "stop",
			"tokens.input": 7,
			"tokens.output": 3,
			"tokens.cacheRead": 1,
			"tokens.cacheWrite": 2,
			"cost.total": 0.33,
		});
		expect(span.attributes.errorName).toBeUndefined();
		expect(span.status).toEqual({ status: "ok" });
		expect(span.settled).toBe(true);
	});

	it("nests the request span under the acquire span through Models without changing events", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { model, provider } = chatProvider("telemetry-provider", (requestModel) => completedStream(requestModel));
		const models = createModels();
		models.setProvider(provider);

		const observed = await traced(telemetry, (root) => collect(models.stream(model, context, { telemetry: root })));
		const baseline = await collect(models.stream(model, context));
		await tick();

		expect(observed).toEqual(baseline);
		const spans = telemetry.getSpans();
		expect(requestsIn(spans)).toHaveLength(1);
		expect(acquiresIn(spans)).toHaveLength(1);
		const acquire = acquiresIn(spans)[0];
		const request = requestsIn(spans)[0];
		expect(acquire?.attributes.provider).toBe("telemetry-provider");
		expect(acquire?.parentId).toBe(spans[0]!.id);
		expect(request?.parentId).toBe(acquire?.id);
		expect(request?.status).toEqual({ status: "ok" });
	});

	it("reports a retried call, a direct call, and exhausted retries distinctly", async () => {
		const run = async (succeedOnCall: number, maxRetries: number, telemetry: InMemoryTelemetryContext) => {
			let calls = 0;
			const { model, provider } = chatProvider("telemetry-retry", (requestModel, options) => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					try {
						await retryProviderRequest(
							async () => {
								calls += 1;
								if (calls < succeedOnCall) throw retryableFailure();
								return "ok";
							},
							{ maxRetries, signal: options?.signal },
						);
						stream.push({ type: "done", reason: "stop", message: completedMessage({ model: requestModel.id }) });
					} catch (error) {
						stream.push({
							type: "error",
							reason: "error",
							error: completedMessage({
								model: requestModel.id,
								stopReason: "error",
								errorMessage: error instanceof Error ? error.message : String(error),
							}),
						});
					}
				})();
				return stream;
			});

			await traced(telemetry, (root) => provider.stream(model, transcript, { telemetry: root }).result());
			await tick();
			return { calls, span: requestsIn(telemetry.getSpans())[0]! };
		};

		const retried = await run(2, 1, new InMemoryTelemetryContext());
		expect(retried.calls).toBe(2);
		expect(retried.span.attributes.retried).toBeUndefined();
		expect(retried.span.attributes.stopReason).toBe("stop");
		expect(retried.span.status).toEqual({ status: "ok" });

		const direct = await run(1, 1, new InMemoryTelemetryContext());
		expect(direct.calls).toBe(1);
		expect(direct.span.attributes.retried).toBeUndefined();
		expect(direct.span.status).toEqual({ status: "ok" });

		const exhausted = await run(Number.POSITIVE_INFINITY, 1, new InMemoryTelemetryContext());
		expect(exhausted.calls).toBe(2);
		expect(exhausted.span.attributes.retried).toBeUndefined();
		expect(exhausted.span.attributes.stopReason).toBe("error");
		expect(exhausted.span.status.status).toBe("error");
	});

	it("records a refused admission without a request span", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const model: Model<"telemetry-chat"> = { ...chatModel, provider: "telemetry-gate" };
		const open: AssistantMessageEventStream[] = [];
		let admitted = 0;
		const provider = createProvider({
			id: "telemetry-gate",
			auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => {
					admitted += 1;
					const stream = new AssistantMessageEventStream();
					open.push(stream);
					return stream;
				},
			},
		});
		const models = createModels({ providerConcurrency: 1 });
		models.setProvider(provider);

		const root = await openRoot(telemetry);
		models.streamSimple(model, context, { telemetry: root.span });
		for (let attempt = 0; attempt < 200 && admitted < 1; attempt++) await tick();
		expect(admitted).toBe(1);

		const refused = await terminal(models.streamSimple(model, context, { telemetry: root.span }));
		expect(refused.stopReason).toBe("error");
		expect(refused.message).toMatch(/concurrency limit \(1 in flight\)/);
		expect(admitted).toBe(1);
		await tick();

		const spans = telemetry.getSpans();
		const acquires = acquiresIn(spans);
		expect(acquires).toHaveLength(2);
		expect(requestsIn(spans)).toHaveLength(1);
		expect(acquires[1]?.status).toEqual({
			status: "error",
			error: { name: "ConcurrencyLimitError", message: expect.any(String) },
		});
		expect(acquires[1]?.settled).toBe(true);

		open[0]?.push({ type: "done", reason: "stop", message: completedMessage({ provider: "telemetry-gate" }) });
		await root.close();
	});

	it("leaves the request path untouched without a telemetry span", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { model, provider } = chatProvider("telemetry-provider", (requestModel) => completedStream(requestModel));

		const baseline = await collect(provider.stream(model, transcript));
		const withSpan = await traced(telemetry, (root) =>
			collect(provider.stream(model, transcript, { telemetry: root })),
		);
		await tick();

		expect(withSpan).toEqual(baseline);
		expect(requestsIn(telemetry.getSpans())).toHaveLength(1);
	});

	it("marks the request span failed for stream errors and synchronous setup throws", async () => {
		const streamTelemetry = new InMemoryTelemetryContext();
		const streamFailure = chatProvider("telemetry-error", (requestModel) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "error",
					reason: "error",
					error: completedMessage({
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
						stopReason: "error",
						errorMessage: "rate limited",
						diagnostics: [
							{
								type: "provider",
								timestamp: 0,
								error: { name: "ProviderRateLimitError", message: "rate limited" },
							},
						],
					}),
				}),
			);
			return stream;
		});
		await traced(streamTelemetry, (root) =>
			streamFailure.provider.stream(streamFailure.model, transcript, { telemetry: root }).result(),
		);
		await tick();

		const streamSpan = requestsIn(streamTelemetry.getSpans())[0]!;
		expect(streamSpan.attributes.stopReason).toBe("error");
		expect(streamSpan.attributes.errorName).toBe("ProviderRateLimitError");
		expect(streamSpan.status).toEqual({
			status: "error",
			error: { name: "ProviderRateLimitError", message: "rate limited" },
		});

		class SetupError extends Error {
			readonly name = "SetupError";
		}
		const throwTelemetry = new InMemoryTelemetryContext();
		const throwing = chatProvider("telemetry-throw", () => {
			throw new SetupError("no credential");
		});
		await traced(throwTelemetry, (root) => {
			expect(() => throwing.provider.stream(throwing.model, transcript, { telemetry: root })).toThrow(SetupError);
		});
		await tick();

		const throwSpan = requestsIn(throwTelemetry.getSpans())[0]!;
		expect(throwSpan.attributes.stopReason).toBeUndefined();
		expect(throwSpan.status).toEqual({ status: "error", error: { name: "SetupError", message: "no credential" } });
		expect(throwSpan.settled).toBe(true);
	});

	it("records image and classifier requests without an acquire span or fabricated usage", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "telemetry-images-provider",
				auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: {} }) } },
				models: [imageModel],
				images: {
					[imageModel.api]: {
						generateImages: async (requestModel) => ({
							api: requestModel.api,
							provider: requestModel.provider,
							model: requestModel.id,
							output: [],
							stopReason: "stop",
							timestamp: 0,
						}),
					},
				},
			}),
		);
		models.setProvider(
			createProvider({
				id: "telemetry-classifier-provider",
				auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: {} }) } },
				models: [classifierModel],
				classifiers: {
					[classifierModel.api]: {
						classify: async (requestModel) => ({
							api: requestModel.api,
							provider: requestModel.provider,
							model: requestModel.id,
							answers: {},
							stopReason: "stop",
							timestamp: 0,
						}),
					},
				},
			}),
		);

		await traced(telemetry, async (root) => {
			await models.generateImages(imageModel, imagesContext, { telemetry: root });
			await models.classify(classifierModel, classifierContext, { telemetry: root });
		});
		await tick();

		const spans = telemetry.getSpans();
		expect(requestsIn(spans)).toHaveLength(2);
		expect(acquiresIn(spans)).toHaveLength(0);
		const [imageSpan, classifierSpan] = requestsIn(spans) as readonly [RecordedTelemetrySpan, RecordedTelemetrySpan];
		expect(imageSpan.attributes).toMatchObject({
			provider: "telemetry-images-provider",
			api: "telemetry-images",
			model: "image-model",
			stopReason: "stop",
		});
		expect(classifierSpan.attributes).toMatchObject({
			provider: "telemetry-classifier-provider",
			api: "telemetry-classifier",
			model: "classifier-model",
			stopReason: "stop",
		});
		for (const span of spans) {
			expect(
				Object.keys(span.attributes).filter((key) => key.startsWith("tokens.") || key.startsWith("cost.")),
			).toEqual([]);
			expect(span.status).toEqual({ status: "ok" });
		}
	});
});
