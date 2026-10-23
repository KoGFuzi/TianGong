import { fauxAssistantMessage, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { openTgSecEvidenceStore } from "../src/evidence/store.ts";
import { openSecAgent } from "../src/index.ts";
import { createHttpRequestTool } from "../src/tools/http-tool.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir } from "./support.ts";

afterEach(cleanupTempDirs);

/** A faux transport: it never touches the wire, and every test sees the exact bytes it hands back. */
const fauxExecutor = {
	async send() {
		return {
			status: 200,
			headers: { "content-type": "text/plain", server: "faux" },
			body: Buffer.from("the secret response body", "utf8"),
			contentType: "text/plain",
		};
	},
};

/**
 * A test host tool that reaches the deferred `http_request` through a nested `executeTool` call — the
 * sanctioned path for a deferred tool (the guard's scope check is exercised end-to-end in the scope test).
 * It echoes only the nested structured output, so nothing but the summary reaches the transcript.
 */
const runnerSchema = Type.Object({
	url: Type.String(),
	body: Type.Optional(Type.String()),
	findingId: Type.Optional(Type.String()),
});

function createRunnerTool(): ToolRegistration<typeof runnerSchema> {
	return defineTool({
		name: "run_http",
		description: "Test host: invoke the deferred http_request tool once and echo its structured output.",
		parameters: runnerSchema,
		callers: ["model"],
		async execute(args, api, ctx) {
			const nested = await api.executeTool("http_request", { ...args }, ctx);
			api.output(JSON.stringify(nested.structuredOutput ?? { error: true }));
			return {};
		},
	});
}

async function openAgentWithHttpTool(dir: string, evidenceDir: string) {
	const store = await openTgSecEvidenceStore({ dir: evidenceDir });
	const httpTool = createHttpRequestTool({ store, executor: fauxExecutor });
	const { faux, models } = fauxSetup();
	const call = fauxToolCall(
		"run_http",
		{ url: "http://target.test/x", body: "req body", findingId: "F-1" },
		{ id: "h1" },
	);
	faux.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	const agent = await openSecAgent({
		context,
		project: "sec-http",
		lane: "redteam",
		models,
		model: fauxModel,
		cwd: dir,
		path: join(dir, "session.sqlite"),
		extensions: [defineExtension({ name: "test-http", tools: [httpTool, createRunnerTool()] })],
	});
	return { store, agent };
}

describe("http_request tool", () => {
	it("captures the exchange as two blobs, binds it to the finding, and keeps the body out of the transcript", async () => {
		const dir = await tempDir("tg-sec-http-");
		const evidenceDir = await tempDir("tg-sec-http-ev-");
		const { store, agent } = await openAgentWithHttpTool(dir, evidenceDir);

		const submission = await agent.root.submit({ type: "input", content: "go" }, context);
		const settled = await submission.wait(context);
		expect(settled.status).toBe("done");

		// The exchange landed in the evidence store: bound to F-1 at version 1, one snapshot.
		const set = await store.list("F-1");
		expect(set.version).toBe(1);
		expect(set.bindings).toHaveLength(1);
		expect(set.bindings[0]!.role).toBe("supporting");

		// Both bodies are retrievable by their snapshot id (request and response are separate blobs).
		const snapshotId = set.bindings[0]!.snapshotId;
		const requestBody = await store.readBody(snapshotId, "request");
		const responseBody = await store.readBody(snapshotId, "response");
		expect(requestBody.toString("utf8")).toBe("req body");
		expect(responseBody.toString("utf8")).toBe("the secret response body");

		// The transcript carries the summary snapshot id, never the response body.
		const page = await agent.root.entries({}, 200, undefined, context);
		const serialized = JSON.stringify(page.items.map((entry) => entry.model));
		expect(serialized).toContain(snapshotId);
		expect(serialized).not.toContain("the secret response body");

		await agent.close(context);
	}, 30_000);
});
