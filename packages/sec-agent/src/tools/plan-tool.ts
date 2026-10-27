import { defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { Type } from "typebox";
import { appendPlanRevision, type TgSecPlanStepStatus } from "../plan.ts";

export type PlanToolOptions = {
	readonly now?: () => number;
};

const STEP_STATUSES = ["open", "active", "done", "dropped"] as const satisfies readonly TgSecPlanStepStatus[];

const stepSchema = Type.Object({
	stepId: Type.Optional(Type.String({ description: "Stable step id; generated from the position when omitted" })),
	title: Type.String({ description: "One-line step title" }),
	detail: Type.Optional(Type.String({ description: "What proves the step, or how it is approached" })),
	status: Type.Optional(
		Type.Union(
			STEP_STATUSES.map((value) => Type.Literal(value)),
			{
				description: "Step lifecycle; defaults to open",
			},
		),
	),
	ownerRole: Type.Optional(Type.String({ description: "Role the step is delegated to, when known" })),
	conversationId: Type.Optional(Type.Number({ description: "Child conversation executing the step, when known" })),
});

const planSchema = Type.Object({
	rationale: Type.Optional(Type.String({ description: "Why this revision changes the plan" })),
	steps: Type.Array(stepSchema, {
		minItems: 1,
		maxItems: 64,
		description: "The whole plan at this revision, in execution order",
	}),
});

const planStructuredSchema = Type.Object({
	revision: Type.Number(),
	stepCount: Type.Number(),
	openSteps: Type.Number(),
	steps: Type.Array(
		Type.Object({
			stepId: Type.String(),
			title: Type.String(),
			status: Type.String(),
		}),
	),
});

/**
 * Replace the root's plan with a new immutable revision. The main agent holds the plan
 * (`docs/sec-agent-design.md` 子代理与行动树); this tool is the durable carrier, and the WebUI
 * projection reads intents from the newest revision. Each call appends one member to `tg.sec.plan`,
 * so revisions are enumerable and replayable by ordinary document reads.
 */
export function createPlanUpdateTool(options: PlanToolOptions = {}): ToolRegistration<typeof planSchema> {
	const now = options.now ?? (() => Date.now());
	return defineTool({
		name: "plan_update",
		description:
			"Replace the campaign plan with a new revision. Pass the whole ordered step list; every call appends an immutable revision that the WebUI projects as intents. Root only.",
		parameters: planSchema,
		structuredOutputSchema: planStructuredSchema,
		callers: ["model", "tools"],
		deferred: true,
		replay: "unsafe",
		async execute(args, api, context) {
			const value = await api.commit((tx) => appendPlanRevision(tx, args, now()), context);
			const openSteps = value.steps.filter((step) => step.status === "open" || step.status === "active").length;
			api.output(
				`plan revision ${value.revision}: ${value.steps.length} step(s), ${openSteps} open` +
					(value.rationale === "" ? "" : ` — ${value.rationale}`),
			);
			return {
				structuredOutput: {
					revision: value.revision,
					stepCount: value.steps.length,
					openSteps,
					steps: value.steps.map((step) => ({
						stepId: step.stepId,
						title: step.title,
						status: step.status,
					})),
				},
			};
		},
	});
}
