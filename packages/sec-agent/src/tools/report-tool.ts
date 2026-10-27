import { defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { Type } from "typebox";
import type { TgSecEvidenceStore } from "../evidence/store.ts";
import { emptySecReport, renderSecReport, TgSecReportDoc, type TgSecReportFinding } from "../report.ts";

/** The settings a report renders with: facts the campaign host already knows. */
export type ReportToolOptions = {
	readonly store: TgSecEvidenceStore;
	readonly project: string;
	readonly target: string;
	readonly now?: () => number;
};

const reportSchema = Type.Object({
	reportId: Type.Optional(
		Type.String({ description: "Report document id; defaults to report. Regenerating bumps its revision" }),
	),
});

const reportStructuredSchema = Type.Object({
	reportId: Type.String(),
	revision: Type.Number(),
	generatedAt: Type.Number(),
	digest: Type.String(),
	findingCount: Type.Number(),
	bytes: Type.Number(),
	body: Type.String({ description: "The deterministic Markdown report, for the calling program" }),
});

/**
 * Render the registered findings into a deterministic report and persist it as a `tg.sec.report`
 * document. The body lists severities, states and snapshot ids only — no capture bytes, no clock —
 * so the same findings produce the same bytes. The transcript sees the metadata line; the body
 * travels in structured output for the calling program.
 */
export function createReportGenerateTool(options: ReportToolOptions): ToolRegistration<typeof reportSchema> {
	const now = options.now ?? (() => Date.now());
	return defineTool({
		name: "report_generate",
		description:
			"Render every registered finding into a deterministic Markdown report ordered by severity, with each finding's evidence snapshot ids, and store it as a tg.sec.report document. No evidence bodies enter the report; the body returns to the caller in structured output.",
		parameters: reportSchema,
		structuredOutputSchema: reportStructuredSchema,
		callers: ["model", "tools"],
		deferred: true,
		replay: "unsafe",
		async execute(args, api, context) {
			const requested = args.reportId?.trim() ?? "";
			const reportId = requested === "" ? "report" : requested;
			const findings: TgSecReportFinding[] = [];
			for (const finding of await options.store.listFindings()) {
				const set = await options.store.list(finding.subjectId);
				findings.push({
					findingId: finding.findingId,
					lane: finding.lane,
					title: finding.title,
					severity: finding.severity,
					status: finding.status,
					evidenceVersion: set.version,
					snapshots: set.bindings.map((binding) => binding.snapshotId),
				});
			}
			const rendered = renderSecReport({ project: options.project, target: options.target, findings });
			const settled = await api.commit(async (tx) => {
				const doc = await tx.doc(TgSecReportDoc, reportId, emptySecReport(reportId));
				doc.revision += 1;
				doc.generatedAt = now();
				doc.digest = rendered.digest;
				doc.findingCount = rendered.findings.length;
				doc.findings = rendered.findings.map((finding) => ({ ...finding, snapshots: [...finding.snapshots] }));
				doc.body = rendered.body;
				return { revision: doc.revision, generatedAt: doc.generatedAt };
			}, context);
			const bytes = Buffer.byteLength(rendered.body);
			api.output(
				`report ${reportId} revision ${settled.revision}: ${rendered.findings.length} finding(s), ${bytes}B, digest ${rendered.digest.slice(0, 12)}`,
			);
			return {
				structuredOutput: {
					reportId,
					revision: settled.revision,
					generatedAt: settled.generatedAt,
					digest: rendered.digest,
					findingCount: rendered.findings.length,
					bytes,
					body: rendered.body,
				},
			};
		},
	});
}
