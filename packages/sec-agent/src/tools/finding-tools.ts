import { defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { Type } from "typebox";
import type { TgSecEvidenceStore } from "../evidence/store.ts";
import {
	isTgSecFindingTransitionAllowed,
	isTgSecRetestStatus,
	TG_SEC_FINDING_SEVERITIES,
	TG_SEC_FINDING_STATUSES,
} from "../finding-vocabulary.ts";
import { recordConversationFinding } from "../task-findings.ts";

/** The store a campaign's finding tool writes; injected so tests drive a temp store. */
export type FindingToolOptions = {
	readonly store: TgSecEvidenceStore;
};

const SEVERITY_VALUES = TG_SEC_FINDING_SEVERITIES.map((value) => Type.Literal(value));
const STATUS_VALUES = TG_SEC_FINDING_STATUSES.map((value) => Type.Literal(value));

const findingSchema = Type.Object({
	findingId: Type.String({ description: "Stable id of the finding; also the evidence subject its snapshots bind to" }),
	lane: Type.Optional(Type.String({ description: "Campaign lane; required when creating, fixed thereafter" })),
	title: Type.Optional(Type.String({ description: "One-line finding title; required when creating" })),
	severity: Type.Optional(Type.Union(SEVERITY_VALUES, { description: "Rubric level; required when creating" })),
	status: Type.Optional(
		Type.Union(STATUS_VALUES, {
			description: "Lifecycle state; a retest-pass or retest-fail move must carry snapshotId",
		}),
	),
	snapshotId: Type.Optional(
		Type.String({ description: "New evidence snapshot bound to this finding; required for every retest" }),
	),
	expectedVersion: Type.Optional(
		Type.Number({ description: "Optimistic lock: refuse the write unless the subject is at this version" }),
	),
});

const findingStructuredSchema = Type.Object({
	findingId: Type.String(),
	lane: Type.String(),
	title: Type.String(),
	severity: Type.String(),
	status: Type.String(),
	subjectId: Type.String(),
	createdAt: Type.Number(),
	updatedAt: Type.Number(),
	evidenceVersion: Type.Number(),
	created: Type.Boolean(),
	changed: Type.Boolean(),
	retestSnapshotId: Type.Optional(Type.String()),
});

/**
 * Register or advance a finding. The first call creates it `open` from `lane`/`title`/`severity`;
 * later calls patch metadata or move the lifecycle. Transitions are validated here and again in the
 * store, and a retest destination always needs a freshly bound snapshot — the mechanism, not a prompt
 * rule, is what makes "a retest leaves new evidence" true.
 */
export function createFindingUpdateTool(options: FindingToolOptions): ToolRegistration<typeof findingSchema> {
	return defineTool({
		name: "finding_update",
		description:
			"Create or advance a finding. Creation supplies lane, title and severity and starts open. Updates may retitle or re-rate it, or move its status; retest-pass/retest-fail require a new evidence snapshot id bound to the finding. Writes share the evidence set's optimistic lock.",
		parameters: findingSchema,
		structuredOutputSchema: findingStructuredSchema,
		callers: ["model", "tools"],
		deferred: true,
		replay: "unsafe",
		async execute(args, api, context) {
			const findingId = args.findingId.trim();
			if (findingId === "") throw new TypeError("finding_update needs a finding id");
			const existing = await options.store.getFinding(findingId);
			if (existing !== undefined && args.status !== undefined && args.status !== existing.status) {
				if (!isTgSecFindingTransitionAllowed(existing.status, args.status)) {
					throw new TypeError(`finding ${findingId} cannot move from ${existing.status} to ${args.status}`);
				}
				if (isTgSecRetestStatus(args.status) && (args.snapshotId?.trim() ?? "") === "") {
					throw new TypeError("a retest needs a new evidence snapshot id");
				}
			}
			const result = await options.store.writeFinding({
				findingId,
				...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion }),
				...(args.lane === undefined ? {} : { lane: args.lane }),
				...(args.title === undefined ? {} : { title: args.title }),
				...(args.severity === undefined ? {} : { severity: args.severity }),
				...(args.status === undefined ? {} : { status: args.status }),
				...(args.snapshotId === undefined ? {} : { snapshotId: args.snapshotId }),
			});
			const finding = result.finding;
			await recordConversationFinding(api, finding.findingId, context);
			const retest = finding.retestSnapshotId === "" ? "" : `; retest ${finding.retestSnapshotId}`;
			api.output(
				`${result.created ? "created" : "updated"} finding ${finding.findingId} [${finding.severity}/${finding.status}] at evidence version ${result.version}${retest}`,
			);
			return {
				structuredOutput: {
					findingId: finding.findingId,
					lane: finding.lane,
					title: finding.title,
					severity: finding.severity,
					status: finding.status,
					subjectId: finding.subjectId,
					createdAt: finding.createdAt,
					updatedAt: finding.updatedAt,
					evidenceVersion: result.version,
					created: result.created,
					changed: result.changed,
					...(finding.retestSnapshotId === "" ? {} : { retestSnapshotId: finding.retestSnapshotId }),
				},
			};
		},
	});
}
