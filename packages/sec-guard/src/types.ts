/** The four permission modes. Session-level state; see `tg.sec.mode` in `./mode.ts`. */
export type TgSecPermissionMode = "strict" | "judge-auto" | "auto" | "yolo";

/**
 * One guard decision. `deny` is produced only by the built-in hard deny (`hard: true` is a type-level
 * statement: this batch has no configurable deny rules, so a non-hard deny cannot exist). `ask` carries
 * `forced: true` when the ask comes from scope or the danger set and therefore accepts no grants exemption.
 */
export type TgSecDecision =
	| { effect: "allow" }
	| { effect: "deny"; reason: string; hard: true }
	| { effect: "ask"; reason: string; forced: boolean };

/** One tool call as the guard sees it. `resource` is `tool:<toolName>`, the legacy `permission.ts` shape. */
export type TgSecRequest = {
	toolName: string;
	resource: string;
	arguments: Record<string, unknown>;
};

/** Batch 1 lands host/URL extraction and scope-table comparison. This batch declares the interface only. */
export type TgSecScopeResolver = (request: TgSecRequest) => { inScope: boolean; reason?: string };

/** Batch 2 lands the dangerous-instruction regex set. This batch declares the interface only. */
export type TgSecDangerEvaluator = (request: TgSecRequest) => { hit: boolean; reason?: string };

/**
 * Batch 2 lands the judge: the `judge-auto` mode component. This batch declares the interface only.
 * The judge has no deny power: a decision of `"deny"` is treated as `"ask"`.
 */
export type TgSecJudge = (request: TgSecRequest) => Promise<{ decision: "allow" | "ask"; comment: string }>;

/** The human reply to an ask. `always` grants the exact resource only, never a pattern. */
export type TgSecAskReply = "allow" | "deny" | "always";
