import { fauxAssistantMessage, fauxText, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { openTgSecEvidenceStore } from "../src/evidence/store.ts";
import { createTaskTool, openSecAgent, type TgSecEvidenceRecordInput } from "../src/index.ts";
import { createHttpRequestTool } from "../src/tools/http-tool.ts";
import type { HttpResponse, RequestExecutor } from "../src/tools/transport.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir } from "./support.ts";

const REQUEST = Buffer.from("span-request-body");
const RESPONSE = Buffer.from("span-response-body");

const INPUT: TgSecEvidenceRecordInput = {
	sourceId: "s",
	capturedAt: 1_700_000_000_000,
	url: "http://example.test",
	method: "GET",
	status: 200,
	contentType: "text/plain",
	reqHead: "",
	respHead: "",
};

const openStores: { close: () => Promise<void> }[] = [];

afterEach(async () => {
	while (openStores.length > 0) await openStores.pop()?.close();
	await cleanupTempDirs();
});

async function openEvidence(): Promise<{
	telemetry: InMemoryTelemetryContext;
	store: Awaited<ReturnType<typeof openTgSecEvidenceStore>>;
}> {
	const telemetry = new InMemoryTelemetryContext();
	const dir = await tempDir("tg-sec-spans-");
	const store = await openTgSecEvidenceStore({ dir, telemetry });
	openStores.push(store);
	return { telemetry, store };
}

describe("evidence audit span", () => {
	it("records one tg.span.sec.evidence per operation with the operation and outcome", async () => {
		const { telemetry, store } = await openEvidence();
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		const set = await store.bind("subject-x", null, [{ snapshotId: snap.id }]);
		await store.list("subject-x");
		await store.edit("subject-x", set.version, { bindingId: set.bindings[0].bindingId, note: "touched" });
		await store.readBody(snap.id, "request");
		await store.collect(1_700_000_000_000);

		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.evidence");
		expect(spans.map((span) => span.attributes.op)).toEqual(["record", "bind", "list", "edit", "read", "collect"]);
		for (const span of spans) expect(span.attributes.outcome).toBe("ok");
		expect(spans[1]!.attributes.changed).toBe(true);
		expect(spans[1]!.attributes.count).toBe(1);
		expect(spans[2]!.attributes.changed).toBe(false);
	});

	it("marks subject operations with a bounded digest and leaves the others without one", async () => {
		const { telemetry, store } = await openEvidence();
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		await store.bind("subject-x", null, [{ snapshotId: snap.id }]);
		await store.collect(1_700_000_000_000);
		const byOp = new Map(telemetry.getSpans().map((span) => [span.attributes.op, span]));
		expect(byOp.get("record")!.attributes.subjectDigest).toBeUndefined();
		expect(byOp.get("collect")!.attributes.subjectDigest).toBeUndefined();
		const digest = byOp.get("bind")!.attributes.subjectDigest as string;
		expect(digest).toHaveLength(16);
		expect(digest).not.toBe("subject-x");
	});

	it("classifies a stale-version bind as a conflict and flags the span as an error", async () => {
		const { telemetry, store } = await openEvidence();
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		await store.bind("subject-x", null, [{ snapshotId: snap.id }]);
		await expect(store.bind("subject-x", 999, [{ snapshotId: snap.id }])).rejects.toThrow();
		const conflict = telemetry
			.getSpans()
			.filter((span) => span.name === "tg.span.sec.evidence")
			.at(-1)!;
		expect(conflict.attributes.op).toBe("bind");
		expect(conflict.attributes.outcome).toBe("conflict");
		expect(conflict.status.status).toBe("error");
	});

	it("carries no content hash, snapshot id, or subject text into any attribute", async () => {
		const { telemetry, store } = await openEvidence();
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		await store.bind("subject-x", null, [{ snapshotId: snap.id }]);
		await store.readBody(snap.id, "response");
		for (const span of telemetry.getSpans()) {
			for (const value of Object.values(span.attributes)) {
				expect(String(value)).not.toBe(snap.id);
				expect(String(value)).not.toBe(snap.fields.reqHash);
				expect(String(value)).not.toBe("subject-x");
			}
		}
	});
});

describe("sec tool surface emits no new audit span", () => {
	it("a tool-driven exchange adds only tg.span.sec.evidence, and no previously unseen span name", async () => {
		const dir = await tempDir("tg-sec-toolspan-");
		const telemetry = new InMemoryTelemetryContext();
		const store = await openTgSecEvidenceStore({ dir: await tempDir("tg-sec-toolspan-ev-"), telemetry });
		openStores.push(store);
		const executor: RequestExecutor = {
			async send(): Promise<HttpResponse> {
				return { status: 200, headers: {}, body: Buffer.from("resp"), contentType: "text/plain" };
			},
		};
		const httpTool = createHttpRequestTool({ store, executor });
		const runnerSchema = Type.Object({ url: Type.String(), findingId: Type.String() });
		const runner: ToolRegistration = defineTool({
			name: "run_http",
			description: "Drive the deferred http_request tool once through a nested call.",
			parameters: runnerSchema,
			callers: ["model"],
			async execute(args, api, ctx) {
				await api.executeTool("http_request", { ...args, method: "GET" }, ctx);
				return {};
			},
		});
		const { faux, models } = fauxSetup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("run_http", { url: "http://t.test/a", findingId: "SP-1" }, { id: "r1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const agent = await openSecAgent({
			context,
			project: "spans-tool",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
			extensions: [defineExtension({ name: "sec-tool-test", tools: [httpTool, runner] })],
		});
		const submission = await agent.root.submit({ type: "input", content: "go" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		await agent.close(context);

		// The exchange reached the store: the tool's record and its bind to SP-1 both emitted evidence spans.
		const evidence = telemetry
			.getSpans()
			.filter((span) => span.name === "tg.span.sec.evidence")
			.map((span) => span.attributes.op);
		expect(evidence).toContain("record");
		expect(evidence).toContain("bind");
		// Batch 5-A introduces no new span name: the only sec audit span the tool surface emits is evidence.
		const secSpanNames = new Set(
			telemetry
				.getSpans()
				.filter((span) => span.name.startsWith("tg.span.sec."))
				.map((span) => span.name),
		);
		expect([...secSpanNames]).toEqual(["tg.span.sec.evidence"]);
	}, 30_000);
});

describe("fork audit span", () => {
	it("records one tg.span.sec.fork with the lane and outcome, and never the intent text", async () => {
		const dir = await tempDir("tg-sec-fork-");
		const telemetry = new InMemoryTelemetryContext();
		const { faux, models } = fauxSetup();
		faux.setResponses([
			fauxAssistantMessage(
				[fauxText("delegating"), fauxToolCall("task", { intent: "solve the hidden 42" }, { id: "t1" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("child answer"),
			fauxAssistantMessage("the child reported back"),
		]);
		const taskTool = createTaskTool({
			lane: "redteam",
			policies: {
				redteam: { extensions: ["test-child"], model: fauxModel },
				ctf: { extensions: [] },
				src: { extensions: [] },
			},
			telemetry,
		});
		const agent = await openSecAgent({
			context,
			project: "spans-fork",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
			extensions: [
				defineExtension({ name: "test-child", tools: [] }),
				defineExtension({ name: "sec-test-task", tools: [taskTool] }),
			],
		});

		const submission = await agent.root.submit({ type: "input", content: "delegate" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		await agent.close(context);

		const fork = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.fork");
		expect(fork).toHaveLength(1);
		expect(fork[0]!.attributes.lane).toBe("redteam");
		expect(fork[0]!.attributes.outcome).toBe("done");
		expect(fork[0]!.attributes.depth).toBe(1);
		for (const value of Object.values(fork[0]!.attributes)) {
			expect(String(value)).not.toMatch(/hidden 42/);
		}
	}, 30_000);
});
