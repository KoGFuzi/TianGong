import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createModels,
	createProvider,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@OnePanda-TgSec/tg-ai";
import {
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
	type RecordedTelemetrySpan,
	type TelemetryContext,
} from "@OnePanda-TgSec/tg-telemetry";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) =>
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult",
	) as Message[];
}

function agentModel(): Model<"telemetry-agent"> {
	return {
		id: "agent-model",
		name: "Agent Model",
		api: "telemetry-agent",
		provider: "telemetry-provider",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

interface ScriptStep {
	content: AssistantMessage["content"];
	stopReason: "toolUse" | "stop" | "error";
}

/** Assistant event stream that settles on its terminal event, like a real adapter's. */
class AdapterStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error(`Unexpected terminal event: ${event.type}`);
			},
		);
	}
}

/** An adapter that answers each call with the next scripted step, repeating the last one. */
function scriptedAdapter(steps: readonly ScriptStep[]) {
	let index = 0;
	return (model: Model<"telemetry-agent">): AdapterStream => {
		const step = steps[Math.min(index, steps.length - 1)]!;
		index += 1;
		const stream = new AdapterStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				role: "assistant",
				content: step.content,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: step.stopReason,
				timestamp: 0,
			};
			if (step.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: step.stopReason, message });
		});
		return stream;
	};
}

function echoTool(executed: string[]): AgentTool<ReturnType<typeof echoSchema>, { value: string }> {
	const schema = echoSchema();
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: schema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
		},
	};
}

function echoSchema() {
	return Type.Object({ value: Type.String() });
}

/**
 * Run a two-turn agent through the real `Models` path: the first turn issues an `echo` tool call,
 * the second answers with text. `telemetry` is forwarded to the loop as `telemetryContext`.
 */
async function runAgent(
	telemetry: TelemetryContext | undefined,
	extra: Partial<AgentLoopConfig> = {},
): Promise<{ events: AgentEvent[]; executed: string[] }> {
	const model = agentModel();
	const adapter = scriptedAdapter([
		{
			content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "hi" } }],
			stopReason: "toolUse",
		},
		{ content: [{ type: "text", text: "done" }], stopReason: "stop" },
	]);
	const provider = createProvider({
		id: "telemetry-provider",
		auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: {} }) } },
		models: [model],
		api: { stream: adapter, streamSimple: adapter },
	});
	const models = createModels();
	models.setProvider(provider);

	const executed: string[] = [];
	const context: AgentContext = { messages: [], tools: [echoTool(executed)] };
	const config: AgentLoopConfig = {
		model,
		convertToLlm: identityConverter,
		telemetryContext: telemetry,
		getFollowUpMessages: async () => [],
		...extra,
	};

	const events: AgentEvent[] = [];
	const stream = agentLoop([userMessage("hi")], context, config, undefined, (requestModel, requestContext, options) =>
		models.streamSimple(requestModel, requestContext, options),
	);
	for await (const event of stream) events.push(event);
	return { events, executed };
}

async function runErrorAgent(telemetry: TelemetryContext | undefined): Promise<AgentEvent[]> {
	const model = agentModel();
	const adapter = scriptedAdapter([{ content: [], stopReason: "error" }]);
	const provider = createProvider({
		id: "telemetry-provider",
		auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: {} }) } },
		models: [model],
		api: { stream: adapter, streamSimple: adapter },
	});
	const models = createModels();
	models.setProvider(provider);

	const config: AgentLoopConfig = {
		model,
		convertToLlm: identityConverter,
		telemetryContext: telemetry,
		getFollowUpMessages: async () => [],
	};
	const events: AgentEvent[] = [];
	const stream = agentLoop([userMessage("hi")], { messages: [], tools: [] }, config, undefined, (m, c, o) =>
		models.streamSimple(m, c, o),
	);
	for await (const event of stream) events.push(event);
	return events;
}

function spansNamed(spans: readonly RecordedTelemetrySpan[], name: string): RecordedTelemetrySpan[] {
	return spans.filter((span) => span.name === name);
}

describe("agent telemetry spans", () => {
	it("nests acquire, request, and tool spans under the turn span", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { events, executed } = await runAgent(telemetry);
		await tick();

		expect(executed).toEqual(["hi"]);
		expect(events.at(-1)?.type).toBe("agent_end");

		const spans = telemetry.getSpans();
		const turns = spansNamed(spans, "tg.span.agent.turn");
		const acquires = spansNamed(spans, "tg.span.provider.acquire");
		const requests = spansNamed(spans, "tg.span.provider.request");
		const tools = spansNamed(spans, "tg.span.agent.tool");
		expect(turns).toHaveLength(2);
		expect(acquires).toHaveLength(2);
		expect(requests).toHaveLength(2);
		expect(tools).toHaveLength(1);

		const toolTurn = turns[0]!;
		expect(toolTurn.parentId).toBeNull();
		expect(toolTurn.attributes).toMatchObject({
			provider: "telemetry-provider",
			model: "agent-model",
			stopReason: "toolUse",
			toolCallCount: 1,
		});
		expect(toolTurn.status).toEqual({ status: "ok" });

		const turnAcquire = acquires.find((span) => span.parentId === toolTurn.id);
		expect(turnAcquire).toBeDefined();
		expect(turnAcquire?.attributes.provider).toBe("telemetry-provider");
		const turnRequest = requests.find((span) => span.parentId === turnAcquire?.id);
		expect(turnRequest?.attributes).toMatchObject({
			provider: "telemetry-provider",
			api: "telemetry-agent",
			model: "agent-model",
			stopReason: "toolUse",
			retried: false,
			"tokens.input": 1,
			"tokens.output": 1,
		});

		const tool = tools[0]!;
		expect(tool.parentId).toBe(toolTurn.id);
		expect(tool.attributes).toMatchObject({ toolName: "echo", isError: false });
		expect(tool.status).toEqual({ status: "ok" });

		const finalTurn = turns[1]!;
		expect(finalTurn.parentId).toBeNull();
		expect(finalTurn.attributes).toMatchObject({ stopReason: "stop", toolCallCount: 0 });
		const finalAcquire = acquires.find((span) => span.parentId === finalTurn.id);
		const finalRequest = requests.find((span) => span.parentId === finalAcquire?.id);
		expect(finalRequest?.attributes.stopReason).toBe("stop");
	});

	it("records a denied tool call as a failed tool span", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { events, executed } = await runAgent(telemetry, {
			permissionRules: [{ action: "execute", resource: "tool:echo", effect: "ask" }],
			onPermissionAsk: async () => "deny",
		});
		await tick();

		expect(executed).toEqual([]);
		expect(events.at(-1)?.type).toBe("agent_end");

		const tools = spansNamed(telemetry.getSpans(), "tg.span.agent.tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]?.attributes).toMatchObject({ toolName: "echo", isError: true });
		expect(tools[0]?.status).toEqual({ status: "error" });
	});

	it("marks a failed turn and its request span as errors", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const events = await runErrorAgent(telemetry);
		await tick();

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);

		const spans = telemetry.getSpans();
		const turn = spansNamed(spans, "tg.span.agent.turn")[0]!;
		expect(turn.attributes).toMatchObject({ stopReason: "error", toolCallCount: 0 });
		expect(turn.status.status).toBe("error");

		const request = spansNamed(spans, "tg.span.provider.request")[0]!;
		expect(request.attributes.stopReason).toBe("error");
		expect(request.status.status).toBe("error");
		const acquire = spansNamed(spans, "tg.span.provider.acquire")[0]!;
		expect(acquire.parentId).toBe(turn.id);
		expect(request.parentId).toBe(acquire.id);
	});

	it("leaves the unconfigured path event-identical and unrecorded", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const traced = await runAgent(telemetry);
		const noop = await runAgent(NOOP_TELEMETRY_CONTEXT);
		const plain = await runAgent(undefined);
		await tick();

		expect(noop.events.map((event) => event.type)).toEqual(traced.events.map((event) => event.type));
		expect(plain.events.map((event) => event.type)).toEqual(traced.events.map((event) => event.type));
		expect(telemetry.getSpans().map((span) => span.name)).toEqual([
			"tg.span.agent.turn",
			"tg.span.provider.acquire",
			"tg.span.provider.request",
			"tg.span.agent.tool",
			"tg.span.agent.turn",
			"tg.span.provider.acquire",
			"tg.span.provider.request",
		]);
	});
});
