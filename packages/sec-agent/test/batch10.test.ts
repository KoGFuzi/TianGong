import { fauxAssistantMessage, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { openTgSecEvidenceStore, type TgSecEvidenceStore } from "../src/evidence/store.ts";
import {
	createTaskTool,
	listPlan,
	listTerminals,
	openSecAgent,
	planKey,
	readConversationFindings,
	type SecAgent,
	type SecAgentLane,
	TgSecPlanDoc,
	TgSecPlanHeadDoc,
} from "../src/index.ts";
import { createSecToolsExtension } from "../src/tools/extension.ts";
import type { HttpRequest, HttpResponse, RequestExecutor } from "../src/tools/transport.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

const NOW = 1000;

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

function captureTool(): ToolRegistration {
	return defineTool({
		name: "child_capture",
		description: "Test host: capture evidence under a finding id through the deferred sec tool.",
		parameters: Type.Object({ findingId: Type.String() }),
		callers: ["model"],
		async execute(args, api, ctx) {
			const nested = await api.executeTool(
				"evidence_capture",
				{
					requestBase64: Buffer.from(`GET /${args.findingId}`).toString("base64"),
					responseBase64: Buffer.from("probe-body").toString("base64"),
					findingId: args.findingId,
					role: "proof",
				},
				ctx,
			);
			api.output(`child_capture ${args.findingId}: ${nested.isError === true ? "error" : "ok"}`);
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

async function openCampaign(
	lane: SecAgentLane = "redteam",
	options: { readonly withTask?: boolean; readonly verifyFlag?: (flag: string) => Promise<boolean> } = {},
): Promise<Campaign> {
	const dir = await tempDir("tg-sec-batch10-");
	const store = await openTgSecEvidenceStore({ dir: await tempDir("tg-sec-batch10-ev-"), now: () => NOW });
	trackStore(store);
	const { faux, models } = fauxSetup();
	const sink: ProbeResult[] = [];
	const extensions = [
		createSecToolsExtension({
			store,
			executor: noopExecutor,
			lane,
			...(options.verifyFlag === undefined ? {} : { verifyFlag: options.verifyFlag }),
			now: () => NOW,
		}),
		defineExtension({
			name: "test-child",
			tools: options.withTask === true ? [captureTool(), probeTool(sink)] : [probeTool(sink)],
		}),
	];
	if (options.withTask === true) {
		extensions.push(
			defineExtension({
				name: "sec-task",
				tools: [
					createTaskTool({
						lane,
						policies: {
							redteam: {
								extensions: ["test-child", "sec-tools"],
								tools: ["child_capture", "evidence_capture"],
								model: fauxModel,
							},
							binary: { extensions: [] },
							reporting: { extensions: [] },
						},
						now: () => NOW,
					}),
				],
			}),
		);
	}
	const agent = await openSecAgent({
		context,
		project: `batch10-${lane}`,
		lane,
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		now: () => NOW,
		extensions,
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

describe("plan revisions", () => {
	it("appends immutable revisions that stay enumerable and replayable", async () => {
		const { faux, agent, sink } = await openCampaign();
		faux.setResponses([
			fauxAssistantMessage(
				[
					call(
						"plan_update",
						{
							rationale: "recon first",
							steps: [
								{ stepId: "recon", title: "Enumerate the target", status: "active" },
								{ title: "Prove the injection" },
							],
						},
						"p1",
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					call(
						"plan_update",
						{
							rationale: "recon done",
							steps: [
								{ stepId: "recon", title: "Enumerate the target", status: "done" },
								{ stepId: "exploit", title: "Prove the injection", status: "active" },
							],
						},
						"p2",
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("plan recorded"),
		]);
		expect(await run(agent, "plan the campaign")).toBe("done");
		expect(sink.map((result) => result.isError)).toEqual([false, false]);
		expect(sink.map((result) => result.structuredOutput?.revision)).toEqual([1, 2]);

		const revisions = await listPlan(agent.storage, context);
		expect(revisions).toHaveLength(2);
		expect(revisions[0]).toMatchObject({
			revision: 1,
			rationale: "recon first",
			createdAt: NOW,
			steps: [
				{ stepId: "recon", title: "Enumerate the target", status: "active" },
				{ stepId: "step-2", title: "Prove the injection", status: "open" },
			],
		});
		expect(revisions[1]).toMatchObject({
			revision: 2,
			rationale: "recon done",
			steps: [
				{ stepId: "recon", title: "Enumerate the target", status: "done" },
				{ stepId: "exploit", title: "Prove the injection", status: "active" },
			],
		});

		// Replay by key: revision 1 is exactly what the first write persisted, unchanged by revision 2.
		const first = await agent.harness.snapshot(TgSecPlanDoc, planKey(1), context);
		expect(first).toEqual(revisions[0]);
		expect(await agent.harness.snapshot(TgSecPlanHeadDoc, context)).toEqual({ revision: 2 });
		await agent.close(context);
	}, 30_000);
});

describe("task findings", () => {
	it("returns the finding ids the child entered and matches the evidence store", async () => {
		const { store, faux, agent, sink } = await openCampaign("redteam", { withTask: true });
		faux.setResponses([
			fauxAssistantMessage([call("task", { intent: "capture the proof" }, "t1")], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("child_capture", { findingId: "F-TASK" }, { id: "c1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("child captured the proof"),
			fauxAssistantMessage("delegation complete"),
		]);
		expect(await run(agent, "delegate the capture")).toBe("done");
		expect(sink[0]?.isError).toBe(false);
		expect(sink[0]?.structuredOutput?.findings).toEqual(["F-TASK"]);

		const childId = Number(sink[0]?.structuredOutput?.conversationId);
		expect(childId).toBeGreaterThan(0);
		const registered = await readConversationFindings(agent.harness, childId, context);
		expect(registered).toEqual(["F-TASK"]);
		const set = await store.list("F-TASK");
		expect(set.bindings).toHaveLength(1);
		expect(set.bindings[0]?.role).toBe("proof");
		await agent.close(context);
	}, 30_000);
});

describe("terminal declarations", () => {
	it("keeps unverified claims unverified and promotes only a verified high finding", async () => {
		const { store, faux, agent, sink } = await openCampaign();
		const snapshot = await store.record(Buffer.from("GET /admin"), Buffer.from("proof"), {
			sourceId: "terminal-test",
			capturedAt: NOW,
			url: "http://target.test/admin",
			method: "GET",
			status: 200,
			contentType: "text/plain",
			reqHead: "",
			respHead: "",
		});
		await store.writeFinding({ findingId: "F-HIGH", lane: "redteam", title: "Admin takeover", severity: "high" });
		await store.writeFinding({ findingId: "F-HIGH", status: "verified" });
		await store.bind("F-HIGH", null, [{ snapshotId: snapshot.id, role: "proof" }]);
		await store.writeFinding({ findingId: "F-LOW", lane: "redteam", title: "Reflected param", severity: "medium" });

		faux.setResponses([
			fauxAssistantMessage([call("terminal_declare", { claim: "getshell", findingId: "F-MISSING" }, "d1")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([call("terminal_declare", { claim: "getshell", findingId: "F-LOW" }, "d2")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([call("terminal_declare", { claim: "getflag", flag: "FLAG{x}" }, "d3")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([call("terminal_declare", { claim: "getshell", findingId: "F-HIGH" }, "d4")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("terminal declared"),
		]);
		expect(await run(agent, "declare the terminal")).toBe("done");
		expect(sink.map((result) => result.isError)).toEqual([false, false, true, false]);
		expect(sink[0]?.structuredOutput?.status).toBe("unverified");
		expect(sink[1]?.structuredOutput?.status).toBe("unverified");
		expect(sink[3]?.structuredOutput?.status).toBe("verified");

		const terminals = await listTerminals(agent.storage, context);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({
			claim: "getshell",
			lane: "redteam",
			status: "verified",
			findingId: "F-HIGH",
			snapshotId: "",
			declaredAt: NOW,
			verifiedAt: NOW,
		});
		// No host verdict, verified or unverified, changed a finding row.
		expect((await store.getFinding("F-HIGH"))?.status).toBe("verified");
		expect((await store.getFinding("F-LOW"))?.status).toBe("open");
		await agent.close(context);
	}, 30_000);

	it("marks every getflag claim unverified when no submission source is configured", async () => {
		const { faux, agent, sink } = await openCampaign("ctf");
		faux.setResponses([
			fauxAssistantMessage([call("terminal_declare", { claim: "getflag", flag: "FLAG{anything}" }, "n1")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("no record"),
		]);
		expect(await run(agent, "declare the flag")).toBe("done");
		expect(sink[0]?.isError).toBe(false);
		expect(sink[0]?.structuredOutput?.status).toBe("unverified");

		const terminals = await listTerminals(agent.storage, context);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({
			claim: "getflag",
			lane: "ctf",
			status: "unverified",
			verifiedAt: 0,
		});
		await agent.close(context);
	}, 30_000);

	it("validates a CTF flag against the host submission source", async () => {
		const { faux, agent, sink } = await openCampaign("ctf", {
			verifyFlag: async (flag) => flag === "FLAG{ok}",
		});
		faux.setResponses([
			fauxAssistantMessage([call("terminal_declare", { claim: "getflag", flag: "FLAG{bad}" }, "g1")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([call("terminal_declare", { claim: "getflag", flag: "FLAG{ok}" }, "g2")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("flag checked"),
		]);
		expect(await run(agent, "declare the flag")).toBe("done");
		expect(sink.map((result) => result.structuredOutput?.status)).toEqual(["unverified", "verified"]);

		const terminals = await listTerminals(agent.storage, context);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({ claim: "getflag", lane: "ctf", status: "verified" });
		expect(JSON.stringify(terminals[0])).not.toContain("FLAG{");
		await agent.close(context);
	}, 30_000);
});
