import type { Context } from "@OnePanda-TgSec/chord";
import {
	type Cursor,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	defineDoc,
	defineDocFamily,
	type Page,
	type StoredDocument,
	type Tx,
} from "@OnePanda-TgSec/tg-gibraltar";

/** One step of the root's plan; `status` is the only field a later revision may not preserve. */
export type TgSecPlanStepStatus = "open" | "active" | "done" | "dropped";

/** A step as it is persisted in one plan revision. */
export type TgSecPlanStep = {
	stepId: string;
	title: string;
	detail: string;
	status: TgSecPlanStepStatus;
	ownerRole: string;
	conversationId: number;
	updatedAt: number;
};

/** One immutable plan revision; the family key is the decimal revision number. */
export type TgSecPlanValue = {
	revision: number;
	createdAt: number;
	rationale: string;
	steps: TgSecPlanStep[];
};

/** The caller's step fields; `stepId` is generated when it is blank. */
export type TgSecPlanStepInput = {
	readonly stepId?: string;
	readonly title: string;
	readonly detail?: string;
	readonly status?: TgSecPlanStepStatus;
	readonly ownerRole?: string;
	readonly conversationId?: number;
};

/** What one `plan_update` call contributes; the revision number comes from the head document. */
export type TgSecPlanRevisionInput = {
	readonly rationale?: string;
	readonly steps: readonly TgSecPlanStepInput[];
};

/** The head pointer: one session singleton carrying the newest revision number. */
export type TgSecPlanHeadValue = {
	revision: number;
};

/**
 * The plan family: one immutable member per revision, keyed by the decimal revision number. A new
 * revision is a new member rather than a mutation, so every revision stays enumerable and
 * replayable through ordinary document reads.
 */
export const TgSecPlanDoc = defineDocFamily<TgSecPlanValue, TgSecPlanValue>({
	kind: "tg.sec.plan",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({
		revision: seed.revision,
		createdAt: seed.createdAt,
		rationale: seed.rationale,
		steps: seed.steps.map((step) => ({ ...step })),
	}),
});

/** The newest revision pointer; its value is what makes the next revision number deterministic. */
export const TgSecPlanHeadDoc = defineDoc<TgSecPlanHeadValue>({
	kind: "tg.sec.plan-head",
	version: 1,
	scope: "session",
	initial: () => ({ revision: 0 }),
});

export const TG_SEC_PLAN_KIND = "tg.sec.plan";
export const TG_SEC_PLAN_HEAD_KIND = "tg.sec.plan-head";

export function planKey(revision: number): string {
	return String(revision);
}

/** The source a projection needs to enumerate every plan revision without a typed token per key. */
export type TgSecPlanSource = {
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>>;
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;
};

function stringField(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	return typeof value === "string" ? value : "";
}

function numberField(source: Record<string, unknown>, key: string): number {
	const value = source[key];
	return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

/** Read one stored plan value, tolerating rows written by an older revision of this module. */
export function planFromValue(value: Record<string, unknown>): TgSecPlanValue | undefined {
	const revision = numberField(value, "revision");
	if (revision <= 0) return undefined;
	const rawSteps = value.steps;
	const steps: TgSecPlanStep[] = [];
	if (Array.isArray(rawSteps)) {
		for (const raw of rawSteps) {
			if (raw === null || typeof raw !== "object") continue;
			const step = raw as Record<string, unknown>;
			const title = stringField(step, "title");
			if (title === "") continue;
			steps.push({
				stepId: stringField(step, "stepId"),
				title,
				detail: stringField(step, "detail"),
				status: planStatus(stringField(step, "status")),
				ownerRole: stringField(step, "ownerRole"),
				conversationId: numberField(step, "conversationId"),
				updatedAt: numberField(step, "updatedAt"),
			});
		}
	}
	return {
		revision,
		createdAt: numberField(value, "createdAt"),
		rationale: stringField(value, "rationale"),
		steps,
	};
}

function planStatus(value: string): TgSecPlanStepStatus {
	return value === "active" || value === "done" || value === "dropped" ? value : "open";
}

/** Every plan revision in ascending order; the last item is the current plan. */
export async function listPlan(source: TgSecPlanSource, context: Context): Promise<readonly TgSecPlanValue[]> {
	const records: DocumentRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await source.scanDocuments(
			{ scope: { kind: "session" }, at: "current", kind: TG_SEC_PLAN_KIND },
			200,
			cursor,
			context,
		);
		records.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);

	const plans: TgSecPlanValue[] = [];
	for (const record of records) {
		if (record.key === undefined) continue;
		const stored = await source.document(record.id, "current", context);
		const plan = stored === undefined ? undefined : planFromValue(stored.value);
		if (plan !== undefined) plans.push(plan);
	}
	return plans.sort((left, right) => left.revision - right.revision);
}

/** The newest plan revision, or `undefined` before the first `plan_update`. */
export async function latestPlan(source: TgSecPlanSource, context: Context): Promise<TgSecPlanValue | undefined> {
	const plans = await listPlan(source, context);
	return plans[plans.length - 1];
}

function normalizeSteps(steps: readonly TgSecPlanStepInput[], now: number): TgSecPlanStep[] {
	const used = new Set<string>();
	const normalized: TgSecPlanStep[] = [];
	steps.forEach((step, index) => {
		const title = step.title.trim();
		if (title === "") throw new TypeError("a plan step needs a title");
		const stem = step.stepId?.trim() || `step-${index + 1}`;
		let stepId = stem;
		for (let suffix = 2; used.has(stepId); suffix += 1) stepId = `${stem}-${suffix}`;
		used.add(stepId);
		normalized.push({
			stepId,
			title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
			detail: step.detail?.trim() ?? "",
			status: step.status ?? "open",
			ownerRole: step.ownerRole?.trim() ?? "",
			conversationId: step.conversationId ?? 0,
			updatedAt: now,
		});
	});
	return normalized;
}

/**
 * Append one revision inside the caller's transaction. The head document is the revision counter:
 * it is read, checked and advanced in the same commit as the plan member, so a concurrent writer
 * either lands first or observes the new head — never overwrites a revision it did not read.
 */
export async function appendPlanRevision(tx: Tx, input: TgSecPlanRevisionInput, now: number): Promise<TgSecPlanValue> {
	const head = await tx.doc(TgSecPlanHeadDoc);
	const revision = head.revision + 1;
	const value: TgSecPlanValue = {
		revision,
		createdAt: now,
		rationale: input.rationale?.trim() ?? "",
		steps: normalizeSteps(input.steps, now),
	};
	const doc = await tx.doc(TgSecPlanDoc, planKey(revision), {
		revision,
		createdAt: now,
		rationale: value.rationale,
		steps: value.steps.map((step) => ({ ...step })),
	});
	doc.revision = value.revision;
	doc.createdAt = value.createdAt;
	doc.rationale = value.rationale;
	doc.steps = value.steps.map((step) => ({ ...step }));
	head.revision = revision;
	return value;
}
