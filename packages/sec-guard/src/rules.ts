import { readFile } from "node:fs/promises";

/**
 * One intercept rule's effect. The 2026-10-23 decisions fix the semantics: `deny` is **not** a
 * terminal rejection — it forces an ask that no grant and no mode can exempt, because a mis-written
 * operator rule must not block a legitimate action with no appeal (the only terminal deny is the
 * built-in hard deny). `ask` is a non-forced ask the human may answer `always`. `allow` only ever
 * takes effect inside mode dispatch (L2/L3/L4), never under `strict` — the strictest mode keeps
 * every call in front of a human, and an operations table may not quietly override mode semantics.
 */
export type TgSecRuleEffect = "allow" | "deny" | "ask";

/**
 * One row of the intercept rules table. `pattern` is `tool:<name>` granularity — parameter-level
 * resources are deliberately outside this grammar (design doc, non-goals); all parameter-level
 * judgement stays in the danger set and the scope parser. `priority` only orders rules of the *same*
 * effect (the highest wins the attribution); it never reorders deny over ask over allow.
 */
export type TgSecRule = {
	readonly id: string;
	readonly priority: number;
	readonly pattern: string;
	readonly effect: TgSecRuleEffect;
	readonly enabled: boolean;
	readonly note?: string;
};

/**
 * The compiled table. One `match` call per request collects every hit among the enabled rules and
 * returns the winner under the absolute precedence deny > ask > allow.
 */
export interface TgSecRuleTable {
	/** The winning enabled rule for one `tool:<name>` resource, or undefined when nothing matches. */
	match(resource: string): TgSecRule | undefined;
}

/** Strongest first. The index is the rank: deny > ask > allow, whatever the priorities say. */
const EFFECT_RANK: readonly TgSecRuleEffect[] = ["deny", "ask", "allow"];

/**
 * The legacy wildcard grammar, carried over verbatim in semantics from
 * `scripts/legacy/agent-core/src/permission.ts:58-61`: every character except `*` is regex-escaped,
 * `*` becomes `.*`, the match is anchored to the whole resource, and it is case-sensitive. No glob
 * character classes, no regex, no `?` (a literal `?` is escaped and matches itself).
 */
function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/** A usable pattern: the literal `tool:` prefix, then at least one non-space character, no spaces anywhere. */
function isToolPattern(pattern: string): boolean {
	return /^tool:\S+$/.test(pattern);
}

function effectRank(effect: TgSecRuleEffect): number {
	return EFFECT_RANK.indexOf(effect);
}

/** deny beats ask beats allow; within one effect the highest priority wins; a tie keeps the earlier declaration. */
function outranks(a: { rule: TgSecRule; order: number }, b: { rule: TgSecRule; order: number }): boolean {
	const rankA = effectRank(a.rule.effect);
	const rankB = effectRank(b.rule.effect);
	if (rankA !== rankB) return rankA < rankB;
	if (a.rule.priority !== b.rule.priority) return a.rule.priority > b.rule.priority;
	return a.order < b.order;
}

/**
 * Compile the table. The engine is fail-closed on itself: an empty or duplicate `id`, a non
 * `tool:<name>` pattern, an effect outside allow/deny/ask, a `priority` that is not a finite
 * integer, or a non-boolean `enabled` all throw here rather than silently mis-match later.
 */
export function createTgSecRuleTable(rules: readonly TgSecRule[]): TgSecRuleTable {
	const compiled: { readonly rule: TgSecRule; readonly test: RegExp; readonly order: number }[] = [];
	const seen = new Set<string>();
	for (const [order, rule] of rules.entries()) {
		if (typeof rule.id !== "string" || rule.id.trim() === "") {
			throw new TypeError(`intercept rule at index ${order} has an empty id; ids must be non-empty and unique`);
		}
		if (seen.has(rule.id)) throw new TypeError(`duplicate intercept rule id "${rule.id}"`);
		seen.add(rule.id);
		if (typeof rule.pattern !== "string" || !isToolPattern(rule.pattern)) {
			throw new TypeError(
				`intercept rule "${rule.id}" pattern ${JSON.stringify(rule.pattern)} is not a tool:<name> pattern: it must start with "tool:" followed by at least one non-space character`,
			);
		}
		if (rule.effect !== "allow" && rule.effect !== "deny" && rule.effect !== "ask") {
			throw new TypeError(
				`intercept rule "${rule.id}" has effect ${JSON.stringify(rule.effect)}, expected "allow", "deny", or "ask"`,
			);
		}
		if (!Number.isInteger(rule.priority)) {
			throw new TypeError(
				`intercept rule "${rule.id}" priority ${JSON.stringify(rule.priority)} is not a finite integer`,
			);
		}
		if (typeof rule.enabled !== "boolean") {
			throw new TypeError(`intercept rule "${rule.id}" enabled must be a boolean (set true or false)`);
		}
		if (rule.note !== undefined && typeof rule.note !== "string") {
			throw new TypeError(`intercept rule "${rule.id}" note must be a string when present`);
		}
		compiled.push({ rule, test: wildcardToRegExp(rule.pattern), order });
	}
	const armed = compiled.filter((entry) => entry.rule.enabled);
	return {
		match: (resource: string): TgSecRule | undefined => {
			let winner: { rule: TgSecRule; test: RegExp; order: number } | undefined;
			for (const entry of armed) {
				if (!entry.test.test(resource)) continue;
				if (winner === undefined || outranks(entry, winner)) winner = entry;
			}
			return winner?.rule;
		},
	};
}

function parseRule(entry: unknown, index: number): TgSecRule {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new TypeError(`rules config entry ${index} is not an object`);
	}
	const raw = entry as Record<string, unknown>;
	const id = raw.id;
	if (typeof id !== "string") throw new TypeError(`rules config entry ${index} id must be a string`);
	const priority = raw.priority;
	if (typeof priority !== "number") {
		throw new TypeError(`rules config entry ${index} priority must be a number`);
	}
	const pattern = raw.pattern;
	if (typeof pattern !== "string") throw new TypeError(`rules config entry ${index} pattern must be a string`);
	const effect = raw.effect;
	if (effect !== "allow" && effect !== "deny" && effect !== "ask") {
		throw new TypeError(
			`rules config entry ${index} has effect ${JSON.stringify(effect)}, expected "allow", "deny", or "ask"`,
		);
	}
	const enabled = raw.enabled;
	if (typeof enabled !== "boolean") {
		throw new TypeError(`rules config entry ${index} enabled must be a boolean (set true or false)`);
	}
	const note = raw.note;
	if (note !== undefined && typeof note !== "string") {
		throw new TypeError(`rules config entry ${index} note must be a string when present`);
	}
	return note === undefined
		? { id, priority, pattern, effect, enabled }
		: { id, priority, pattern, effect, enabled, note };
}

/**
 * Parse the operator-side rules config (a JSON array of entries) into rules. Any failure — invalid
 * JSON, a non-array root, a wrong field type, an empty or duplicate id, a bad pattern, an effect
 * outside allow/deny/ask — throws; no entry is silently dropped, because a dropped entry would
 * quietly widen or narrow the policy. The table is compiled through `createTgSecRuleTable` on the
 * way out so a returned rule set is always loadable.
 */
export function parseTgSecRules(text: string): readonly TgSecRule[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TypeError(`rules config is not valid JSON: ${message}`);
	}
	if (!Array.isArray(parsed)) throw new TypeError("rules config must be a JSON array of entries");
	const rules = parsed.map((entry, index) => parseRule(entry, index));
	createTgSecRuleTable(rules);
	return rules;
}

/**
 * Load the table from an operator-side config file (by convention `.tiangong/rules.json`, same style
 * as the scope registry config). A missing file yields an **empty table**: no rule conclusion on any
 * call, the chain behaves exactly as it did before rules existed. A parse or validation error
 * propagates instead of half-loading. No DB persistence, no hot reload (batch 4 / product layer).
 */
export async function loadTgSecRules(path: string): Promise<TgSecRuleTable> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return createTgSecRuleTable([]);
		}
		throw error;
	}
	return createTgSecRuleTable(parseTgSecRules(text));
}
