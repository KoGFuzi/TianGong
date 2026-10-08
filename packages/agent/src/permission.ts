/**
 * Declarative permission rules evaluated before a tool call is dispatched.
 *
 * Design notes live in `docs/permission-model.md`. The short version: `BeforeToolCallResult` is
 * frozen, so the tri-state decision lives only in this module's types and never crosses into the
 * hook's return type. Deny and ask-denied outcomes reuse the exact same blocked-result path as a
 * `{ block: true }` hook return, so the model observes identical semantics for every refusal kind.
 */

/** A single permission rule. The first matching rule in the list wins. */
export interface PermissionRule {
	/**
	 * The action being governed. MVP only defines "execute" (running a tool); "*" matches any
	 * action. The field exists so read/write-style actions can be added later without a breaking
	 * change to the rule shape.
	 */
	action: "execute" | "*";
	/**
	 * Resource identifier, matched against the derived resource with "*" wildcard support: every
	 * character is matched literally except "*", which matches any sequence. No glob character
	 * classes, no regex, no "?". Match is full-string anchored and case-sensitive.
	 *
	 * MVP derives exactly one resource form: `tool:<toolName>`.
	 */
	resource: string;
	effect: "allow" | "deny" | "ask";
}

/** What an `effect: "ask"` rule asks a human to decide. */
export interface PermissionRequest {
	/** Always "execute" in the MVP. */
	action: "execute";
	/** The derived resource the rule matched, e.g. "tool:shell". */
	resource: string;
	/** The target tool's name. */
	toolName: string;
	/** Schema-validated arguments for the call under review. */
	args: unknown;
}

/**
 * The human's reply to a {@link PermissionRequest}.
 *
 * "always" approves this call and records the grant in the session-scoped
 * {@link AgentLoopConfig.permissionGrants} cache, so later calls for the same action and resource
 * proceed without asking again. The grant is keyed on the exact derived resource (e.g.
 * "tool:shell"), never on the rule's wildcard pattern: approving "always" for one tool must not
 * silently widen to every tool a pattern would match.
 */
export type PermissionAskReply = "allow" | "deny" | "always";

/** Cache key for a session-scoped "always" grant. */
export function permissionGrantKey(action: "execute", resource: string): string {
	return `${action}:${resource}`;
}

/** Escape every regex-significant character, then turn "*" into a wildcard. */
function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/**
 * Evaluate rules against a derived resource, first match wins.
 *
 * No matching rule (including an empty rule list) returns "allow": the default is fail-open, so an
 * unconfigured agent behaves exactly as it did before permissions existed. This deliberately
 * differs from opencode's `evaluate`, whose unmatched fallback is "ask" — for a library default,
 * silently pausing for approval turns "not configured" into "hung".
 */
export function evaluatePermission(rules: readonly PermissionRule[], resource: string): "allow" | "deny" | "ask" {
	for (const rule of rules) {
		if (wildcardToRegExp(rule.resource).test(resource)) return rule.effect;
	}
	return "allow";
}

/**
 * Derive the MVP resource identifier for a tool call. The "tool:" prefix namespaces tool resources
 * so future action types cannot collide with tool names.
 */
export function toolResource(toolName: string): string {
	return `tool:${toolName}`;
}
