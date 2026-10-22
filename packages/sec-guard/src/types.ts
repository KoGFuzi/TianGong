import type { ToolHookCall } from "@OnePanda-TgSec/tg-gibraltar";

/** The four permission modes. Session-level state; see `tg.sec.mode` in `./mode.ts`. */
export type TgSecPermissionMode = "strict" | "judge-auto" | "auto" | "yolo";
/**
 * One guard decision. `deny` is produced only by the built-in hard deny (`hard: true` is a type-level
 * statement: this batch has no configurable deny rules, so a non-hard deny cannot exist). `ask` carries
 * `forced: true` when the ask comes from weak-evidence self-protection, scope, or the danger set and
 * therefore accepts no grants exemption.
 */
export type TgSecDecision =
	| { effect: "allow" }
	| { effect: "deny"; reason: string; hard: true }
	| { effect: "ask"; reason: string; forced: boolean };

/**
 * One tool call as the guard sees it. `arguments` stays the raw tree because the digest and the
 * extraction both need the whole shape, but no matcher may read it directly: the only sanctioned
 * reads are the ingress below, the telemetry digest, and `command-text.ts`'s extraction.
 * `test/boundary.test.ts` enforces that boundary mechanically.
 */
export type TgSecRequest = {
	toolName: string;
	resource: string;
	arguments: Record<string, unknown>;
};

/**
 * Scope verdict for one request. The resolver seam (`createTgSecScopeResolver` in `./scope.ts`)
 * consumes the shared connection-target extraction and the registry engine in `./scope-registry.ts`
 * (kinds, deny-over-allow precedence, config loading). There is no persistence or hot reload here:
 * that is batch 4 / product-layer work.
 */
export type TgSecScopeResolver = (request: TgSecRequest) => { inScope: boolean; reason?: string };

/**
 * Track objective the danger evaluator is tuned for (batch 2a). The track is a construction-time
 * parameter, never a per-call argument: the guard builds one evaluator per session and the set of
 * objective-conditional rules is fixed at that point. `redteam` is 红蓝对抗, `src` is 安全众测/漏洞
 * 挖掘, `ctf` is 夺旗赛.
 */
export type TgSecObjective = "redteam" | "ctf" | "src";

/** Every track objective. An objective outside this list throws at evaluator construction. */
export const TG_SEC_OBJECTIVES: readonly TgSecObjective[] = ["redteam", "ctf", "src"];

/**
 * Closed id of every dangerous-instruction rule in `src/danger.ts`. The id is the span `rule`
 * vocabulary for the `danger` layer, so this union and the telemetry `tg.span.sec.guard` `rule`
 * values are kept in lockstep (see the telemetry CHANGELOG). Four families:
 *  - **target destructive** (`danger.sql.*`, `danger.tool.*`, `danger.web.*`, `danger.redis.*`,
 *    `danger.mongo.*`): damage to the *target*, forced-asked on every objective, no CTF exemption;
 *  - **persistence** (`danger.persist.*`): write-behind changes on the target, every objective;
 *  - **critical-path removal** (`danger.rm.system-path`): the 2026-10-22 decision puts these in the
 *    danger set (a human may approve), not hard deny;
 *  - **objective-conditional** (`danger.business.*`, `danger.wordlist.*`, `danger.bruteforce.*`).
 */
export type TgSecDangerRuleId =
	| "danger.sql.drop-table"
	| "danger.sql.drop-database"
	| "danger.sql.truncate"
	| "danger.sql.delete-from"
	| "danger.sql.alter-drop"
	| "danger.sql.update-set"
	| "danger.sql.insert-into"
	| "danger.sql.replace-into"
	| "danger.sql.load-data-infile"
	| "danger.sql.into-outfile"
	| "danger.sql.into-dumpfile"
	| "danger.tool.sqlmap-os-shell"
	| "danger.tool.sqlmap-os-cmd"
	| "danger.tool.sqlmap-file-write"
	| "danger.tool.sqlmap-sql-shell"
	| "danger.web.action-destroy"
	| "danger.redis.flushall"
	| "danger.redis.flushdb"
	| "danger.mongo.drop-database"
	| "danger.persist.crontab"
	| "danger.persist.add-user"
	| "danger.persist.authorized-keys"
	| "danger.persist.schtasks"
	| "danger.persist.systemd-unit"
	| "danger.rm.system-path"
	| "danger.business.password-change"
	| "danger.business.contact-rebind"
	| "danger.business.payment-move"
	| "danger.business.messaging-bomb"
	| "danger.wordlist.huge"
	| "danger.bruteforce.hashcat"
	| "danger.bruteforce.john-wordlist";

/** The outcome of one danger-set evaluation: a hit names its closed rule id and a human-readable reason. */
export type TgSecDangerHit = { readonly hit: boolean; readonly rule?: TgSecDangerRuleId; readonly reason?: string };

/**
 * The dangerous-instruction set. Batch 2a lands the real evaluator behind
 * `createTgSecDangerEvaluator` in `./danger.ts`; the interface still consumes a `TgSecRequest` so an
 * injected evaluator sees the same seam a host would, and the built-in one reads only the two
 * package-internal views — never the raw `arguments` tree itself, which `test/boundary.test.ts`
 * holds that line on.
 */
export type TgSecDangerEvaluator = (request: TgSecRequest) => TgSecDangerHit;

/**
 * The `judge-auto` mode component (batch 2b, built by `createTgSecTwoAxisJudge` in `./judge.ts`).
 * The judge has no deny power: a decision outside allow/ask resolves to ask, and every failure path
 * — throw, timeout, off-protocol reply — asks.
 */
export type TgSecJudge = (request: TgSecRequest) => Promise<{ decision: "allow" | "ask"; comment: string }>;

/** The human reply to an ask. `always` grants the exact resource only, never a pattern. */
export type TgSecAskReply = "allow" | "deny" | "always";

/** One tool call as the guard sees it. The resource is `tool:<name>`, the legacy `permission.ts` shape. */
export function toTgSecRequest(call: ToolHookCall): TgSecRequest {
	return { toolName: call.name, resource: `tool:${call.name}`, arguments: call.arguments };
}
