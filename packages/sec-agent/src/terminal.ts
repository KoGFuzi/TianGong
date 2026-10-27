import type { Context } from "@OnePanda-TgSec/chord";
import {
	type Cursor,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	defineDocFamily,
	type Page,
	type StoredDocument,
	type Tx,
} from "@OnePanda-TgSec/tg-gibraltar";
import type { SecAgentLane } from "./bootstrap.ts";

/** The terminal statement each lane is allowed to make. */
export const TG_SEC_TERMINAL_CLAIMS = ["getshell", "getflag", "high_critical_finding"] as const;

export type TgSecTerminalClaim = (typeof TG_SEC_TERMINAL_CLAIMS)[number];

/** Host verdict on a declaration: only the host may promote a claim to `verified`. */
export const TG_SEC_TERMINAL_STATUSES = ["unverified", "verified"] as const;

export type TgSecTerminalStatus = (typeof TG_SEC_TERMINAL_STATUSES)[number];

/** One persisted terminal declaration; the raw CTF flag is validated and never stored. */
export type TgSecTerminalValue = {
	claim: TgSecTerminalClaim;
	lane: string;
	status: TgSecTerminalStatus;
	reason: string;
	findingId: string;
	snapshotId: string;
	note: string;
	declaredAt: number;
	verifiedAt: number;
};

export const TgSecTerminalDoc = defineDocFamily<TgSecTerminalValue, TgSecTerminalValue>({
	kind: "tg.sec.terminal",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({ ...seed }),
});

export const TG_SEC_TERMINAL_KIND = "tg.sec.terminal";

export function terminalClaimForLane(lane: SecAgentLane): TgSecTerminalClaim {
	if (lane === "redteam") return "getshell";
	if (lane === "ctf") return "getflag";
	return "high_critical_finding";
}

/** One member per lane and claim; a later declaration replaces the earlier one. */
export function terminalKey(lane: string, claim: TgSecTerminalClaim): string {
	return `${lane}:${claim}`;
}

/** Write one declaration inside the caller's transaction. */
export async function writeTerminalDeclaration(tx: Tx, value: TgSecTerminalValue): Promise<void> {
	const doc = await tx.doc(TgSecTerminalDoc, terminalKey(value.lane, value.claim), { ...value });
	doc.claim = value.claim;
	doc.lane = value.lane;
	doc.status = value.status;
	doc.reason = value.reason;
	doc.findingId = value.findingId;
	doc.snapshotId = value.snapshotId;
	doc.note = value.note;
	doc.declaredAt = value.declaredAt;
	doc.verifiedAt = value.verifiedAt;
}

export type TgSecTerminalSource = {
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>>;
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;
};

function asString(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	return typeof value === "string" ? value : "";
}

function asNumber(source: Record<string, unknown>, key: string): number {
	const value = source[key];
	return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function terminalFromValue(value: Record<string, unknown>): TgSecTerminalValue | undefined {
	const claim = asString(value, "claim");
	if (claim !== "getshell" && claim !== "getflag" && claim !== "high_critical_finding") return undefined;
	const status = asString(value, "status");
	return {
		claim,
		lane: asString(value, "lane"),
		status: status === "verified" ? "verified" : "unverified",
		reason: asString(value, "reason"),
		findingId: asString(value, "findingId"),
		snapshotId: asString(value, "snapshotId"),
		note: asString(value, "note"),
		declaredAt: asNumber(value, "declaredAt"),
		verifiedAt: asNumber(value, "verifiedAt"),
	};
}

/** Every persisted declaration, ordered by lane then claim so the projection is deterministic. */
export async function listTerminals(
	source: TgSecTerminalSource,
	context: Context,
): Promise<readonly TgSecTerminalValue[]> {
	const records: DocumentRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await source.scanDocuments(
			{ scope: { kind: "session" }, at: "current", kind: TG_SEC_TERMINAL_KIND },
			200,
			cursor,
			context,
		);
		records.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);

	const terminals: TgSecTerminalValue[] = [];
	for (const record of records) {
		const stored = await source.document(record.id, "current", context);
		const terminal = stored === undefined ? undefined : terminalFromValue(stored.value);
		if (terminal !== undefined) terminals.push(terminal);
	}
	return terminals.sort((left, right) => left.lane.localeCompare(right.lane) || left.claim.localeCompare(right.claim));
}
