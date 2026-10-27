/**
 * The finding vocabulary shared by the data layer (`evidence/store.ts`) and the prompt layer
 * (`sections.ts`): the four rubric levels, the five lifecycle states, and the legal transitions.
 * One declaration, because a rubric the prompt names but the store rejects (or the reverse) makes
 * every report unverifiable.
 */

/** The fixed four-level rubric, highest first. */
export const TG_SEC_FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type TgSecFindingSeverity = (typeof TG_SEC_FINDING_SEVERITIES)[number];

/** The rubric level's display name, in the same order as {@link TG_SEC_FINDING_SEVERITIES}. */
export const TG_SEC_FINDING_SEVERITY_LABELS: Readonly<Record<TgSecFindingSeverity, string>> = {
	critical: "严重",
	high: "高",
	medium: "中",
	low: "低",
};

/** A finding's lifecycle. `wontfix` is terminal; every other state is reachable through a transition. */
export const TG_SEC_FINDING_STATUSES = ["open", "verified", "retest-pass", "retest-fail", "wontfix"] as const;

export type TgSecFindingStatus = (typeof TG_SEC_FINDING_STATUSES)[number];

/** The states a retest transition may land in; both require a new evidence snapshot. */
export const TG_SEC_RETEST_STATUSES: readonly TgSecFindingStatus[] = ["retest-pass", "retest-fail"];

/**
 * Legal state transitions. Re-asserting the current state is handled separately and is always
 * allowed; this table answers only "may the status move from `from` to `to`".
 *
 * - `open` becomes `verified` once a proof exists, or `wontfix` if the operator rejects it.
 * - `verified` is retested (either outcome) or closed as `wontfix`.
 * - A failed retest returns to `verified` for a fix, or is retested again with new evidence.
 * - A passed retest can regress with new evidence, or be closed as `wontfix`.
 * - `wontfix` is terminal: reopening a rejected finding silently would lose the decision.
 */
const FINDING_TRANSITIONS: Readonly<Record<TgSecFindingStatus, readonly TgSecFindingStatus[]>> = {
	open: ["verified", "wontfix"],
	verified: ["retest-pass", "retest-fail", "wontfix"],
	"retest-pass": ["retest-fail", "wontfix"],
	"retest-fail": ["verified", "retest-pass", "wontfix"],
	wontfix: [],
};

export function isTgSecFindingSeverity(value: string): value is TgSecFindingSeverity {
	return (TG_SEC_FINDING_SEVERITIES as readonly string[]).includes(value);
}

export function isTgSecFindingStatus(value: string): value is TgSecFindingStatus {
	return (TG_SEC_FINDING_STATUSES as readonly string[]).includes(value);
}

/** True when a status change is a retest that must carry a new evidence snapshot. */
export function isTgSecRetestStatus(value: TgSecFindingStatus): boolean {
	return TG_SEC_RETEST_STATUSES.includes(value);
}

/** True when the lifecycle may move from `from` to `to`. Same-state transitions are not answered here. */
export function isTgSecFindingTransitionAllowed(from: TgSecFindingStatus, to: TgSecFindingStatus): boolean {
	return FINDING_TRANSITIONS[from].includes(to);
}

export function assertTgSecFindingSeverity(value: string): asserts value is TgSecFindingSeverity {
	if (!isTgSecFindingSeverity(value)) {
		throw new TypeError(`finding severity ${value} is not one of ${TG_SEC_FINDING_SEVERITIES.join(", ")}`);
	}
}

export function assertTgSecFindingStatus(value: string): asserts value is TgSecFindingStatus {
	if (!isTgSecFindingStatus(value)) {
		throw new TypeError(`finding status ${value} is not one of ${TG_SEC_FINDING_STATUSES.join(", ")}`);
	}
}
