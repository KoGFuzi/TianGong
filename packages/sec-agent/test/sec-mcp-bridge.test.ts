import type { ToolExecutionApi } from "@OnePanda-TgSec/tg-gibraltar";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTgSecEvidenceStore } from "../src/evidence/store.ts";
import { createSecMcpToolName, openSecMcpBridge, SEC_MCP_FLOW_TOOL, type SecMcpBridge } from "../src/mcp/bridge.ts";
import { loadSecMcpConfig, type SecMcpServerConfig, validateSecMcpServer } from "../src/mcp/config.ts";
import { SEC_AGENT_ROLES, secMcpExtensionName, secRolePolicies, secRolePoliciesWithMcp } from "../src/role-policies.ts";
import { createEvidenceCaptureTool } from "../src/tools/evidence-tools.ts";
import { createTgSecMcpStub, type TgSecMcpStub, type TgSecMcpStubTool } from "./mcp-stub.ts";
import { cleanupTempDirs, context, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

/** The tool API seam `execute` may use; capture enters one finding id into a throwaway document. */
const findingDocs = new Map<string, { conversationId: number; findingIds: string[] }>();
const noApi = {
	conversationId: 1,
	output: () => undefined,
	async commit(run: (tx: unknown) => Promise<unknown>): Promise<unknown> {
		return run({
			async doc(_token: unknown, key: string, seed: { conversationId: number; findingIds: string[] }) {
				let value = findingDocs.get(key);
				if (value === undefined) {
					value = { conversationId: seed.conversationId, findingIds: [...seed.findingIds] };
					findingDocs.set(key, value);
				}
				return value;
			},
		});
	},
} as unknown as ToolExecutionApi;

const stdio = (name: string, extra: Partial<SecMcpServerConfig> = {}): SecMcpServerConfig => ({
	name,
	command: `${name}-mcp`,
	...extra,
});

function toolsOf(bridge: SecMcpBridge, role: "redteam" | "binary" | "reporting"): readonly string[] {
	const extension = bridge.extensions.find((entry) => entry.name === secMcpExtensionName(role));
	return (extension?.tools ?? []).map((tool) => tool.name);
}

describe("MCP tool bridge", () => {
	it("registers each advertised tool as a deferred mcp__ registration and keeps calls on the vendored client", async () => {
		const stub = await createTgSecMcpStub([
			{
				name: "nmap_scan",
				description: "Scan a domain",
				inputSchema: { type: "object", properties: { domain: { type: "string" } } },
			},
			{ name: "query_http_flow" },
		]);
		const bridge = await openSecMcpBridge({
			servers: [stdio("yak")],
			clientFactory: async () => stub.client,
		});
		try {
			expect(bridge.declaredTools).toEqual(["mcp__yak__nmap_scan", "mcp__yak__query_http_flow"]);
			expect(bridge.errors).toEqual([]);
			const scan = bridge.extensions
				.flatMap((extension) => extension.tools ?? [])
				.find((tool) => tool.name === "mcp__yak__nmap_scan");
			expect(scan).toBeDefined();
			// Deferred is what keeps an MCP tool out of the model's view until tool_search names it.
			expect(scan?.deferred).toBe(true);
			expect(scan?.callers).toEqual(["model", "tools"]);

			const result = await scan!.execute({ domain: "target.example" }, noApi, context);
			expect(result.isError).toBeUndefined();
			expect(result.structuredOutput).toMatchObject({ content: [{ type: "text", text: "nmap_scan ok" }] });
			expect(stub.callsOf("nmap_scan")).toEqual([{ domain: "target.example" }]);
		} finally {
			await bridge.close();
			await stub.close();
		}
	});

	it("splits the registration surface by role and server tool patterns, and composes the policies", async () => {
		const toolsByServer: Record<string, readonly TgSecMcpStubTool[]> = {
			yak: [{ name: "nmap_scan" }, { name: "admin_shell" }, { name: "query_http_flow" }],
			ida: [{ name: "ida_analyze" }],
			"yak-readonly": [{ name: "query_risk" }, { name: "delete_flow" }],
		};
		const stubs = new Map<string, TgSecMcpStub>();
		const bridge = await openSecMcpBridge({
			servers: [
				stdio("yak", { roles: ["redteam"], tools: ["nmap_*", "admin_*"] }),
				stdio("ida", { roles: ["binary"] }),
				stdio("yak-readonly", { roles: ["reporting"], tools: ["query_*"] }),
			],
			clientFactory: async (server) => {
				const stub = await createTgSecMcpStub(toolsByServer[server.name] ?? []);
				stubs.set(server.name, stub);
				return stub.client;
			},
		});
		try {
			expect(toolsOf(bridge, "redteam")).toEqual(["mcp__yak__nmap_scan", "mcp__yak__admin_shell"]);
			expect(toolsOf(bridge, "binary")).toEqual(["mcp__ida__ida_analyze"]);
			expect(toolsOf(bridge, "reporting")).toEqual(["mcp__yak_readonly__query_risk"]);
			// The three role surfaces are mutually exclusive: no tool a role should not see is registered for it.
			const perRole = SEC_AGENT_ROLES.map((role) => toolsOf(bridge, role));
			for (let left = 0; left < perRole.length; left += 1) {
				for (let right = left + 1; right < perRole.length; right += 1) {
					const shared = perRole[left]!.filter((name) => perRole[right]!.includes(name));
					expect(shared).toEqual([]);
				}
			}
			expect(bridge.declaredTools).toEqual([
				"mcp__ida__ida_analyze",
				"mcp__yak__admin_shell",
				"mcp__yak__nmap_scan",
				"mcp__yak_readonly__query_risk",
			]);

			const policies = secRolePoliciesWithMcp(bridge.toolNamesByRole);
			expect(policies.redteam.extensions).toEqual([
				...secRolePolicies.redteam.extensions,
				secMcpExtensionName("redteam"),
			]);
			expect(policies.redteam.tools ?? []).toContain("mcp__yak__nmap_scan");
			expect(policies.redteam.tools ?? []).not.toContain("mcp__ida__ida_analyze");
			expect(policies.binary.tools ?? []).toContain("mcp__ida__ida_analyze");
			expect(policies.binary.tools ?? []).not.toContain("mcp__yak__nmap_scan");
			expect(policies.reporting.tools ?? []).toContain("mcp__yak_readonly__query_risk");
			expect(policies.reporting.tools ?? []).not.toContain("mcp__yak__admin_shell");
			expect(policies.reporting.extensions).not.toContain("codemode");
		} finally {
			await bridge.close();
			for (const stub of stubs.values()) await stub.close();
		}
	});

	it("resolves a flow id through fetch_http_packet_by_id and hands the packet bytes to evidence capture", async () => {
		const packet = {
			requestBase64: Buffer.from("GET /probe HTTP/1.1").toString("base64"),
			responseBase64: Buffer.from("RESPONSE-BYTES").toString("base64"),
			url: "http://target.example/probe",
			method: "GET",
			status: 200,
			contentType: "text/plain",
		};
		const stub = await createTgSecMcpStub([
			{
				name: SEC_MCP_FLOW_TOOL,
				handler: (args) =>
					args.id === "flow-7"
						? { content: [], structuredContent: packet }
						: { content: [{ type: "text", text: "no such flow" }], isError: true },
			},
		]);
		const bridge = await openSecMcpBridge({ servers: [stdio("yak")], clientFactory: async () => stub.client });
		try {
			expect(bridge.flowFetcher).toBeDefined();
			const flow = await bridge.flowFetcher!("flow-7");
			expect(Buffer.from(flow.request).toString("utf8")).toBe("GET /probe HTTP/1.1");
			expect(Buffer.from(flow.response).toString("utf8")).toBe("RESPONSE-BYTES");
			expect(flow.url).toBe("http://target.example/probe");
			expect(flow.status).toBe(200);
			expect(stub.callsOf(SEC_MCP_FLOW_TOOL)).toEqual([{ id: "flow-7" }]);
			await expect(bridge.flowFetcher!("missing")).rejects.toThrow(/failed for flow missing/);
		} finally {
			await bridge.close();
			await stub.close();
		}
	});

	it("records a flow capture into content-addressed blobs byte for byte and keeps the flow id in metadata", async () => {
		const requestBytes = Buffer.from([0x00, 0xff, 0x10, 0x20, 0x0a]);
		const responseBytes = Buffer.from("HTTP/1.1 200 OK\r\n\r\nbody-with-bytes");
		const stub = await createTgSecMcpStub([
			{
				name: SEC_MCP_FLOW_TOOL,
				handler: () => ({
					content: [],
					structuredContent: {
						requestBase64: requestBytes.toString("base64"),
						responseBase64: responseBytes.toString("base64"),
						url: "https://target.example/api",
						method: "POST",
						status: 201,
					},
				}),
			},
		]);
		const bridge = await openSecMcpBridge({ servers: [stdio("yak")], clientFactory: async () => stub.client });
		const store = await openTgSecEvidenceStore({ dir: await tempDir("tg-sec-mcp-ev-"), now: () => 1 });
		trackStore(store);
		const capture = createEvidenceCaptureTool({
			store,
			now: () => 1000,
			...(bridge.flowFetcher === undefined ? {} : { flowFetcher: bridge.flowFetcher }),
		});
		try {
			const result = await capture.execute({ flowId: "flow-9", findingId: "F-1" }, noApi, context);
			const snapshotId = (result.structuredOutput as { snapshotId: string }).snapshotId;
			const record = await store.getSnapshot(snapshotId);
			expect(record?.fields.flowId).toBe("flow-9");
			expect(record?.fields.url).toBe("https://target.example/api");
			expect(record?.fields.method).toBe("POST");
			expect(record?.fields.status).toBe(201);
			expect(Buffer.compare(await store.readBody(snapshotId, "request"), requestBytes)).toBe(0);
			expect(Buffer.compare(await store.readBody(snapshotId, "response"), responseBytes)).toBe(0);

			// A capture with both forms is ambiguous and refused, and one without a flow source fails
			// closed rather than recording an empty body.
			await expect(
				capture.execute(
					{ flowId: "flow-9", requestBase64: requestBytes.toString("base64"), responseBase64: "" },
					noApi,
					context,
				),
			).rejects.toThrow(/either flowId or requestBase64/);
			const withoutSource = createEvidenceCaptureTool({ store });
			await expect(withoutSource.execute({ flowId: "flow-9" }, noApi, context)).rejects.toThrow(
				/needs a configured MCP flow source/,
			);
		} finally {
			await bridge.close();
			await stub.close();
		}
	});

	it("stops a started long-lived resource exactly once when the bridge closes", async () => {
		const stub = await createTgSecMcpStub([
			{ name: "start_mitm_v2", handler: () => ({ content: [], structuredContent: { port: 18080 } }) },
			{ name: "stop_mitm" },
		]);
		const bridge = await openSecMcpBridge({
			servers: [
				stdio("yak", {
					lifecycle: {
						startTools: ["start_mitm_v2"],
						stopTool: "stop_mitm",
						idField: "port",
						stopArgument: "port",
					},
				}),
			],
			clientFactory: async () => stub.client,
		});
		const start = bridge.extensions
			.flatMap((extension) => extension.tools ?? [])
			.find((tool) => tool.name === "mcp__yak__start_mitm_v2");
		await start!.execute({}, noApi, context);
		await bridge.close();
		// Closing twice must not send a second stop: a duplicate stop on a dead listener is a bug.
		expect(await bridge.close()).toEqual({ stopped: 0, errors: [] });
		expect(stub.callsOf("stop_mitm")).toEqual([{ port: 18080 }]);
		expect(stub.closed).toBe(true);
	});

	it("tells a missing config file apart from a malformed entry and keeps the valid servers", async () => {
		const dir = await tempDir("tg-sec-mcp-config-");
		const missing = await loadSecMcpConfig({ cwd: dir });
		expect(missing).toEqual({ servers: [], errors: [], path: join(dir, ".tiangong", "mcp.json") });

		await mkdir(join(dir, ".tiangong"), { recursive: true });
		await writeFile(
			join(dir, ".tiangong", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					good: { command: "good-mcp", args: ["--stdio"] },
					bad: { command: "bad-mcp", url: "https://also-bad.example" },
					"bad name": { command: "x" },
				},
			}),
		);
		const loaded = await loadSecMcpConfig({ cwd: dir });
		expect(loaded.servers.map((server) => server.name)).toEqual(["good"]);
		expect(loaded.errors).toHaveLength(2);
		expect(loaded.errors.join("\n")).toContain("exactly one of command or url");
		expect(loaded.errors.join("\n")).toContain("invalid server name");

		expect(validateSecMcpServer("x", { command: "x", roles: ["ghost"] })).toContain("roles must be a subset");
	});

	it("sanitizes and caps provider tool names without losing uniqueness", () => {
		expect(createSecMcpToolName("yak", "nmap_scan")).toBe("mcp__yak__nmap_scan");
		expect(createSecMcpToolName("yak-mcp", "scan.target")).toBe("mcp__yak_mcp__scan_target");
		const long = createSecMcpToolName("s".repeat(50), "t".repeat(50));
		expect(long.length).toBeLessThanOrEqual(64);
		expect(long).toMatch(/_[0-9a-f]{8}$/);
		const taken = createSecMcpToolName("yak", "nmap_scan", (name) => name === "mcp__yak__nmap_scan");
		expect(taken).not.toBe("mcp__yak__nmap_scan");
		expect(taken.length).toBeLessThanOrEqual(64);
	});

	it("keeps connecting the remaining servers when one refuses to answer", async () => {
		const healthy = await createTgSecMcpStub([{ name: "query_risk" }]);
		const refused = await createTgSecMcpStub([{ name: "unused" }]);
		refused.fail("tools/list", "registry unavailable");
		const bridge = await openSecMcpBridge({
			servers: [stdio("broken"), stdio("healthy")],
			clientFactory: async (server) => (server.name === "broken" ? refused.client : healthy.client),
		});
		try {
			expect(bridge.declaredTools).toEqual(["mcp__healthy__query_risk"]);
			expect(bridge.errors).toHaveLength(1);
			expect(bridge.errors[0]).toContain("broken: tools/list failed: registry unavailable");
		} finally {
			await bridge.close();
			await healthy.close();
			await refused.close();
		}
	});
});
