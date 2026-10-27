import { defineExtension, defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { openTgSecEvidenceStore } from "../src/evidence/store.ts";
import { openSecAgent, type SecAgent, type SecAgentLane } from "../src/index.ts";
import { secLaneToolFilter } from "../src/sections.ts";
import { createSecToolsExtension } from "../src/tools/extension.ts";
import type { HttpRequest, HttpResponse, RequestExecutor } from "../src/tools/transport.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

const SEC_TOOLS = ["http_request", "evidence_capture", "traffic_query", "finding_update", "report_generate"] as const;

/** A transport that never touches the wire; the lane test opens the agent but runs no turns. */
const noopExecutor: RequestExecutor = {
	async send(request: HttpRequest): Promise<HttpResponse> {
		return { status: 204, headers: {}, body: Buffer.alloc(0), contentType: request.method };
	},
};

/** A non-deferred host tool, so the offered set is observably non-empty next to the hidden sec surface. */
function markerTool(): ToolRegistration {
	return defineTool({
		name: "host_marker",
		description: "A plain offered tool used only to prove the offered set is real.",
		parameters: Type.Object({}),
		callers: ["model"],
		async execute() {
			return {};
		},
	});
}

async function openLaneAgent(lane: SecAgentLane): Promise<SecAgent> {
	const dir = await tempDir("tg-sec-lane-");
	const store = await openTgSecEvidenceStore({ dir: await tempDir("tg-sec-lane-ev-") });
	trackStore(store);
	const { models } = fauxSetup();
	const agent = await openSecAgent({
		context,
		project: `sec-lane-${lane}`,
		lane,
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		extensions: [
			createSecToolsExtension({ store, executor: noopExecutor, lane }),
			defineExtension({ name: "marker", tools: [markerTool()] }),
		],
	});
	return agent;
}

const names = (tools: readonly ToolRegistration[]): string[] => tools.map((tool) => tool.name);

describe("sec lane tool filtering", () => {
	it("each lane surfaces the full forensic tool set in the contract", () => {
		for (const lane of ["redteam", "ctf", "src"] as const) {
			expect(secLaneToolFilter(lane)).toEqual(SEC_TOOLS);
		}
	});

	it("deferred sec tools are enabled and nested-callable but never offered, for every lane", async () => {
		for (const lane of ["redteam", "ctf", "src"] as const) {
			const agent = await openLaneAgent(lane);
			const resolved = await agent.root.agent(context);
			const offered = names(resolved.tools);
			const deferred = names(resolved.deferred);
			const callable = names(resolved.callable);
			expect(offered).toContain("host_marker");
			for (const tool of SEC_TOOLS) {
				expect(offered).not.toContain(tool);
				expect(deferred).toContain(tool);
				expect(callable).toContain(tool);
			}
			await agent.close(context);
		}
	}, 30_000);

	it("loading a deferred sec tool moves it from the deferred set into the offered set", async () => {
		const agent = await openLaneAgent("redteam");
		const before = await agent.root.agent(context);
		const httpTool = before.deferred.find((tool) => tool.name === "http_request");
		expect(httpTool).toBeDefined();

		await agent.root.configure({ modelTools: { add: [httpTool!] } }, context);
		const after = await agent.root.agent(context);
		expect(names(after.tools)).toContain("http_request");
		expect(names(after.deferred)).not.toContain("http_request");
		expect(names(after.deferred)).toContain("traffic_query");
		expect(names(after.deferred)).toContain("evidence_capture");
		await agent.close(context);
	}, 30_000);
});
