import type { Context } from "@OnePanda-TgSec/chord";
import { type DocumentReader, defineDocFamily, type ToolExecutionApi } from "@OnePanda-TgSec/tg-gibraltar";

/**
 * The finding ids one conversation entered. The family is keyed by the decimal conversation id, so
 * the `task` tool reads a child's list with a single snapshot when the child settles — no scan and
 * no dependence on the child's summary text.
 */
export type TgSecTaskFindingsValue = {
	conversationId: number;
	findingIds: string[];
};

export const TgSecTaskFindingsDoc = defineDocFamily<TgSecTaskFindingsValue, TgSecTaskFindingsValue>({
	kind: "tg.sec.task-findings",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({ conversationId: seed.conversationId, findingIds: [...seed.findingIds] }),
});

export function taskFindingsKey(conversationId: number): string {
	return String(conversationId);
}

/** Register one finding id the calling conversation touched; ids are unique and kept in entry order. */
export async function recordConversationFinding(
	api: Pick<ToolExecutionApi, "conversationId" | "commit">,
	findingId: string,
	context: Context,
): Promise<void> {
	const id = findingId.trim();
	if (id === "") return;
	await api.commit(async (tx) => {
		const conversationId = Number(api.conversationId);
		const doc = await tx.doc(TgSecTaskFindingsDoc, taskFindingsKey(conversationId), {
			conversationId,
			findingIds: [],
		});
		if (!doc.findingIds.includes(id)) doc.findingIds.push(id);
	}, context);
}

/** The finding ids one conversation entered, sorted so the task result is deterministic. */
export async function readConversationFindings(
	source: Pick<DocumentReader, "snapshot">,
	conversationId: number,
	context: Context,
): Promise<readonly string[]> {
	const value = await source.snapshot(TgSecTaskFindingsDoc, taskFindingsKey(conversationId), context);
	if (value === undefined) return [];
	return [...new Set(value.findingIds)].sort();
}
