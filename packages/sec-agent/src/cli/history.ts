import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import type { ConversationSummary, Cursor } from "@OnePanda-TgSec/tg-gibraltar";
import { openNodeSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";
import { projectDatabasePath } from "../config.ts";

/** The local time the history table shows, `YYYY-MM-DD HH:MM`. */
function formatCreatedAt(at: number): string {
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Print one row per conversation, newest first: ID, lane, local creation time, and the title, with an
 * `[archived] ` prefix on archived rows. Ancestry shows through the fork's `↳ ` title mark only, so
 * the lane column keeps a stable width.
 */
export async function printHistory(project: string, db: string | undefined): Promise<void> {
	const path = db ?? projectDatabasePath(project);
	const storage = await openNodeSqliteStorage(path, { project });
	try {
		const summaries: ConversationSummary[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanConversationSummaries({ archived: "include" }, 100, cursor, BACKGROUND_CONTEXT);
			summaries.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		if (summaries.length === 0) {
			process.stdout.write(`no history in project "${project}" (${path})\n`);
			return;
		}
		const idWidth = Math.max("id".length, ...summaries.map((summary) => String(summary.id).length));
		const laneWidth = Math.max("lane".length, ...summaries.map((summary) => summary.meta.lane.length));
		const createdWidth = "created".length;
		const rows = summaries.map((summary) => ({
			id: String(summary.id),
			lane: summary.meta.lane,
			created: formatCreatedAt(summary.meta.createdAt),
			title: `${summary.meta.archivedAt === undefined ? "" : "[archived] "}${summary.meta.title}`,
		}));
		const line = (columns: readonly string[]): string =>
			`${columns[0]!.padEnd(idWidth)}  ${columns[1]!.padEnd(laneWidth)}  ${columns[2]!.padEnd(createdWidth)}  ${columns[3]}`;
		process.stdout.write(`${line(["id", "lane", "created", "title"])}\n`);
		for (const row of rows) process.stdout.write(`${line([row.id, row.lane, row.created, row.title])}\n`);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}
