import type { ToolExecutionApi } from "@OnePanda-TgSec/tg-gibraltar";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSecAgent } from "../src/bootstrap.ts";
import { openSecMcpHost } from "../src/mcp/host.ts";
import { SEC_AGENT_ROLES } from "../src/role-policies.ts";
import { createTgSecMcpStub } from "./mcp-stub.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, unanswered } from "./support.ts";

afterEach(cleanupTempDirs);

const noApi = { output: () => undefined } as unknown as ToolExecutionApi;

const LIFECYCLE_CONFIG = {
	mcpServers: {
		yak: {
			command: "yak-mcp",
			lifecycle: { startTools: ["start_mitm_v2"], stopTool: "stop_mitm", idField: "port", stopArgument: "port" },
		},
		// One malformed entry: reported, and it must not keep the healthy server off the surface.
		broken: { command: "broken-mcp", roles: ["ghost"] },
	},
};

describe("MCP host assembly", () => {
	it("reports a malformed entry, keeps the healthy server, and closes through the campaign seam", async () => {
		const dir = await tempDir("tg-sec-mcp-host-");
		await mkdir(join(dir, ".tiangong"), { recursive: true });
		await writeFile(join(dir, ".tiangong", "mcp.json"), JSON.stringify(LIFECYCLE_CONFIG));

		const stub = await createTgSecMcpStub([
			{ name: "start_mitm_v2", handler: () => ({ content: [], structuredContent: { port: 18080 } }) },
			{ name: "stop_mitm" },
		]);
		const host = await openSecMcpHost({ cwd: dir, clientFactory: async () => stub.client });
		expect(host.errors).toHaveLength(1);
		expect(host.errors[0]).toContain("roles must be a subset");
		expect(host.declaredTools).toEqual(["mcp__yak__start_mitm_v2", "mcp__yak__stop_mitm"]);
		// No roles configured means every role carries the server; the composed policy names each extension.
		expect(host.extensions.map((extension) => extension.name)).toEqual(
			SEC_AGENT_ROLES.map((role) => `sec-mcp-${role}`),
		);
		for (const role of SEC_AGENT_ROLES) {
			expect(host.policies[role].extensions).toContain(`sec-mcp-${role}`);
			expect(host.policies[role].tools ?? []).toContain("mcp__yak__start_mitm_v2");
		}

		const { faux, models } = fauxSetup();
		const agent = await openSecAgent({
			context,
			project: "mcp-host-close",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
			extensions: host.extensions,
			onClose: async () => {
				await host.close();
			},
		});
		const start = host.extensions
			.flatMap((extension) => extension.tools ?? [])
			.find((tool) => tool.name === "mcp__yak__start_mitm_v2");
		await start!.execute({}, noApi, context);
		expect(stub.callsOf("start_mitm_v2")).toEqual([{}]);

		// Abort an in-flight generation, then end the campaign: the listener must still be stopped once.
		const hang = unanswered();
		faux.setResponses([hang.step]);
		await agent.root.submit({ type: "input", content: "hold" }, context);
		await hang.reached;
		await agent.root.abort(context);
		await agent.close(context);

		expect(stub.callsOf("stop_mitm")).toEqual([{ port: 18080 }]);
		expect(stub.closed).toBe(true);
		// The host close seam is idempotent: a second close neither stops again nor errors.
		expect(await host.close()).toEqual([]);
		expect(stub.callsOf("stop_mitm")).toHaveLength(1);
	}, 30_000);

	it("treats a missing config file as an empty surface and still closes cleanly", async () => {
		const dir = await tempDir("tg-sec-mcp-host-empty-");
		const host = await openSecMcpHost({ cwd: dir, clientFactory: async () => Promise.reject(new Error("unused")) });
		expect(host.errors).toEqual([]);
		expect(host.extensions).toEqual([]);
		expect(host.declaredTools).toEqual([]);
		expect(host.flowFetcher).toBeUndefined();
		expect(await host.close()).toEqual([]);
	});
});
