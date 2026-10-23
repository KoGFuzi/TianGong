import type { Context, JsonValue } from "@OnePanda-TgSec/chord";
import {
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	defineDocFamily,
	type JsonObject,
	type SessionDocFamilyToken,
	type TaskId,
	type Tx,
} from "@OnePanda-TgSec/tg-gibraltar";

/** Lifecycle of one delegated child conversation. */
export type TgSecActionStatus = "open" | "done" | "failed";

/** The seed persisted when a task-owned conversation first appears. */
export type TgSecActionSeed = {
	readonly parentConversationId: number;
	readonly ownerTaskId: number;
	readonly at: number;
	readonly intent: string;
	readonly openedAt: number;
};

/** The persisted action-tree member. */
export type TgSecActionValue = {
	parentConversationId: number;
	ownerTaskId: number;
	at: number;
	intent: string;
	openedAt: number;
	status: TgSecActionStatus;
	summaryRef: string;
};

/**
 * The family of delegated child conversations: one member per fork, keyed by the child's
 * conversation ID. `ConversationRecord.owner` alone cannot be enumerated by the WebUI projection,
 * so every delegation writes this record (`docs/sec-agent-design.md` 子代理与行动树).
 */
export const TgSecActionTreeDoc = defineDocFamily<TgSecActionValue, TgSecActionSeed>({
	kind: "tg.sec.action-tree",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({ ...seed, status: "open", summaryRef: "" }),
});

/** The document key of one conversation. */
export function actionTreeKey(conversationId: ConversationId): string {
	return String(conversationId);
}

function seedFromRecord(child: ConversationRecord, now: number): TgSecActionSeed {
	const owner = child.owner;
	if (owner === undefined)
		throw new TypeError(`conversation ${child.id} has no owner edge; the action tree records delegations only`);
	return {
		parentConversationId: owner.conversationId,
		ownerTaskId: owner.taskId,
		at: child.parent === undefined ? 0 : child.parent.at,
		intent: "delegated",
		openedAt: now,
	};
}

/**
 * The `conversationCreated` hook that seeds one action-tree member per delegation. Root and
 * ownerless conversations carry no owner edge and are skipped; the Task tool overwrites `intent`
 * in its own init within the same commit.
 */
export function secActionTreeCreateHook(
	now: () => number,
): (tx: Tx, child: ConversationRecord) => Promise<void> | void {
	return (tx, child) => {
		if (child.owner === undefined) return;
		return tx.doc(TgSecActionTreeDoc, actionTreeKey(child.id), seedFromRecord(child, now())).then(() => undefined);
	};
}

/** A change to one action-tree member; absent fields stay as seeded. */
export type TgSecActionPatch = {
	readonly intent?: string;
	readonly status?: TgSecActionStatus;
	readonly summaryRef?: string;
};

/** Update one member inside a transaction. The seed applies only when the member does not exist yet. */
export async function patchActionNode(
	tx: Tx,
	child: ConversationRecord,
	now: () => number,
	patch: TgSecActionPatch,
): Promise<void> {
	const doc = await tx.doc(TgSecActionTreeDoc, actionTreeKey(child.id), seedFromRecord(child, now()));
	if (patch.intent !== undefined) doc.intent = patch.intent;
	if (patch.status !== undefined) doc.status = patch.status;
	if (patch.summaryRef !== undefined) doc.summaryRef = patch.summaryRef;
}

/** One action-tree member with the conversation it describes. */
export type TgSecActionNode = TgSecActionValue & { readonly conversationId: number };

/** The read surface `listActionTree` needs; a `Harness` satisfies both members. */
export interface ActionTreeSource {
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
}

/** Restrict enumeration to one parent's children or one task's children. */
export type ActionTreeQuery = {
	readonly parent?: ConversationId;
	readonly taskId?: TaskId;
};

/**
 * Enumerate delegated conversations joined with their action-tree records. Conversations created
 * before the seeding hook existed synthesize from the record, so enumeration never loses a fork;
 * the document is the intent/status channel, the conversation table is the existence authority.
 */
export async function listActionTree(
	source: ActionTreeSource,
	context: Context,
	query: ActionTreeQuery = {},
): Promise<readonly TgSecActionNode[]> {
	const children: ConversationRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await source.commit(
			(tx) => tx.scanConversations({ ownerConversationId: query.parent, ownerTaskId: query.taskId }, 200, cursor),
			context,
		);
		children.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);

	const nodes: TgSecActionNode[] = [];
	for (const child of children) {
		if (child.owner === undefined) continue;
		const stored = await source.snapshot(TgSecActionTreeDoc, actionTreeKey(child.id), context);
		if (stored !== undefined) {
			nodes.push({ conversationId: child.id, ...stored });
			continue;
		}
		const seed = seedFromRecord(child, 0);
		nodes.push({ conversationId: child.id, ...seed, status: "open", summaryRef: "" });
	}
	return nodes;
}
