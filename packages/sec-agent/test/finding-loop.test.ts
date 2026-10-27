import { fauxAssistantMessage, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { TgSecEvidenceConflictError, TgSecEvidenceNotFoundError } from "../src/evidence/errors.ts";
import { openTgSecEvidenceStore, type TgSecEvidenceStore } from "../src/evidence/store.ts";
import type { TgSecFindingSeverity } from "../src/finding-vocabulary.ts";
import { openSecAgent, type SecAgent } from "../src/index.ts";
import { renderSecReport, reportKey, TgSecReportDoc, type TgSecReportFinding } from "../src/report.ts";
import { createSecToolsExtension } from "../src/tools/extension.ts";
import type { HttpRequest, HttpResponse, RequestExecutor } from "../src/tools/transport.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

const NOW = 1000;
const REPORT_NOW = 5000;

const INPUT = {
	sourceId: "finding-loop",
	capturedAt: 900,
	url: "http://target.test/probe",
	method: "GET",
	status: 200,
	contentType: "text/plain",
	reqHead: "",
	respHead: "",
};

const noopExecutor: RequestExecutor = {
	async send(request: HttpRequest): Promise<HttpResponse> {
		return { status: 204, headers: {}, body: Buffer.alloc(0), contentType: request.method };
	},
};

type ProbeResult = {
	readonly isError: boolean;
	readonly structuredOutput?: Record<string, unknown>;
	readonly diagnostics?: readonly unknown[];
};

/** A host tool that reaches a deferred sec tool by name, like an orchestration program would. */
function probeTool(sink: ProbeResult[]): ToolRegistration {
	return defineTool({
		name: "sec_probe",
		description: "Test host: call one deferred sec tool and record its result.",
		parameters: Type.Object({ name: Type.String(), json: Type.String() }),
		callers: ["model"],
		async execute(args, api, ctx) {
			const nested = await api.executeTool(args.name, JSON.parse(args.json), ctx);
			sink.push({
				isError: nested.isError === true,
				structuredOutput: nested.structuredOutput as Record<string, unknown> | undefined,
				...(nested.diagnostics === undefined ? {} : { diagnostics: nested.diagnostics }),
			});
			api.output(`sec_probe ${args.name}: ${nested.isError === true ? "error" : "ok"}`);
			return {};
		},
	});
}

type Campaign = {
	readonly store: TgSecEvidenceStore;
	readonly telemetry: InMemoryTelemetryContext;
	readonly faux: ReturnType<typeof fauxSetup>["faux"];
	readonly agent: SecAgent;
	readonly sink: ProbeResult[];
};

async function openCampaign(): Promise<Campaign> {
	const dir = await tempDir("tg-sec-finding-");
	const evidenceDir = await tempDir("tg-sec-finding-ev-");
	const telemetry = new InMemoryTelemetryContext();
	const store = await openTgSecEvidenceStore({ dir: evidenceDir, telemetry, now: () => NOW });
	trackStore(store);
	const { faux, models } = fauxSetup();
	const sink: ProbeResult[] = [];
	const agent = await openSecAgent({
		context,
		project: "finding-loop",
		lane: "redteam",
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		extensions: [
			createSecToolsExtension({
				store,
				executor: noopExecutor,
				lane: "redteam",
				project: "finding-loop",
				target: "https://target.test",
				now: () => REPORT_NOW,
			}),
			defineExtension({ name: "probe", tools: [probeTool(sink)] }),
		],
	});
	return { store, telemetry, faux, agent, sink };
}

function call(name: string, args: Record<string, unknown>, id: string) {
	return fauxToolCall("sec_probe", { name, json: JSON.stringify(args) }, { id });
}

async function record(store: TgSecEvidenceStore, label: string) {
	return store.record(Buffer.from(`GET /${label}`), Buffer.from(`body-${label}`), {
		...INPUT,
		url: `${INPUT.url}/${label}`,
	});
}

async function submit(agent: SecAgent, text: string): Promise<string> {
	const submission = await agent.root.submit({ type: "input", content: text }, context);
	return (await submission.wait(context)).status;
}

describe("finding lifecycle", () => {
	it("persists open -> verified -> retest-pass and audits every finding write", async () => {
		const { store, telemetry, faux, agent, sink } = await openCampaign();
		const first = await record(store, "first");
		const second = await record(store, "second");
		await store.bind("F-1", null, [
			{ snapshotId: first.id, role: "proof" },
			{ snapshotId: second.id, role: "verification" },
		]);

		faux.setResponses([
			fauxAssistantMessage(
				[
					call(
						"finding_update",
						{ findingId: "F-1", lane: "redteam", title: "SQL injection", severity: "high" },
						"f1",
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([call("finding_update", { findingId: "F-1", status: "verified" }, "f2")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([call("finding_update", { findingId: "F-1", status: "retest-pass" }, "f3")], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[call("finding_update", { findingId: "F-1", status: "retest-pass", snapshotId: second.id }, "f4")],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([call("report_generate", {}, "r1")], { stopReason: "toolUse" }),
			fauxAssistantMessage([call("report_generate", { reportId: "report" }, "r2")], { stopReason: "toolUse" }),
			fauxAssistantMessage("finding loop complete"),
		]);

		expect(await submit(agent, "work the finding loop")).toBe("done");
		expect(sink.map((result) => result.isError)).toEqual([false, false, true, false, false, false]);

		const finding = await store.getFinding("F-1");
		expect(finding).toMatchObject({
			findingId: "F-1",
			lane: "redteam",
			title: "SQL injection",
			severity: "high",
			status: "retest-pass",
			subjectId: "F-1",
			retestSnapshotId: second.id,
			createdAt: NOW,
			updatedAt: NOW,
		});

		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.evidence");
		const edits = spans.filter((span) => span.attributes.op === "edit");
		expect(edits.map((span) => span.attributes.outcome)).toEqual(["ok", "ok", "ok"]);
		for (const span of edits) {
			expect(span.attributes.changed).toBe(true);
			expect(typeof span.attributes.subjectDigest).toBe("string");
		}
		for (const span of spans) {
			for (const value of Object.values(span.attributes)) {
				expect(String(value)).not.toBe("SQL injection");
				expect(String(value)).not.toBe(first.id);
				expect(String(value)).not.toBe(second.id);
			}
		}

		const reports = sink.filter((result) => result.structuredOutput?.body !== undefined);
		expect(reports).toHaveLength(2);
		const bodies = reports.map((result) => String(result.structuredOutput?.body));
		expect(bodies[0]).toBe(bodies[1]);
		expect(bodies[0]).toContain("## [高] SQL injection");
		expect(bodies[0]).toContain(`- snapshots: ${first.id}, ${second.id}`);
		expect(bodies[0]).not.toContain("body-first");
		expect(reports.map((result) => result.structuredOutput?.revision)).toEqual([1, 2]);

		const stored = await agent.harness.snapshot(TgSecReportDoc, reportKey("report"), context);
		expect(stored).toMatchObject({
			reportId: "report",
			revision: 2,
			generatedAt: REPORT_NOW,
			findingCount: 1,
			digest: reports[1]?.structuredOutput?.digest,
			body: bodies[1],
		});
		await agent.close(context);
	}, 30_000);

	it("rejects retests without fresh bound evidence and severities outside the rubric", async () => {
		const { store, agent } = await openCampaign();
		const first = await record(store, "first");
		const second = await record(store, "second");
		await store.bind("F-1", null, [{ snapshotId: first.id, role: "proof" }]);
		await store.writeFinding({ findingId: "F-1", lane: "redteam", title: "SSRF", severity: "medium" });
		await store.writeFinding({ findingId: "F-1", status: "verified" });

		await expect(store.writeFinding({ findingId: "F-1", status: "retest-pass" })).rejects.toThrow(/new evidence/);
		await expect(
			store.writeFinding({ findingId: "F-1", status: "retest-pass", snapshotId: "0".repeat(64) }),
		).rejects.toBeInstanceOf(TgSecEvidenceNotFoundError);

		await store.bind("F-1", null, [{ snapshotId: second.id, role: "verification" }]);
		const passed = await store.writeFinding({
			findingId: "F-1",
			status: "retest-pass",
			snapshotId: second.id,
		});
		expect(passed.finding.retestSnapshotId).toBe(second.id);
		await expect(
			store.writeFinding({ findingId: "F-1", status: "retest-pass", snapshotId: second.id }),
		).rejects.toBeInstanceOf(TgSecEvidenceConflictError);

		// Deliberately outside the rubric: the write side must refuse what the prompt cannot name.
		await expect(
			store.writeFinding({
				findingId: "F-2",
				lane: "redteam",
				title: "unrated",
				severity: "info" as unknown as TgSecFindingSeverity,
			}),
		).rejects.toThrow(/severity/);
		expect(await store.getFinding("F-2")).toBeUndefined();
		await agent.close(context);
	}, 30_000);
});

describe("report rendering", () => {
	it("renders the same bytes regardless of input order", () => {
		const findings: TgSecReportFinding[] = [
			{
				findingId: "F-low",
				lane: "src",
				title: "banner leak",
				severity: "low",
				status: "open",
				evidenceVersion: 1,
				snapshots: ["snap-b"],
			},
			{
				findingId: "F-critical",
				lane: "redteam",
				title: "auth bypass",
				severity: "critical",
				status: "verified",
				evidenceVersion: 4,
				snapshots: ["snap-a", "snap-c"],
			},
		];
		const forward = renderSecReport({ project: "demo", target: "https://demo.local", findings });
		const reversed = renderSecReport({
			project: "demo",
			target: "https://demo.local",
			findings: [...findings].reverse(),
		});
		expect(reversed.body).toBe(forward.body);
		expect(reversed.digest).toBe(forward.digest);
		expect(forward.body.indexOf("## [严重] auth bypass")).toBeLessThan(forward.body.indexOf("## [低] banner leak"));
		expect(forward.body).toContain("- snapshots: snap-a, snap-c");
	});
});
