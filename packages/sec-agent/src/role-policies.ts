import type { ModelRef } from "@OnePanda-TgSec/tg-gibraltar";

/**
 * The closed child-role catalog. A role is a static policy profile chosen at assembly time, not an
 * entity: `task` may only pick one of these three names, so a call can never widen its own surface.
 */
export type TgSecAgentRole = "redteam" | "binary" | "reporting";

/**
 * The static policy of one role's child conversations; plain values, so a call cannot widen it.
 * `tools` is an allowlist over the installed registry: a name the registry lacks is simply absent,
 * and a name missing here is never offered or callable, whatever `modelTools` says.
 */
export type TaskChildPolicy = {
	/** Extension names the child selects, in order. Never a `{ add }` edit: widening is unexpressible. */
	readonly extensions: readonly string[];
	/** The exact tool surface the child may enable; absent keeps the parent's filter. */
	readonly tools?: readonly string[];
	/** `null` deliberately leaves the child with no model: its delegation settles unanswered. */
	readonly model?: ModelRef | null;
	readonly cwd?: string;
	readonly instructions?: string;
};

const CODING_TOOLS = ["bash", "edit", "read", "write"] as const;
const CODEMODE_TOOLS = ["codemode", "tg.codemode.models.classify", "tg.codemode.models.generateImages"] as const;
const SEARCH_TOOL = "tool_search";
const TASK_TOOL = "task";

/**
 * The three role profiles (`docs/sec-agent-optimization.md` 批7a). Extensions are named exactly as
 * the host installs them: the base set (`coding-tools`, `tool-search`, `codemode`) plus the
 * campaign's own (`sec-core`, `sec-tools`). `reporting` keeps `coding-tools` selected but filters it
 * down to `read`, so a read-only child has no write path and no codemode sandbox.
 */
export const secRolePolicies: Readonly<Record<TgSecAgentRole, TaskChildPolicy>> = {
	redteam: {
		extensions: ["coding-tools", "tool-search", "codemode", "sec-core", "sec-tools"],
		tools: [
			...CODING_TOOLS,
			...CODEMODE_TOOLS,
			SEARCH_TOOL,
			TASK_TOOL,
			"local_tool_check",
			"http_request",
			"evidence_capture",
			"traffic_query",
			"finding_update",
		],
	},
	binary: {
		extensions: ["coding-tools", "tool-search", "codemode", "sec-core", "sec-tools"],
		tools: [
			...CODING_TOOLS,
			...CODEMODE_TOOLS,
			SEARCH_TOOL,
			TASK_TOOL,
			"local_tool_check",
			"evidence_capture",
			"finding_update",
		],
	},
	reporting: {
		extensions: ["coding-tools", "tool-search", "sec-core", "sec-tools"],
		tools: ["read", SEARCH_TOOL, TASK_TOOL, "traffic_query", "report_generate"],
	},
};

/** The catalog's names, in a stable order for iteration and validation. */
export const SEC_AGENT_ROLES: readonly TgSecAgentRole[] = ["redteam", "binary", "reporting"];

export function isSecAgentRole(value: string): value is TgSecAgentRole {
	return value === "redteam" || value === "binary" || value === "reporting";
}

/** The MCP tool names the host registered for each role, in registration order. */
export type SecRoleToolNames = Readonly<Record<TgSecAgentRole, readonly string[]>>;

/** The extension that carries one role's MCP tools. An empty role installs no such extension. */
export function secMcpExtensionName(role: TgSecAgentRole): string {
	return `sec-mcp-${role}`;
}

/**
 * The base profiles plus each role's MCP extension and tool names. Composition is additive and
 * closed: a role never gains tools it was not registered for, and a role with no MCP tools keeps its
 * base profile unchanged.
 */
export function secRolePoliciesWithMcp(
	toolNames: SecRoleToolNames,
	base: Readonly<Record<TgSecAgentRole, TaskChildPolicy>> = secRolePolicies,
): Readonly<Record<TgSecAgentRole, TaskChildPolicy>> {
	const compose = (role: TgSecAgentRole): TaskChildPolicy => {
		const names = toolNames[role];
		const profile = base[role];
		if (names.length === 0) return profile;
		return {
			...profile,
			extensions: [...profile.extensions, secMcpExtensionName(role)],
			...(profile.tools === undefined ? {} : { tools: [...profile.tools, ...names] }),
		};
	};
	return { redteam: compose("redteam"), binary: compose("binary"), reporting: compose("reporting") };
}
