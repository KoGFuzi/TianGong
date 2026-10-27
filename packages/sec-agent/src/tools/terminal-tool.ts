import { defineTool, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { Type } from "typebox";
import type { SecAgentLane } from "../bootstrap.ts";
import type { TgSecEvidenceStore } from "../evidence/store.ts";
import {
	type TgSecTerminalClaim,
	type TgSecTerminalStatus,
	type TgSecTerminalValue,
	terminalClaimForLane,
	writeTerminalDeclaration,
} from "../terminal.ts";

/** The host-side seams: the finding store validation reads and the optional flag source. */
export type TerminalToolOptions = {
	readonly lane: SecAgentLane;
	readonly store: TgSecEvidenceStore;
	/** Resolves a CTF flag against the submission record; absent means every getflag claim stays unverified. */
	readonly verifyFlag?: (flag: string) => Promise<boolean>;
	readonly now?: () => number;
};

const noteSchema = Type.Optional(Type.String({ description: "Operator-facing note attached to the declaration" }));

const getshellSchema = Type.Object({
	claim: Type.Literal("getshell"),
	findingId: Type.String({ description: "A verified high/critical finding that proves the shell" }),
	snapshotId: Type.Optional(Type.String({ description: "The evidence snapshot that proves it, when one names it" })),
	note: noteSchema,
});

const getflagSchema = Type.Object({
	claim: Type.Literal("getflag"),
	flag: Type.String({
		description: "The submitted flag; validated against the host's submission record, never stored",
	}),
	note: noteSchema,
});

const highCriticalSchema = Type.Object({
	claim: Type.Literal("high_critical_finding"),
	findingId: Type.String({ description: "The verified high or critical finding that closes the campaign" }),
	snapshotId: Type.Optional(Type.String({ description: "The evidence snapshot supporting the finding" })),
	note: noteSchema,
});

const terminalSchema = Type.Union([getshellSchema, getflagSchema, highCriticalSchema], {
	description: "Claim that this lane reached its terminal state; the host decides whether the claim holds",
});

const terminalStructuredSchema = Type.Object({
	claim: Type.String(),
	lane: Type.String(),
	status: Type.String(),
	reason: Type.String(),
	findingId: Type.Optional(Type.String()),
	snapshotId: Type.Optional(Type.String()),
});

type TerminalArgs = {
	readonly claim: TgSecTerminalClaim;
	readonly findingId?: string;
	readonly snapshotId?: string;
	readonly flag?: string;
	readonly note?: string;
};

type Verdict = {
	readonly status: TgSecTerminalStatus;
	readonly reason: string;
};

const VERIFIED_FINDING_STATUSES = new Set(["verified", "retest-pass"]);

async function evaluateFindingClaim(
	store: TgSecEvidenceStore,
	claim: TgSecTerminalClaim,
	args: TerminalArgs,
): Promise<Verdict> {
	const findingId = args.findingId?.trim() ?? "";
	if (findingId === "") throw new TypeError(`${claim} needs a finding id`);
	const finding = await store.getFinding(findingId);
	if (finding === undefined) {
		return { status: "unverified", reason: `finding ${findingId} is not registered` };
	}
	if (finding.severity !== "high" && finding.severity !== "critical") {
		return {
			status: "unverified",
			reason: `finding ${findingId} is ${finding.severity}; a terminal claim needs high or critical`,
		};
	}
	if (!VERIFIED_FINDING_STATUSES.has(finding.status)) {
		return {
			status: "unverified",
			reason: `finding ${findingId} is ${finding.status}; it must be verified first`,
		};
	}
	if (claim === "high_critical_finding") {
		return {
			status: "verified",
			reason: `finding ${findingId} is ${finding.severity}/${finding.status}`,
		};
	}
	const set = await store.list(findingId);
	const snapshotId = args.snapshotId?.trim() ?? "";
	if (snapshotId !== "") {
		const bound = set.bindings.some((binding) => binding.snapshotId === snapshotId);
		if (!bound) {
			return {
				status: "unverified",
				reason: `snapshot ${snapshotId} is not bound to finding ${findingId}`,
			};
		}
		return {
			status: "verified",
			reason: `finding ${findingId} is ${finding.severity}/${finding.status}; snapshot ${snapshotId} is bound`,
		};
	}
	if (set.bindings.length === 0) {
		return { status: "unverified", reason: `finding ${findingId} has no evidence snapshot bound` };
	}
	return {
		status: "verified",
		reason: `finding ${findingId} is ${finding.severity}/${finding.status} with ${set.bindings.length} snapshot(s)`,
	};
}

async function evaluateFlagClaim(options: TerminalToolOptions, args: TerminalArgs): Promise<Verdict> {
	const flag = args.flag?.trim() ?? "";
	if (flag === "") throw new TypeError("getflag needs the submitted flag");
	if (options.verifyFlag === undefined) {
		return { status: "unverified", reason: "no flag submission record source is configured" };
	}
	const accepted = await options.verifyFlag(flag);
	return accepted
		? { status: "verified", reason: "the flag exists in the submission record" }
		: { status: "unverified", reason: "the flag is not in the submission record" };
}

/**
 * Declare that the campaign reached its lane's terminal state. The model's word is not evidence:
 * this tool validates the claim against the host's own records (the finding store, the bound
 * snapshots, an injected CTF submission source) and persists the verdict. An unverified declaration
 * is kept for the projection as `unverified`; it never changes a finding's status.
 */
export function createTerminalDeclareTool(options: TerminalToolOptions): ToolRegistration<typeof terminalSchema> {
	const now = options.now ?? (() => Date.now());
	const expectedClaim = terminalClaimForLane(options.lane);
	return defineTool({
		name: "terminal_declare",
		description:
			"Declare this lane's terminal state: getshell (redteam), getflag (ctf), or high_critical_finding (src). The host validates the claim against its own records; an unverifiable claim is recorded as unverified and changes no finding.",
		parameters: terminalSchema,
		structuredOutputSchema: terminalStructuredSchema,
		callers: ["model", "tools"],
		deferred: true,
		replay: "unsafe",
		async execute(args, api, context) {
			const claim = args.claim;
			if (claim !== expectedClaim) {
				throw new TypeError(`lane ${options.lane} may only declare ${expectedClaim}, not ${claim}`);
			}
			const verdict =
				claim === "getflag"
					? await evaluateFlagClaim(options, args)
					: await evaluateFindingClaim(options.store, claim, args);
			const declaredAt = now();
			const findingId = "findingId" in args ? args.findingId.trim() : "";
			const snapshotId = "snapshotId" in args ? (args.snapshotId?.trim() ?? "") : "";
			const value: TgSecTerminalValue = {
				claim,
				lane: options.lane,
				status: verdict.status,
				reason: verdict.reason,
				findingId,
				snapshotId,
				note: args.note?.trim() ?? "",
				declaredAt,
				verifiedAt: verdict.status === "verified" ? declaredAt : 0,
			};
			await api.commit((tx) => writeTerminalDeclaration(tx, value), context);
			api.output(`declared ${claim}: ${verdict.status} — ${verdict.reason}`);
			return {
				structuredOutput: {
					claim,
					lane: options.lane,
					status: verdict.status,
					reason: verdict.reason,
					...(value.findingId === "" ? {} : { findingId: value.findingId }),
					...(value.snapshotId === "" ? {} : { snapshotId: value.snapshotId }),
				},
			};
		},
	});
}
