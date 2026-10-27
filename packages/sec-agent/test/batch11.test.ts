import { fauxAssistantMessage, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { openTgSecEvidenceStore, type TgSecEvidenceStore } from "../src/evidence/store.ts";
import { openSecAgent, type SecAgent, type SecAgentLane } from "../src/index.ts";
import { createSecToolsExtension } from "../src/tools/extension.ts";
import type { HttpRequest, HttpResponse, RequestExecutor } from "../src/tools/transport.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

const noopExecutor: RequestExecutor = {
	async send(request: HttpRequest): Promise<HttpResponse> {
		return { status: 204, headers: {}, body: Buffer.alloc(0), contentType: request.method };
	},
};

type ProbeResult = {
	readonly isError: boolean;
	readonly structuredOutput?: Record<string, unknown>;
};

function probeTool(sink: ProbeResult[]): ToolRegistration {
	return defineTool({
		name: "sec_probe",
		description: "Test host: call one registered tool by name and record its result.",
		parameters: Type.Object({ name: Type.String(), json: Type.String() }),
		callers: ["model"],
		async execute(args, api, ctx) {
			const nested = await api.executeTool(args.name, JSON.parse(args.json), ctx);
			sink.push({
				isError: nested.isError === true,
				structuredOutput: nested.structuredOutput as Record<string, unknown> | undefined,
			});
			api.output(`sec_probe ${args.name}: ${nested.isError === true ? "error" : "ok"}`);
			return {};
		},
	});
}

type Campaign = {
	readonly store: TgSecEvidenceStore;
	readonly faux: ReturnType<typeof fauxSetup>["faux"];
	readonly agent: SecAgent;
	readonly sink: ProbeResult[];
};

async function openCampaign(lane: SecAgentLane = "redteam"): Promise<Campaign> {
	const dir = await tempDir("tg-sec-batch11-");
	const store = await openTgSecEvidenceStore({ dir: await tempDir("tg-sec-batch11-ev-") });
	trackStore(store);
	const { faux, models } = fauxSetup();
	const sink: ProbeResult[] = [];
	const agent = await openSecAgent({
		context,
		project: `batch11-${lane}`,
		lane,
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		extensions: [
			createSecToolsExtension({ store, executor: noopExecutor, lane }),
			defineExtension({ name: "test-probe", tools: [probeTool(sink)] }),
		],
	});
	return { store, faux, agent, sink };
}

function call(name: string, args: Record<string, unknown>, id: string) {
	return fauxToolCall("sec_probe", { name, json: JSON.stringify(args) }, { id });
}

async function run(agent: SecAgent, text: string): Promise<string> {
	const submission = await agent.root.submit({ type: "input", content: text }, context);
	return (await submission.wait(context)).status;
}

const names = (tools: readonly { readonly name: string }[]): string[] => tools.map((tool) => tool.name);

describe("local_tool_check", () => {
	it("reports the same paths command -v prints, with the version's first line", async () => {
		const { faux, agent, sink } = await openCampaign();
		faux.setResponses([
			fauxAssistantMessage([call("local_tool_check", { tools: ["bash", "definitely-not-installed-xyz"] }, "l-1")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("checked"),
		]);
		expect(await run(agent, "check the local tools")).toBe("done");
		expect(sink.map((result) => result.isError)).toEqual([false]);

		const reported = sink[0]?.structuredOutput?.tools as
			| { name: string; path: string; available: boolean; version: string }[]
			| undefined;
		expect(reported).toHaveLength(2);

		const bashPath = execFileSync("sh", ["-c", 'command -v "$1"', "sh", "bash"], { encoding: "utf8" }).trim();
		const bashVersion = execFileSync("bash", ["--version"], { encoding: "utf8" }).split("\n")[0];
		expect(reported?.[0]).toEqual({
			name: "bash",
			path: bashPath,
			available: true,
			version: bashVersion,
		});
		expect(reported?.[1]).toEqual({
			name: "definitely-not-installed-xyz",
			path: "",
			available: false,
			version: "",
		});

		// Deferred: the model only reaches it after tool_search loads it.
		const resolved = await agent.root.agent(context);
		expect(names(resolved.deferred)).toContain("local_tool_check");
		expect(names(resolved.tools)).not.toContain("local_tool_check");
		await agent.close(context);
	}, 30_000);
});

describe("large command output", () => {
	it("keeps the tail of a hydra-sized line stream at 2000 lines and spills the rest", async () => {
		const { faux, agent, sink } = await openCampaign();
		faux.setResponses([
			fauxAssistantMessage([call("bash", { command: "seq 1 5000" }, "t-1")], { stopReason: "toolUse" }),
			fauxAssistantMessage("counted"),
		]);
		expect(await run(agent, "count the lines")).toBe("done");
		expect(sink[0]?.isError).toBe(false);

		const output = sink[0]?.structuredOutput as
			| { output: string; truncated: boolean; fullOutputPath?: string; exitCode: number }
			| undefined;
		expect(output?.truncated).toBe(true);
		expect(output?.exitCode).toBe(0);
		const lines = (output?.output ?? "").split("\n").filter((line) => line !== "");
		expect(lines.length).toBeLessThanOrEqual(2000);
		expect(lines.at(-1)).toBe("5000");
		expect(output?.fullOutputPath).toBeDefined();
		const full = readFileSync(output!.fullOutputPath!, "utf8");
		expect(full.split("\n").slice(0, 5000)).toHaveLength(5000);
		expect(full.startsWith("1\n")).toBe(true);
		await agent.close(context);
	}, 30_000);

	it("keeps a searchsploit-sized byte stream within the 50KB window and spills the rest", async () => {
		const { faux, agent, sink } = await openCampaign();
		faux.setResponses([
			fauxAssistantMessage(
				[
					call(
						"bash",
						{ command: "yes 0123456789012345678901234567890123456789012345678901234567890 | head -n 1500" },
						"t-2",
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("measured"),
		]);
		expect(await run(agent, "measure the bytes")).toBe("done");
		expect(sink[0]?.isError).toBe(false);

		const output = sink[0]?.structuredOutput as
			| { output: string; truncated: boolean; fullOutputPath?: string; exitCode: number }
			| undefined;
		expect(output?.truncated).toBe(true);
		expect(Buffer.byteLength(output?.output ?? "", "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(output?.output?.trimEnd().endsWith("0")).toBe(true);
		expect(output?.fullOutputPath).toBeDefined();
		expect(readFileSync(output!.fullOutputPath!, "utf8").length).toBeGreaterThan(
			Buffer.byteLength(output?.output ?? ""),
		);
		await agent.close(context);
	}, 30_000);
});
