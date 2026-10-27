import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@OnePanda-TgSec/tg-ai";
import { type Agent, type Conversation, type ConversationId, defineExtension } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTgSecEvidenceStore } from "../src/evidence/store.ts";
import {
	openSecAgent,
	SEC_AGENT_ROLES,
	type SecAgent,
	type SecAgentLane,
	type SecPromptSections,
	secLaneSections,
	secRolePolicies,
	secRoleSections,
	secScopePromptSections,
} from "../src/index.ts";
import { TgSecTaskScopeDoc } from "../src/task-scope.ts";
import { createTaskTool } from "../src/task-tool.ts";
import { createSecToolsExtension } from "../src/tools/extension.ts";
import type { HttpRequest, HttpResponse, RequestExecutor } from "../src/tools/transport.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

const noopExecutor: RequestExecutor = {
	async send(request: HttpRequest): Promise<HttpResponse> {
		return { status: 204, headers: {}, body: new Uint8Array(), contentType: request.method };
	},
};

/**
 * A campaign with the same extension names production installs. `sec-core` is a stub carrying the
 * real `task` tool: these tests exercise the role catalog's policy mechanics, not guard attestation.
 */
async function openRoleAgent(
	project: string,
	telemetry: InMemoryTelemetryContext = new InMemoryTelemetryContext(),
	lane: SecAgentLane = "redteam",
): Promise<{
	agent: SecAgent;
	faux: ReturnType<typeof fauxSetup>["faux"];
	store: Awaited<ReturnType<typeof openTgSecEvidenceStore>>;
	telemetry: InMemoryTelemetryContext;
}> {
	const dir = await tempDir();
	const { faux, models } = fauxSetup();
	const store = await openTgSecEvidenceStore({ dir: await tempDir("tg-sec-role-ev-") });
	trackStore(store);
	const taskTool = createTaskTool({ policies: secRolePolicies, lane, telemetry });
	const agent = await openSecAgent({
		context,
		project,
		lane,
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		extensions: [
			defineExtension({ name: "sec-core", tools: [taskTool], sections: secScopePromptSections(lane) }),
			createSecToolsExtension({ store, executor: noopExecutor, lane }),
		],
	});
	return { agent, faux, store, telemetry };
}

async function toolResultText(conversation: Conversation): Promise<string> {
	const page = await conversation.entries({}, 100, undefined, context);
	const texts: string[] = [];
	for (const entry of page.items) {
		for (const message of entry.model ?? []) {
			if (message.role === "toolResult")
				texts.push(message.content.map((block) => (block.type === "text" ? block.text : "")).join(" "));
		}
	}
	return texts.join("\n");
}

const names = (tools: readonly { readonly name: string }[]): string[] => tools.map((tool) => tool.name);

/** Every enabled tool: offered, deferred, or callable from a nested call — the whole capability filter. */
const surfaceNames = (agent: Agent): string[] => [
	...new Set([...names(agent.tools), ...names(agent.deferred), ...names(agent.callable)]),
];

describe("role policy catalog", () => {
	for (const role of SEC_AGENT_ROLES) {
		it(`binds a ${role} child to exactly its role surface`, async () => {
			const { agent, faux } = await openRoleAgent(`role-${role}`);
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("task", { intent: `${role} job`, role }, { id: "r-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(`${role} answer`),
				fauxAssistantMessage("parent done"),
			]);

			const submission = await agent.root.submit({ type: "input", content: "delegate" }, context);
			expect((await submission.wait(context)).status).toBe("done");

			const nodes = await agent.actionTree(context);
			expect(nodes).toHaveLength(1);
			const childId = nodes[0]!.conversationId as ConversationId;
			const child = await agent.harness.conversation(childId, context);
			expect(child).toBeDefined();
			const resolved = await child!.agent(context);
			const policy = secRolePolicies[role];
			const httpTool = agent.registry
				.snapshot()
				.tools()
				.find((entry) => entry.tool.name === "http_request");
			expect(httpTool).toBeDefined();

			// The policy is closed: extension order and the enabled set are exactly the catalog's.
			expect(resolved.extensions.map((extension) => extension.name)).toEqual(policy.extensions);
			expect(surfaceNames(resolved).sort()).toEqual([...(policy.tools ?? [])].sort());

			const callable = names(resolved.callable);
			const offered = names(resolved.tools);
			const deferred = names(resolved.deferred);
			const surface = surfaceNames(resolved);

			if (role === "redteam") {
				expect(surface).toEqual(expect.arrayContaining(["http_request", "evidence_capture", "traffic_query"]));
				expect(deferred).toEqual(expect.arrayContaining(["http_request", "evidence_capture", "traffic_query"]));
				expect(offered).not.toContain("http_request");
				expect(surface).toEqual(expect.arrayContaining(["bash", "read", "write", "edit", "codemode"]));
			}
			if (role === "binary") {
				expect(surface).not.toContain("http_request");
				expect(surface).not.toContain("traffic_query");
				expect(callable).toContain("evidence_capture");
				expect(surface).toEqual(
					expect.arrayContaining(["evidence_capture", "bash", "read", "write", "edit", "codemode"]),
				);
				// Even naming it in `modelTools` cannot pull it in: it is outside the capability filter.
				await child!.configure({ modelTools: { add: [httpTool!.tool] } }, context);
				const after = await child!.agent(context);
				expect(names(after.tools)).not.toContain("http_request");
				expect(names(after.deferred)).not.toContain("http_request");
				expect(surfaceNames(after)).not.toContain("http_request");
			}
			if (role === "reporting") {
				for (const blocked of ["http_request", "evidence_capture", "bash", "write", "edit", "codemode"]) {
					expect(surface).not.toContain(blocked);
				}
				expect(surface).toEqual(expect.arrayContaining(["read", "traffic_query", "tool_search", "task"]));
				expect(offered).toEqual(expect.arrayContaining(["read", "tool_search", "task"]));
				expect(deferred).toEqual(expect.arrayContaining(["traffic_query"]));
				// A reporting child cannot reach http_request even through `modelTools`.
				await child!.configure({ modelTools: { add: [httpTool!.tool] } }, context);
				const after = await child!.agent(context);
				expect(names(after.tools)).not.toContain("http_request");
				expect(names(after.deferred)).not.toContain("http_request");
				expect(surfaceNames(after)).not.toContain("http_request");
			}

			const scope = await agent.harness.snapshot(TgSecTaskScopeDoc, childId, context);
			expect(scope).toEqual({ depth: 1, role, lane: "redteam" });
			await agent.close(context);
		}, 30_000);
	}
});

describe("delegation depth gate", () => {
	it("fails a nested task closed and records a depth-rejected fork span", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { agent, faux } = await openRoleAgent("role-depth", telemetry);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { intent: "child work", role: "redteam" }, { id: "d-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("task", { intent: "grandchild work", role: "redteam" }, { id: "d-2" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("nested delegation refused"),
			fauxAssistantMessage("parent done"),
		]);

		const submission = await agent.root.submit({ type: "input", content: "delegate" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		// Only the root's delegation exists: the rejected call forked nothing.
		const nodes = await agent.actionTree(context);
		expect(nodes).toHaveLength(1);
		const childId = nodes[0]!.conversationId as ConversationId;
		const child = await agent.harness.conversation(childId, context);
		expect(child).toBeDefined();
		expect(await toolResultText(child!)).toContain("nested delegation is not available");

		const forks = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.fork");
		expect(forks).toHaveLength(2);
		const rejected = forks.find((span) => span.attributes.outcome === "depth-rejected");
		expect(rejected?.attributes.depth).toBe(2);
		expect(rejected?.attributes.role).toBe("redteam");
		expect(rejected?.attributes.lane).toBe("redteam");
		const delegated = forks.find((span) => span.attributes.outcome === "done");
		expect(delegated?.attributes.depth).toBe(1);

		await agent.close(context);
	}, 30_000);
});

describe("sub-session evidence capture", () => {
	it("records a binary child's capture as a binding in the campaign evidence store", async () => {
		const { agent, faux, store } = await openRoleAgent("role-evidence");
		const request = Buffer.from("GET /sample HTTP/1.1\r\nHost: sample.test\r\n\r\n").toString("base64");
		const response = Buffer.from("HTTP/1.1 200 OK\r\n\r\nsample-bytes").toString("base64");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { intent: "capture the sample", role: "binary" }, { id: "e-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "evidence capture" }, { id: "e-2" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall(
						"evidence_capture",
						{
							requestBase64: request,
							responseBase64: response,
							findingId: "sub-evidence",
							url: "http://sample.test/sample",
							method: "GET",
							status: 200,
						},
						{ id: "e-3" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("captured"),
			fauxAssistantMessage("parent done"),
		]);

		const submission = await agent.root.submit({ type: "input", content: "capture" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		const set = await store.list("sub-evidence");
		expect(set.bindings).toHaveLength(1);
		const binding = set.bindings[0]!;
		expect(binding.role).toBe("supporting");
		const snapshot = await store.getSnapshot(binding.snapshotId);
		expect(snapshot?.fields.url).toBe("http://sample.test/sample");
		expect(snapshot?.fields.respLen).toBe(Buffer.from("HTTP/1.1 200 OK\r\n\r\nsample-bytes").length);

		await agent.close(context);
	}, 30_000);
});

/** Sections in effect for one provider request, replayed from its system messages in order. */
function observedSections(messages: readonly Message[]): Record<string, string> {
	const shown: Record<string, string> = {};
	for (const message of messages) {
		if (message.role !== "system" || message.sections === undefined) continue;
		for (const [key, value] of Object.entries(message.sections)) {
			if (value === null) delete shown[key];
			else shown[key] = value;
		}
	}
	return shown;
}

function observe(log: Record<string, string>[], reply: AssistantMessage): FauxResponseStep {
	return (transcript) => {
		log.push(observedSections(transcript.messages));
		return reply;
	};
}

/** A section map as it reaches the provider: the preamble unwrapped, every other key tag-wrapped. */
function wrapped(sections: SecPromptSections): Record<string, string> {
	return Object.fromEntries(
		Object.entries(sections).map(([key, text]) => [key, key === "preamble" ? text : `<${key}>\n${text}\n</${key}>`]),
	);
}

/** The sections `sec-core` owns; other extensions contribute their own (`codemode`, `tool-search`). */
const OWN_KEYS: readonly string[] = ["preamble", "lane", "plan", "role", "terminal", "tools", "rubric"];

function own(sections: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(sections).filter(([key]) => OWN_KEYS.includes(key)));
}

describe("role and lane sections", () => {
	for (const lane of ["redteam", "ctf", "src"] satisfies SecAgentLane[]) {
		it(`renders each role's sections in child requests of a ${lane} campaign`, async () => {
			const log: Record<string, string>[] = [];
			const { agent, faux } = await openRoleAgent(`role-sections-${lane}`, undefined, lane);
			const responses: FauxResponseStep[] = [];
			for (const role of SEC_AGENT_ROLES) {
				responses.push(
					observe(
						log,
						fauxAssistantMessage([fauxToolCall("task", { intent: `${role} job`, role }, { id: `s-${role}` })], {
							stopReason: "toolUse",
						}),
					),
					observe(log, fauxAssistantMessage(`${role} answer`)),
				);
			}
			responses.push(observe(log, fauxAssistantMessage("parent done")));
			faux.setResponses(responses);

			const submission = await agent.root.submit({ type: "input", content: "delegate all" }, context);
			expect((await submission.wait(context)).status).toBe("done");

			// The root keeps the host lane's map; only children carry a role section.
			expect(own(log[0]!)).toEqual(wrapped(secLaneSections(lane)));
			const children = log.filter((sections) => sections.role !== undefined);
			expect(children).toHaveLength(SEC_AGENT_ROLES.length);
			for (const role of SEC_AGENT_ROLES) {
				const expected = wrapped(secRoleSections(role, lane));
				const child = children.find((sections) => sections.role === expected.role);
				expect(child).toBeDefined();
				expect(own(child!)).toEqual(expected);
			}

			await agent.close(context);
		}, 30_000);
	}

	it("stores a task's lane override in the child's sections", async () => {
		const log: Record<string, string>[] = [];
		const { agent, faux } = await openRoleAgent("role-section-lane-override");
		faux.setResponses([
			observe(
				log,
				fauxAssistantMessage(
					[fauxToolCall("task", { intent: "ctf binary job", role: "binary", lane: "ctf" }, { id: "o-1" })],
					{ stopReason: "toolUse" },
				),
			),
			observe(log, fauxAssistantMessage("binary answer")),
			observe(log, fauxAssistantMessage("parent done")),
		]);

		const submission = await agent.root.submit({ type: "input", content: "delegate" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		const child = log.find((sections) => sections.role !== undefined);
		const expected = wrapped(secRoleSections("binary", "ctf"));
		expect(child).toBeDefined();
		expect(own(child!)).toEqual(expected);
		expect(child?.lane).toBe(expected.lane);
		expect(child?.lane).not.toBe(log[0]!.lane);
		expect(child?.lane).toContain("hashcat");

		await agent.close(context);
	}, 30_000);
});
