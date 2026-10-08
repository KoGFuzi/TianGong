import { type Context, copyJson, type Draft, type JsonRepresentation } from "@OnePanda-TgSec/chord";
import type { Usage } from "@OnePanda-TgSec/tg-ai";
import { defineDoc, materializeDocument } from "../documents.ts";
import type { ConversationId, Cursor, Storage, Tx } from "../types.ts";

/** Ledger of one conversation's own spend: its entries, and compaction summarization attempts, which have none. */
export type UsageState = {
	/** Assistant entries and summarization attempts, keyed `provider/modelId`. */
	models: Record<string, JsonRepresentation<Usage>>;
	/** Tool results, keyed by tool name; their usage has no model identity. */
	tools: Record<string, JsonRepresentation<Usage>>;
};

export const UsageDoc = defineDoc<UsageState>({
	kind: "tg.usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ models: {}, tools: {} }),
	checkpointWhen: () => true,
});

/** Add `usage` to one bucket of the conversation's `tg.usage`, in the commit that records the response. */
export async function recordUsage(
	tx: Tx,
	conversationId: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<void> {
	const totals = (await tx.doc(UsageDoc, conversationId))[bucket];
	// Own keys only: a tool may be called `toString`.
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	// Providers may leave optional counters `undefined`; drafts take strict JSON.
	if (total === undefined)
		totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
	else addUsage(total, usage);
}

/** Add every counter of `usage` to `total`; optional counters are added once either side reports them. */
export function addUsage(total: Draft<Usage> | Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** Add every bucket of `state` into `sum`. */
export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const) {
		for (const [key, usage] of Object.entries(state[bucket])) {
			const total = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;
			// Define rather than assign: assigning a tool named `__proto__` would set the prototype.
			if (total !== undefined) addUsage(total, usage);
			else
				Object.defineProperty(sum[bucket], key, {
					value: structuredClone(usage),
					enumerable: true,
					writable: true,
				});
		}
	}
}

/** One storage's whole-project spend: every conversation's `tg.usage`, folded at read time. */
export type ProjectUsage = {
	/**
	 * Conversations that contributed spend.
	 *
	 * Not every conversation counts: `createConversation` materializes an empty `tg.usage`, so a
	 * conversation that never ran a model reads back as a ledger with no buckets.
	 */
	readonly conversations: number;
	readonly usage: UsageState;
};

/** Conversations per read while folding a project. Bounds the rows held at once, nothing else. */
const PROJECT_USAGE_PAGE = 200;

/**
 * Sum every conversation's usage ledger in the storage's project.
 *
 * A storage instance is one project's view: `scanConversations` filters on its `project_id`, so the
 * project is not a parameter here. The fold is deliberately read-time only, keeping `tg.usage` the
 * single write path; a second project-level ledger would have to be kept in step with every commit
 * that spends tokens, and two ledgers drift.
 */
export async function projectUsage(storage: Storage, context: Context): Promise<ProjectUsage> {
	const sum: UsageState = { models: {}, tools: {} };
	let conversations = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanConversations({}, PROJECT_USAGE_PAGE, cursor, context);
		for (const conversation of page.items) {
			const record = await storage.findDocument(
				{ kind: UsageDoc.definition.kind, scope: { kind: "conversation", conversationId: conversation.id } },
				"current",
				context,
			);
			// A conversation that has not run a model has no ledger yet.
			if (record === undefined) continue;
			const stored = await storage.document(record.id, "current", context);
			// The incarnation was replaced or removed between the two reads: skip rather than fail.
			if (stored === undefined) continue;
			// `recordUsage` wrote this shape inside this package, so the cast needs no validation.
			const state = materializeDocument(UsageDoc.definition, stored) as unknown as UsageState;
			// An untouched ledger is materialized on creation and holds no buckets; only real spend counts.
			if (Object.keys(state.models).length === 0 && Object.keys(state.tools).length === 0) continue;
			addUsageState(sum, state);
			conversations++;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return { conversations, usage: sum };
}
