import {
	AgentDoc,
	AssistantEntry,
	type ConversationId,
	defineTool,
	type EntryId,
	type ModelRef,
	type ToolRegistration,
	type Tx,
} from "@OnePanda-TgSec/tg-gibraltar";
import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	TG_SPAN_SCHEMA,
} from "@OnePanda-TgSec/tg-telemetry";
import { Type } from "typebox";
import { patchActionNode } from "./action-tree.ts";
import type { SecAgentLane } from "./bootstrap.ts";

/** The static policy of one lane's child conversations; plain values, so a call cannot widen it. */
export type TaskChildPolicy = {
	/** Extension names the child selects, in order. Never a `{ add }` edit: widening is unexpressible. */
	readonly extensions: readonly string[];
	/** `null` deliberately leaves the child with no model: its delegation settles unanswered. */
	readonly model?: ModelRef | null;
	readonly cwd?: string;
	readonly instructions?: string;
};

export type TaskToolOptions = {
	readonly policies: Readonly<Record<SecAgentLane, TaskChildPolicy>>;
	/** The campaign's lane; `lane` in a call overrides it only among these policies. */
	readonly lane: SecAgentLane;
	readonly now?: () => number;
	/** Audit sink for the `tg.span.sec.fork` delegation span; absent means no-op. */
	readonly telemetry?: TelemetryContext;
};

const taskSchema = Type.Object({
	intent: Type.String({
		description:
			"Self-contained task for a dedicated child conversation; the child sees the forked history and this input",
	}),
	lane: Type.Optional(
		Type.Union([Type.Literal("redteam"), Type.Literal("ctf"), Type.Literal("src")], {
			description: "Policy lane for the child; defaults to the campaign's lane",
		}),
	),
});

const taskStructuredOutputSchema = Type.Object({
	conversationId: Type.Number({ description: "The child conversation this call delegated to" }),
	status: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
	summary: Type.String({ description: "The child's final assistant text; empty when it produced none" }),
});

export type TaskToolInput = { readonly intent: string; readonly lane?: SecAgentLane };

function textOfEntry(model: unknown): string {
	const message = model as { content?: { type: string; text?: string }[]; stopReason?: string } | undefined;
	if (message === undefined) return "";
	if (message.stopReason === "toolUse") return "";
	return message.content?.map((block) => block.text ?? "").join("") ?? "";
}

/** The newest visible entry of the conversation: the fork point when no head marker exists. */
async function newestEntryId(tx: Tx, conversationId: ConversationId): Promise<EntryId> {
	const marker = await tx.latestHeadMarker(conversationId);
	if (marker !== undefined) return marker.id;
	const page = await tx.scanEntries({ conversationId, order: "descending" }, 1);
	const newest = page.items[0];
	if (newest === undefined) throw new Error(`conversation ${conversationId} has no entry to fork from`);
	return newest.id;
}

/**
 * The `task` tool: delegate one intent to a fresh child conversation forked from the calling one,
 * owned by this call's task, and wait for it in the foreground (v1). The child's agent is set from
 * the lane's static policy in the same commit, so it selects plain extension names only; the guard's
 * `beforeTool` hook stays the authoritative limiter of what the child can do. Every delegation is
 * recorded in the `tg.sec.action-tree` family before the child runs and closed with its outcome.
 */
export function createTaskTool(options: TaskToolOptions): ToolRegistration<typeof taskSchema> {
	const now = options.now ?? (() => Date.now());
	const startForkSpan = createTypedSpanStarter(options.telemetry ?? NOOP_TELEMETRY_CONTEXT, [TG_SPAN_SCHEMA]);
	return defineTool({
		name: "task",
		description:
			"Delegate a self-contained intent to a dedicated child conversation and wait for its summary. The child runs under the lane's fixed tool policy; only its final answer returns here.",
		parameters: taskSchema,
		structuredOutputSchema: taskStructuredOutputSchema,
		callers: ["model"],
		replay: "unsafe",
		async execute(args, api, context) {
			const lane = args.lane ?? options.lane;
			return startForkSpan("tg.span.sec.fork", { lane }, async (span) => {
				const policy = options.policies[lane];
				const forkPoint = await api.commit((tx) => newestEntryId(tx, api.conversationId), context);
				const child = await api.commit(async (tx) => {
					const created = await tx.forkConversation(api.conversationId, forkPoint, {
						ownership: { kind: "task", taskId: api.taskId },
					});
					const agent = await tx.doc(AgentDoc, created.id);
					agent.extensions = [...policy.extensions];
					if (policy.model === null) delete agent.model;
					else if (policy.model !== undefined) agent.model = policy.model;
					if (policy.cwd !== undefined) agent.cwd = policy.cwd;
					if (policy.instructions !== undefined) agent.instructions = policy.instructions;
					await patchActionNode(tx, created, now, { intent: args.intent });
					return created;
				}, context);

				const handle = await api.conversation(child.id, context);
				if (handle === undefined) throw new Error(`child conversation ${child.id} disappeared`);
				const settled = await (await handle.submit({ type: "input", content: args.intent }, context)).wait(context);
				await handle.waitForIdle(context);

				const tail = await api.commit(
					(tx) => tx.scanEntries({ conversationId: child.id, order: "descending" }, 30),
					context,
				);
				const answers = tail.items.filter(
					(entry) => AssistantEntry.is(entry) && textOfEntry(entry.model?.[0]) !== "",
				);
				const answer = answers[0];
				const summary = answer === undefined ? "" : textOfEntry(answer.model?.[0]);
				const status = settled.status === "done" ? "done" : "failed";

				await api.commit(
					(tx) => patchActionNode(tx, child, now, { status, summaryRef: String(answer?.id ?? "") }),
					context,
				);

				const structuredOutput = { conversationId: Number(child.id), status, summary };
				span.setAttributes({ outcome: status, depth: 1 });
				if (answer === undefined) api.output("(no assistant answer from the child)");
				else api.output(summary);
				return status === "done" ? { structuredOutput } : { structuredOutput, isError: true };
			});
		},
	});
}
