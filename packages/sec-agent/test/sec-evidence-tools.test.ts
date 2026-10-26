import type { FauxResponseStep } from "@OnePanda-TgSec/tg-ai";
import { fauxAssistantMessage, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { openTgSecEvidenceStore } from "../src/evidence/store.ts";
import { openSecAgent } from "../src/index.ts";
import { createEvidenceTools } from "../src/tools/evidence-tools.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

const secCallSchema = Type.Object({
	name: Type.String(),
	json: Type.String({ description: "JSON-encoded arguments for the named deferred tool" }),
});

/**
 * A test host that reaches a deferred sec tool through a nested `executeTool` call and echoes a projection
 * of its result. The projection deliberately omits `bodyBase64`, so a captured body never enters the
 * transcript — which is itself one of the properties under test.
 */
function createSecCallTool(): ToolRegistration<typeof secCallSchema> {
	return defineTool({
		name: "sec_call",
		description: "Test host: invoke a deferred sec tool by name and echo a body-free projection of its result.",
		parameters: secCallSchema,
		callers: ["model"],
		async execute(args, api, ctx) {
			const nested = await api.executeTool(args.name, JSON.parse(args.json), ctx);
			const out = (nested.structuredOutput ?? {}) as Record<string, unknown>;
			const parts = [`isError=${nested.isError}`];
			if (out.snapshotId !== undefined) parts.push(`snapshotId=${String(out.snapshotId)}`);
			if (out.version !== undefined) parts.push(`version=${String(out.version)}`);
			if (Array.isArray(out.snapshots)) parts.push(`snapshots=${out.snapshots.length}`);
			if (out.bodyBytes !== undefined) parts.push(`bodyBytes=${String(out.bodyBytes)}`);
			api.output(parts.join(" "));
			return {};
		},
	});
}

async function openEvidenceAgent(dir: string, evidenceDir: string) {
	const store = await openTgSecEvidenceStore({ dir: evidenceDir, now: () => 1000 });
	trackStore(store);
	const tools = createEvidenceTools({ store, now: () => 1000 });
	const { faux, models } = fauxSetup();
	const agent = await openSecAgent({
		context,
		project: "sec-evidence",
		lane: "redteam",
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		extensions: [defineExtension({ name: "test-evidence", tools: [...tools, createSecCallTool()] })],
	});
	return { store, faux, agent };
}

/** base64 for a captured body. */
function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

function call(name: string, args: Record<string, unknown>, id: string) {
	return fauxToolCall("sec_call", { name, json: JSON.stringify(args) }, { id });
}

async function transcriptText(entries: readonly { readonly model?: readonly unknown[] }[]): Promise<string> {
	return JSON.stringify(entries.map((entry) => entry.model));
}

async function submitAndWait(agent: Awaited<ReturnType<typeof openEvidenceAgent>>["agent"], text: string) {
	const submission = await agent.root.submit({ type: "input", content: text }, context);
	return (await submission.wait(context)).status;
}

describe("evidence tools", () => {
	it("captures bytes, binds them to a finding, rejects a stale version, and reads back without leaking bodies", async () => {
		const dir = await tempDir("tg-sec-ev-");
		const evidenceDir = await tempDir("tg-sec-ev-store-");
		const { store, faux, agent } = await openEvidenceAgent(dir, evidenceDir);

		const captures: FauxResponseStep[] = [
			fauxAssistantMessage(
				[
					call(
						"evidence_capture",
						{
							requestBase64: b64("GET /probe"),
							responseBase64: b64("SECRET-ONE"),
							url: "http://target.test/probe",
							method: "GET",
							status: 200,
							findingId: "F-1",
						},
						"c1",
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					call(
						"evidence_capture",
						{ requestBase64: b64("POST /x"), responseBase64: b64("SECRET-TWO"), findingId: "F-1", role: "proof" },
						"c2",
					),
				],
				{ stopReason: "toolUse" },
			),
			// A stale expectedVersion must refuse the bind, leaving the version untouched and this snapshot unbound.
			fauxAssistantMessage(
				[
					call(
						"evidence_capture",
						{ requestBase64: b64("z"), responseBase64: b64("z"), findingId: "F-1", expectedVersion: 99 },
						"c3",
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([call("traffic_query", { findingId: "F-1" }, "q1")], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		];
		faux.setResponses(captures);
		expect(await submitAndWait(agent, "capture and query")).toBe("done");

		// Two captures bound; the stale one conflicted and stayed unbound.
		const set = await store.list("F-1");
		expect(set.version).toBe(2);
		expect(set.bindings).toHaveLength(2);
		expect(set.bindings[1]!.role).toBe("proof");

		// Recorded metadata survived the store round trip.
		const first = await store.getSnapshot(set.bindings[0]!.snapshotId);
		expect(first?.fields.url).toBe("http://target.test/probe");
		expect(first?.fields.method).toBe("GET");
		expect(first?.fields.status).toBe(200);

		// Bodies are content-addressed and retrievable by snapshot id.
		const responseBody = await store.readBody(set.bindings[0]!.snapshotId, "response");
		expect(responseBody.toString("utf8")).toBe("SECRET-ONE");

		const page = await agent.root.entries({}, 500, undefined, context);
		const serialized = await transcriptText(page.items);
		// The list projection reported two snapshots; the stale capture surfaced as an error result.
		expect(serialized).toContain("snapshots=2");
		expect(serialized).toContain("isError=true");
		// The tool never decoded a body into the transcript: the plaintext secret is absent.
		expect(serialized).not.toContain("SECRET-ONE");
		expect(serialized).not.toContain("SECRET-TWO");

		// Now read one body back through the tool, by its real snapshot id.
		const target = set.bindings[0]!.snapshotId;
		faux.setResponses([
			fauxAssistantMessage(
				[call("traffic_query", { findingId: "F-1", snapshotId: target, side: "response" }, "q2")],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		expect(await submitAndWait(agent, "read the body")).toBe("done");
		const after = await agent.root.entries({}, 800, undefined, context);
		const readSerialized = await transcriptText(after.items);
		// The read projection carries the byte count, and still no decoded body text.
		expect(readSerialized).toContain("bodyBytes=10");
		expect(readSerialized).not.toContain("SECRET-ONE");

		await agent.close(context);
	}, 30_000);
});
