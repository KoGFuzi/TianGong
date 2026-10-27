import { defineDocFamily } from "@OnePanda-TgSec/tg-gibraltar";
import { createHash } from "node:crypto";
import {
	isTgSecFindingSeverity,
	isTgSecFindingStatus,
	TG_SEC_FINDING_SEVERITIES,
	TG_SEC_FINDING_SEVERITY_LABELS,
	type TgSecFindingSeverity,
	type TgSecFindingStatus,
} from "./finding-vocabulary.ts";

/** One finding as a report renders it: metadata plus the snapshot ids that prove it. */
export type TgSecReportFinding = {
	findingId: string;
	lane: string;
	title: string;
	severity: TgSecFindingSeverity;
	status: TgSecFindingStatus;
	evidenceVersion: number;
	snapshots: string[];
};

/**
 * A rendered report. `body` carries no evidence bytes and no timestamp, so the same findings always
 * render the same bytes; `digest` is the SHA-256 of those bytes.
 */
export type TgSecReportValue = {
	reportId: string;
	revision: number;
	generatedAt: number;
	digest: string;
	findingCount: number;
	findings: TgSecReportFinding[];
	body: string;
};

/**
 * The campaign's report documents, one member per report id. The document keeps the latest revision
 * and its deterministic body; regenerating bumps `revision` but never changes bytes for the same
 * findings.
 */
export const TgSecReportDoc = defineDocFamily<TgSecReportValue, TgSecReportValue>({
	kind: "tg.sec.report",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({ ...seed }),
});

/** The document key of one report. */
export function reportKey(reportId: string): string {
	return reportId;
}

/** The seed a report starts from before its first generation. */
export function emptySecReport(reportId: string): TgSecReportValue {
	return {
		reportId,
		revision: 0,
		generatedAt: 0,
		digest: "",
		findingCount: 0,
		findings: [],
		body: "",
	};
}

export type TgSecReportRenderInput = {
	readonly project: string;
	readonly target: string;
	readonly findings: readonly TgSecReportFinding[];
};

export type TgSecReportRender = {
	readonly body: string;
	readonly digest: string;
	readonly findings: readonly TgSecReportFinding[];
};

const SEVERITY_RANK = new Map<TgSecFindingSeverity, number>(
	TG_SEC_FINDING_SEVERITIES.map((severity, index) => [severity, index]),
);

/**
 * Render findings deterministically: highest severity first, then finding id in code-unit order.
 * The body is Markdown, names only snapshot ids, and never includes a capture body or a clock value.
 */
export function renderSecReport(input: TgSecReportRenderInput): TgSecReportRender {
	const findings = [...input.findings]
		.sort((left, right) => {
			const rank =
				(SEVERITY_RANK.get(left.severity) ?? TG_SEC_FINDING_SEVERITIES.length) -
				(SEVERITY_RANK.get(right.severity) ?? TG_SEC_FINDING_SEVERITIES.length);
			if (rank !== 0) return rank;
			return left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0;
		})
		.map((finding) => ({ ...finding, snapshots: [...finding.snapshots] }));

	const lines = [
		"# 安全评估报告",
		`project: ${oneLine(input.project)}`,
		`target: ${oneLine(input.target)}`,
		`findings: ${findings.length}`,
	];
	if (findings.length === 0) {
		lines.push("", "未登记发现。");
	}
	for (const finding of findings) {
		if (!isTgSecFindingSeverity(finding.severity) || !isTgSecFindingStatus(finding.status)) {
			throw new TypeError(`report finding ${finding.findingId} carries an unknown severity or status`);
		}
		lines.push(
			"",
			`## [${TG_SEC_FINDING_SEVERITY_LABELS[finding.severity]}] ${oneLine(finding.title)}`,
			`- finding: ${oneLine(finding.findingId)}`,
			`- lane: ${oneLine(finding.lane)}`,
			`- status: ${finding.status}`,
			`- evidence-version: ${finding.evidenceVersion}`,
			`- snapshots: ${finding.snapshots.length === 0 ? "(none)" : finding.snapshots.map((id) => oneLine(id)).join(", ")}`,
		);
	}
	const body = lines.join("\n");
	return { body, digest: createHash("sha256").update(body).digest("hex"), findings };
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
