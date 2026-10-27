import { defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { Type } from "typebox";
import type { TgSecEvidenceRole, TgSecEvidenceStore } from "../evidence/store.ts";
import { recordConversationFinding } from "../task-findings.ts";
import type { RequestExecutor } from "./transport.ts";

/**
 * The `http_request` tool's host-side seams. The evidence store and the request executor are injected, so
 * a test drives the whole capture without an egress path, and the tool never reaches for a global `fetch`.
 */
export type HttpRequestToolOptions = {
	/** The campaign's evidence store; every captured exchange lands here as two content-addressed blobs. */
	readonly store: TgSecEvidenceStore;
	/** The transport seam. Production hands in `nodeRequestExecutor`; tests hand in a faux. */
	readonly executor: RequestExecutor;
	/** The `sourceId` stamped on each snapshot; defaults to `"http_request"`. */
	readonly sourceId?: string;
	readonly now?: () => number;
};

const ROLE_VALUES = ["baseline", "proof", "verification", "supporting"] as const satisfies readonly TgSecEvidenceRole[];

const httpSchema = Type.Object({
	url: Type.String({
		description:
			"Absolute target URL. Its host is checked against the campaign scope by the guard before the request is ever sent; an out-of-scope host is forced to ask or denied.",
	}),
	method: Type.Optional(Type.String({ description: "HTTP method; defaults to GET" })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers" })),
	body: Type.Optional(Type.String({ description: "Request body, sent verbatim; empty for none" })),
	findingId: Type.Optional(
		Type.String({
			description:
				"Evidence subject (a finding id) to bind the captured exchange to; omit to capture without a binding",
		}),
	),
	role: Type.Optional(
		Type.Union(
			ROLE_VALUES.map((value) => Type.Literal(value)),
			{ description: "Binding role when findingId is set; defaults to supporting" },
		),
	),
	note: Type.Optional(Type.String({ description: "Note attached to the binding when findingId is set" })),
});

const httpStructuredOutputSchema = Type.Object({
	snapshotId: Type.String({ description: "The evidence snapshot id the exchange was stored under" }),
	method: Type.String(),
	url: Type.String(),
	status: Type.Number(),
	requestBytes: Type.Number(),
	responseBytes: Type.Number(),
	findingId: Type.Optional(Type.String()),
	evidenceVersion: Type.Optional(Type.Number({ description: "The subject's evidence_version after the bind" })),
});

function formatRequestHead(method: string, url: string, headers: Readonly<Record<string, string>>): string {
	const lines = [`${method} ${url} HTTP/1.1`];
	for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
	return lines.join("\n");
}

function formatResponseHead(status: number, headers: Readonly<Record<string, string>>): string {
	const lines = [`HTTP/1.1 ${status}`];
	for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
	return lines.join("\n");
}

/**
 * Issue one HTTP request and capture the exchange as forensic evidence. The request body and the response
 * body become two independent content-addressed blobs, with a snapshot of their metadata in the evidence
 * index; when a `findingId` is supplied the snapshot is also bound to that subject. **Only a bounded summary
 * reaches the transcript — never the response body** — so a captured exchange stays in the evidence store,
 * retrievable by `traffic_query`, not smeared across the conversation.
 *
 * Deferred by default: the model reaches it through `tool_search`, and the scope guard is what actually
 * authorizes the target, not this tool.
 */
export function createHttpRequestTool(options: HttpRequestToolOptions): ToolRegistration<typeof httpSchema> {
	const now = options.now ?? (() => Date.now());
	const sourceId = options.sourceId ?? "http_request";
	return defineTool({
		name: "http_request",
		description:
			"Send one HTTP request and store the exchange as evidence (two content-addressed blobs plus metadata). Optionally binds the capture to a finding id. The target host is scope-checked before the request runs; the response body is never returned to the transcript, only a summary and the snapshot id.",
		parameters: httpSchema,
		structuredOutputSchema: httpStructuredOutputSchema,
		callers: ["model", "tools"],
		deferred: true,
		replay: "unsafe",
		async execute(args, api, context) {
			const method = (args.method ?? "GET").toUpperCase();
			const body = args.body ?? "";
			const headers = args.headers ?? {};
			const requestBytes = Buffer.from(body, "utf8");
			const response = await options.executor.send({ method, url: args.url, headers, body });
			const snapshot = await options.store.record(requestBytes, response.body, {
				sourceId,
				capturedAt: now(),
				url: args.url,
				method,
				status: response.status,
				contentType: response.contentType,
				reqHead: formatRequestHead(method, args.url, headers),
				respHead: formatResponseHead(response.status, response.headers),
			});
			const rawFinding = args.findingId?.trim() ?? "";
			const findingId = rawFinding === "" ? undefined : rawFinding;
			let evidenceVersion: number | undefined;
			if (findingId !== undefined) {
				const set = await options.store.bind(findingId, null, [
					{
						snapshotId: snapshot.id,
						...(args.role === undefined ? {} : { role: args.role }),
						...(args.note === undefined ? {} : { note: args.note }),
					},
				]);
				evidenceVersion = set.version;
				await recordConversationFinding(api, findingId, context);
			}
			const summary =
				`${method} ${args.url} -> ${response.status}; ${requestBytes.length}B sent, ${response.body.length}B received; snapshot ${snapshot.id}` +
				(evidenceVersion === undefined ? "" : ` (bound to ${findingId} at version ${evidenceVersion})`);
			api.output(summary);
			const structuredOutput = {
				snapshotId: snapshot.id,
				method,
				url: args.url,
				status: response.status,
				requestBytes: requestBytes.length,
				responseBytes: response.body.length,
				...(findingId === undefined ? {} : { findingId }),
				...(evidenceVersion === undefined ? {} : { evidenceVersion }),
			};
			return { structuredOutput };
		},
	});
}
