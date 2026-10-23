import { defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { Type } from "typebox";
import type { TgSecEvidenceRole, TgSecEvidenceStore } from "../evidence/store.ts";

/** The store one campaign's evidence tools read and write; injected so tests drive a temp store. */
export type EvidenceToolOptions = {
	readonly store: TgSecEvidenceStore;
	/** The `sourceId` stamped on a capture; defaults to `"evidence_capture"`. */
	readonly sourceId?: string;
	readonly now?: () => number;
};

const ROLE_VALUES = ["baseline", "proof", "verification", "supporting"] as const satisfies readonly TgSecEvidenceRole[];

const captureSchema = Type.Object({
	requestBase64: Type.String({ description: "Base64 of the request bytes to freeze as evidence" }),
	responseBase64: Type.String({ description: "Base64 of the response bytes to freeze as evidence" }),
	sourceId: Type.Optional(Type.String({ description: "Origin tag for the snapshot; defaults to evidence_capture" })),
	url: Type.Optional(Type.String({ description: "Descriptive URL or label for the snapshot metadata" })),
	method: Type.Optional(Type.String({ description: "Method or verb recorded on the snapshot" })),
	status: Type.Optional(Type.Number({ description: "Status code recorded on the snapshot; defaults to 0" })),
	contentType: Type.Optional(Type.String({ description: "Content type recorded on the snapshot" })),
	reqHead: Type.Optional(Type.String({ description: "Request head text recorded on the snapshot" })),
	respHead: Type.Optional(Type.String({ description: "Response head text recorded on the snapshot" })),
	findingId: Type.Optional(
		Type.String({ description: "Evidence subject (a finding id) to bind the capture to; omit to record only" }),
	),
	role: Type.Optional(
		Type.Union(
			ROLE_VALUES.map((value) => Type.Literal(value)),
			{ description: "Binding role when findingId is set; defaults to supporting" },
		),
	),
	note: Type.Optional(Type.String({ description: "Note attached to the binding when findingId is set" })),
	expectedVersion: Type.Optional(
		Type.Number({ description: "Optimistic lock: refuse the bind unless the subject is at this version" }),
	),
});

const captureStructuredSchema = Type.Object({
	snapshotId: Type.String(),
	requestBytes: Type.Number(),
	responseBytes: Type.Number(),
	findingId: Type.Optional(Type.String()),
	evidenceVersion: Type.Optional(Type.Number()),
});

const querySchema = Type.Object({
	findingId: Type.String({ description: "The evidence subject whose snapshots to list" }),
	snapshotId: Type.Optional(
		Type.String({ description: "Read one snapshot's body instead of listing; must be bound to findingId" }),
	),
	side: Type.Optional(Type.Union([Type.Literal("request"), Type.Literal("response")])),
});

const queryStructuredSchema = Type.Object({
	findingId: Type.String(),
	version: Type.Number(),
	snapshots: Type.Array(
		Type.Object({
			snapshotId: Type.String(),
			role: Type.String(),
			note: Type.String(),
			url: Type.String(),
			method: Type.String(),
			status: Type.Number(),
			contentType: Type.String(),
			requestBytes: Type.Number(),
			responseBytes: Type.Number(),
		}),
	),
	bodyBase64: Type.Optional(
		Type.String({ description: "Base64 of the requested body, only when snapshotId is given" }),
	),
	bodyBytes: Type.Optional(Type.Number()),
});

/**
 * Freeze bytes the caller already holds into immutable evidence: record the two base64 bodies as
 * content-addressed blobs plus metadata, and optionally bind them to a finding under the store's
 * optimistic lock. This is the `http_request` capture path without the network — a bash pipeline, a
 * file, or a manual PoC output becomes retrievable evidence. **The bodies never reach the transcript**;
 * only the snapshot id and byte counts do.
 */
export function createEvidenceCaptureTool(options: EvidenceToolOptions): ToolRegistration<typeof captureSchema> {
	const now = options.now ?? (() => Date.now());
	const defaultSource = options.sourceId ?? "evidence_capture";
	return defineTool({
		name: "evidence_capture",
		description:
			"Store request and response bytes (base64) as an evidence snapshot, optionally binding it to a finding id. Bodies are content-addressed and never echoed to the transcript; only the snapshot id and byte counts return.",
		parameters: captureSchema,
		structuredOutputSchema: captureStructuredSchema,
		callers: ["model", "tools"],
		deferred: true,
		replay: "unsafe",
		async execute(args, api) {
			const request = Buffer.from(args.requestBase64, "base64");
			const response = Buffer.from(args.responseBase64, "base64");
			const snapshot = await options.store.record(request, response, {
				sourceId: args.sourceId ?? defaultSource,
				capturedAt: now(),
				url: args.url ?? "",
				method: args.method ?? "",
				status: args.status ?? 0,
				contentType: args.contentType ?? "",
				reqHead: args.reqHead ?? "",
				respHead: args.respHead ?? "",
			});
			const rawFinding = args.findingId?.trim() ?? "";
			const findingId = rawFinding === "" ? undefined : rawFinding;
			let evidenceVersion: number | undefined;
			if (findingId !== undefined) {
				const set = await options.store.bind(findingId, args.expectedVersion ?? null, [
					{
						snapshotId: snapshot.id,
						...(args.role === undefined ? {} : { role: args.role }),
						...(args.note === undefined ? {} : { note: args.note }),
					},
				]);
				evidenceVersion = set.version;
			}
			const summary =
				`captured ${request.length}B request + ${response.length}B response; snapshot ${snapshot.id}` +
				(evidenceVersion === undefined ? "" : ` (bound to ${findingId} at version ${evidenceVersion})`);
			api.output(summary);
			const structuredOutput = {
				snapshotId: snapshot.id,
				requestBytes: request.length,
				responseBytes: response.length,
				...(findingId === undefined ? {} : { findingId }),
				...(evidenceVersion === undefined ? {} : { evidenceVersion }),
			};
			return { structuredOutput };
		},
	});
}

/**
 * Read a finding's evidence: list the snapshots bound to it with their captured metadata (url, method,
 * status, byte counts), or fetch one snapshot's body as base64 when `snapshotId` names one. Read-only and
 * replay-safe. A fetched body returns in `structuredOutput` for the calling program, never smeared into the
 * transcript — only a bounded one-line note is output.
 */
export function createTrafficQueryTool(options: EvidenceToolOptions): ToolRegistration<typeof querySchema> {
	return defineTool({
		name: "traffic_query",
		description:
			"List the evidence snapshots bound to a finding with their metadata, or read one snapshot's request/response body as base64. Read-only; a body is returned to the caller in structured output, not the transcript.",
		parameters: querySchema,
		structuredOutputSchema: queryStructuredSchema,
		callers: ["model", "tools"],
		deferred: true,
		replay: "safe",
		outputLimits: { maxBytes: 8192, maxLines: 200 },
		async execute(args, api) {
			const set = await options.store.list(args.findingId);
			const snapshots = [];
			for (const binding of set.bindings) {
				const record = await options.store.getSnapshot(binding.snapshotId);
				if (record === undefined) continue;
				snapshots.push({
					snapshotId: binding.snapshotId,
					role: binding.role,
					note: binding.note,
					url: record.fields.url,
					method: record.fields.method,
					status: record.fields.status,
					contentType: record.fields.contentType,
					requestBytes: record.fields.reqLen,
					responseBytes: record.fields.respLen,
				});
			}
			const lines = snapshots.map(
				(s) =>
					`${s.snapshotId} ${s.method} ${s.url} -> ${s.status} (${s.requestBytes}B/${s.responseBytes}B) [${s.role}]`,
			);
			api.output(lines.length === 0 ? `no evidence bound to ${args.findingId}` : lines.join("\n"));
			let body: Buffer | undefined;
			if (args.snapshotId !== undefined) {
				const side = args.side ?? "response";
				body = await options.store.readBody(args.snapshotId, side);
				api.output(`read ${side} body of ${args.snapshotId}: ${body.length}B`);
			}
			return {
				structuredOutput: {
					findingId: args.findingId,
					version: set.version,
					snapshots,
					...(body === undefined ? {} : { bodyBase64: body.toString("base64"), bodyBytes: body.length }),
				},
			};
		},
	});
}

/** Both evidence-facing tools, sharing one store: the capture path and the read path. */
export function createEvidenceTools(options: EvidenceToolOptions): readonly ToolRegistration[] {
	return [createEvidenceCaptureTool(options), createTrafficQueryTool(options)];
}
