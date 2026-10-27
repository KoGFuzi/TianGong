import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@OnePanda-TgSec/tg-ai";
import { createTgSecScopeRegistry } from "@OnePanda-TgSec/tg-sec-guard";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQueueAskChannel } from "../src/ask.ts";
import { openSecAgent, type SecAgent, type SecAgentLane } from "../src/bootstrap.ts";
import { createSecCoreExtension } from "../src/core-extension.ts";
import { openTgSecEvidenceStore } from "../src/evidence/store.ts";
import { buildSecGuard, secAttestForbiddenRead, secDeclaredTools } from "../src/guard-wiring.ts";
import { openSecMcpBridge, SEC_MCP_FLOW_TOOL, type SecMcpBridge } from "../src/mcp/bridge.ts";
import type { SecMcpServerConfig } from "../src/mcp/config.ts";
import { secRolePoliciesWithMcp } from "../src/role-policies.ts";
import { createSecToolsExtension } from "../src/tools/extension.ts";
import type { RequestExecutor } from "../src/tools/transport.ts";
import { createTgSecMcpStub, type TgSecMcpStub, type TgSecMcpStubTool } from "./mcp-stub.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

const offlineExecutor: RequestExecutor = {
	async send() {
		return { status: 200, headers: {}, body: new Uint8Array(), contentType: "text/plain" };
	},
};

const server = (name: string, extra: Partial<SecMcpServerConfig> = {}): SecMcpServerConfig => ({
	name,
	command: `${name}-mcp`,
	...extra,
});

type McpAgent = {
	readonly agent: SecAgent;
	readonly bridge: SecMcpBridge;
	readonly stubs: ReadonlyMap<string, TgSecMcpStub>;
	readonly asked: ReturnType<typeof createQueueAskChannel>["asked"];
	readonly faux: ReturnType<typeof fauxSetup>["faux"];
};

/**
 * A campaign wired exactly like a host: `sec-core` and `sec-tools` installed by name, MCP servers
 * translated by the bridge, and probe 4's declared set derived from the same bridge. The scope
 * registry names only `target.example`, so every other host is out of scope.
 */
async function openMcpAgent(options: {
	readonly project: string;
	readonly tools: Readonly<Record<string, readonly TgSecMcpStubTool[]>>;
	readonly lane?: SecAgentLane;
	readonly reply?: "allow" | "deny";
}): Promise<McpAgent> {
	const dir = await tempDir();
	const { faux, models } = fauxSetup();
	const stubs = new Map<string, TgSecMcpStub>();
	const bridge = await openSecMcpBridge({
		servers: Object.keys(options.tools).map((name) => server(name)),
		clientFactory: async (config) => {
			const stub = await createTgSecMcpStub(options.tools[config.name] ?? []);
			stubs.set(config.name, stub);
			return stub.client;
		},
	});
	const store = await openTgSecEvidenceStore({ dir: await tempDir("tg-sec-mcp-guard-ev-") });
	trackStore(store);
	const lane = options.lane ?? "redteam";
	const agent = await openSecAgent({
		context,
		project: options.project,
		lane,
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		extensions: [createSecToolsExtension({ store, executor: offlineExecutor, lane }), ...bridge.extensions],
	});
	const queue = createQueueAskChannel(options.reply === undefined ? [] : [options.reply]);
	const policies = secRolePoliciesWithMcp(bridge.toolNamesByRole);
	const wiring = await buildSecGuard({
		session: agent.harness,
		lane,
		context,
		mode: "auto",
		scopeRegistry: createTgSecScopeRegistry([
			{ kind: "exact-host", pattern: "target.example", effect: "allow", enabled: true },
		]),
		askChannel: queue.ask,
		attestParts: {
			forbiddenRead: secAttestForbiddenRead(join(dir, "confine")),
			registeredTools: () =>
				agent.registry
					.snapshot()
					.tools()
					.map((entry) => entry.tool.name),
			declaredTools: secDeclaredTools(lane, bridge.declaredTools),
		},
	});
	agent.registry.install(createSecCoreExtension({ lane, wiring, policies }));
	return { agent, bridge, stubs, asked: queue.asked, faux };
}

async function toolResultText(agent: SecAgent): Promise<string> {
	const page = await agent.root.entries({}, 200, undefined, context);
	const texts: string[] = [];
	for (const entry of page.items) {
		for (const message of entry.model ?? []) {
			if (message.role === "toolResult")
				texts.push(message.content.map((block) => (block.type === "text" ? block.text : "")).join(" "));
		}
	}
	return texts.join("\n");
}

/** `tool_search` first: MCP tools are deferred, and the model only sees what it names. */
function searchThenCall(name: string, args: JsonObject, id: string) {
	const query = name.split("__").at(-1)?.replaceAll("_", " ") ?? name;
	return [
		fauxAssistantMessage([fauxToolCall("tool_search", { query }, { id: `${id}-search` })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];
}

describe("MCP tools through the campaign guard", () => {
	it("forces an operator ask for an out-of-scope target named by an MCP domain parameter", async () => {
		const { agent, stubs, asked, faux } = await openMcpAgent({
			project: "mcp-scope-ask",
			tools: { yak: [{ name: "nmap_scan", description: "Scan a domain" }] },
			reply: "deny",
		});
		faux.setResponses(searchThenCall("mcp__yak__nmap_scan", { domain: "outside.example" }, "s-1"));
		const submission = await agent.root.submit({ type: "input", content: "scan it" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		expect(asked).toHaveLength(1);
		expect(asked[0]?.request.toolName).toBe("mcp__yak__nmap_scan");
		expect(asked[0]?.decision.forced).toBe(true);
		expect(asked[0]?.decision.reason).toContain("not in the registered scope");
		// The call never reached the server: a guard denial happens before execution.
		expect(stubs.get("yak")?.callsOf("nmap_scan")).toEqual([]);
		expect(await toolResultText(agent)).toContain("not in the registered scope");
		await agent.close(context);
	}, 30_000);

	it("lets an in-scope MCP target through to the server without asking", async () => {
		const { agent, stubs, asked, faux } = await openMcpAgent({
			project: "mcp-scope-allow",
			tools: { yak: [{ name: "nmap_scan", description: "Scan a domain" }] },
		});
		faux.setResponses(searchThenCall("mcp__yak__nmap_scan", { domain: "target.example" }, "s-2"));
		const submission = await agent.root.submit({ type: "input", content: "scan it" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		expect(asked).toHaveLength(0);
		expect(stubs.get("yak")?.callsOf("nmap_scan")).toEqual([{ domain: "target.example" }]);
		expect(await toolResultText(agent)).toContain("nmap_scan ok");
		await agent.close(context);
	}, 30_000);

	it("scans MCP parameter values with the danger set, even when the target is in scope", async () => {
		const { agent, stubs, asked, faux } = await openMcpAgent({
			project: "mcp-danger",
			tools: { yak: [{ name: "sqlmap_run", description: "Run sqlmap" }] },
			reply: "deny",
		});
		faux.setResponses(
			searchThenCall("mcp__yak__sqlmap_run", { command: "sqlmap --os-shell -u http://target.example/x" }, "d-1"),
		);
		const submission = await agent.root.submit({ type: "input", content: "run it" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		expect(asked).toHaveLength(1);
		expect(asked[0]?.decision.reason).toContain("sqlmap --os-shell");
		expect(stubs.get("yak")?.callsOf("sqlmap_run")).toEqual([]);
		await agent.close(context);
	}, 30_000);

	it("keeps probe 4 green as the host config adds and removes servers", async () => {
		const one = await openMcpAgent({ project: "mcp-probe-one", tools: { yak: [{ name: "nmap_scan" }] } });
		one.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" }, { id: "p-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const oneRun = await one.agent.root.submit({ type: "input", content: "pwd" }, context);
		expect((await oneRun.wait(context)).status).toBe("done");
		expect(one.agent.reports).toEqual([]);
		await one.agent.close(context);

		const two = await openMcpAgent({
			project: "mcp-probe-two",
			tools: { yak: [{ name: "nmap_scan" }], ida: [{ name: "ida_analyze" }] },
		});
		two.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" }, { id: "p-2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const twoRun = await two.agent.root.submit({ type: "input", content: "pwd" }, context);
		expect((await twoRun.wait(context)).status).toBe("done");
		expect(two.agent.reports).toEqual([]);
		await two.agent.close(context);
	}, 30_000);

	it("exposes the flow tool with the same guarded registration as every other MCP tool", async () => {
		const packet = {
			requestBase64: Buffer.from("GET /").toString("base64"),
			responseBase64: Buffer.from("ok").toString("base64"),
		};
		const { bridge } = await openMcpAgent({
			project: "mcp-flow-registration",
			tools: {
				yak: [{ name: SEC_MCP_FLOW_TOOL, handler: () => ({ content: [], structuredContent: packet }) }],
			},
		});
		expect(bridge.declaredTools).toEqual([`mcp__yak__${SEC_MCP_FLOW_TOOL}`]);
		expect(bridge.flowFetcher).toBeDefined();
		const flow = await bridge.flowFetcher!("f-1");
		expect(Buffer.from(flow.response).toString("utf8")).toBe("ok");
	});
});
