import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createTgSecRuleTable,
	loadTgSecRules,
	parseTgSecRules,
	type TgSecRule,
	type TgSecRuleEffect,
} from "../src/index.ts";

function rule(
	id: string,
	pattern: string,
	effect: TgSecRuleEffect,
	priority = 0,
	extra: Partial<TgSecRule> = {},
): TgSecRule {
	return { id, priority, pattern, effect, enabled: true, ...extra };
}

/** The winner id for one resource, `undefined` rendered as "-" so absence is visible in failures. */
function winnerId(table: ReturnType<typeof createTgSecRuleTable>, resource: string): string {
	return table.match(resource)?.id ?? "-";
}

describe("wildcard grammar: the legacy semantics carried verbatim", () => {
	it("an exact pattern matches its resource and nothing else", () => {
		const table = createTgSecRuleTable([rule("r", "tool:read", "deny")]);
		expect(table.match("tool:read")?.effect).toBe("deny");
		expect(table.match("tool:shell")).toBeUndefined();
	});

	it("tool:* matches every tool resource", () => {
		const table = createTgSecRuleTable([rule("all", "tool:*", "allow")]);
		expect(table.match("tool:read")).toBeDefined();
		expect(table.match("tool:any-thing.at_all")).toBeDefined();
	});

	it("a prefix wildcard tool:n* matches names beginning with n only", () => {
		const table = createTgSecRuleTable([rule("n", "tool:n*", "deny")]);
		expect(table.match("tool:netfetch")).toBeDefined();
		expect(table.match("tool:n")).toBeDefined();
		expect(table.match("tool:read")).toBeUndefined();
	});

	it("matching is full-string anchored: fragments and superstrings miss", () => {
		const table = createTgSecRuleTable([rule("r", "tool:read", "deny")]);
		expect(table.match("ool:read")).toBeUndefined();
		expect(table.match("tool:rea")).toBeUndefined();
		expect(table.match("tool:readx")).toBeUndefined();
		expect(table.match("prefix tool:read")).toBeUndefined();
	});

	it("matching is case-sensitive in both directions", () => {
		const upper = createTgSecRuleTable([rule("u", "tool:Read", "deny")]);
		expect(upper.match("tool:read")).toBeUndefined();
		const lower = createTgSecRuleTable([rule("l", "tool:read", "deny")]);
		expect(lower.match("tool:READ")).toBeUndefined();
		expect(lower.match("tool:read")).toBeDefined();
	});

	it("* matches the empty sequence", () => {
		const table = createTgSecRuleTable([rule("s", "tool:rea*d", "deny")]);
		expect(table.match("tool:read")).toBeDefined();
		expect(table.match("tool:reard")).toBeDefined();
	});

	it("regex metacharacters in a pattern are literal, not structural", () => {
		const plus = createTgSecRuleTable([rule("p", "tool:bash+", "deny")]);
		expect(plus.match("tool:bash+")).toBeDefined();
		expect(plus.match("tool:bash")).toBeUndefined();
		const dot = createTgSecRuleTable([rule("d", "tool:bash.", "deny")]);
		expect(dot.match("tool:bash.")).toBeDefined();
		expect(dot.match("tool:bashx")).toBeUndefined();
	});

	it("? is a literal character, never a single-match wildcard", () => {
		const table = createTgSecRuleTable([rule("q", "tool:rea?", "deny")]);
		expect(table.match("tool:read")).toBeUndefined();
		expect(table.match("tool:rea?")).toBeDefined();
	});

	it("several wildcards compose in one pattern", () => {
		// The two `*` in `a*a*a` are separators, not optionality: the literal a's all have to appear
		// in order, so a host string needs three of them. Probed against the compiled regex before
		// these strings were chosen — `tool:aba` has only two and does not match.
		const table = createTgSecRuleTable([rule("m", "tool:a*a*a", "deny")]);
		expect(table.match("tool:aaba")).toBeDefined();
		expect(table.match("tool:aXaXa")).toBeDefined();
		expect(table.match("tool:aba")).toBeUndefined();
		expect(table.match("tool:ab")).toBeUndefined();
	});

	it("a pattern that does not carry the tool: namespace is rejected", () => {
		// The rule table is tool-granular by design; a leading wildcard would let one rule reach
		// beyond the tool namespace the resource is derived from.
		for (const pattern of ["*", "bash", "*:read", ":read", "tool :read"]) {
			expect(() => createTgSecRuleTable([rule("bad", pattern, "deny")]), pattern).toThrow(/tool:<name> pattern/);
		}
	});

	it("an empty or space-carrying name part is rejected", () => {
		expect(() => createTgSecRuleTable([rule("e", "tool:", "deny")])).toThrow(/tool:<name> pattern/);
		expect(() => createTgSecRuleTable([rule("s", "tool:read now", "deny")])).toThrow(/tool:<name> pattern/);
	});
});

describe("evaluation order: deny over ask over allow, absolute", () => {
	it("a deny hit wins over ask and allow hits regardless of priority", () => {
		const table = createTgSecRuleTable([
			rule("allow-first", "tool:*", "allow", 100),
			rule("ask-second", "tool:shell", "ask", 50),
			rule("deny-last", "tool:sh*", "deny", 1),
		]);
		expect(winnerId(table, "tool:shell")).toBe("deny-last");
	});

	it("an ask hit wins over the highest-priority allow", () => {
		const table = createTgSecRuleTable([
			rule("a", "tool:read", "allow", 1_000_000),
			rule("k", "tool:read", "ask", -1_000_000),
		]);
		expect(winnerId(table, "tool:read")).toBe("k");
	});

	it("priority never reorders a deny below an ask", () => {
		const table = createTgSecRuleTable([rule("d", "tool:x", "deny", 0), rule("k", "tool:x", "ask", 999)]);
		expect(winnerId(table, "tool:x")).toBe("d");
	});
});

describe("priority attribution within one effect", () => {
	it("the highest priority of the winning effect names the winner", () => {
		const table = createTgSecRuleTable([rule("low", "tool:shell", "deny", 1), rule("high", "tool:sh*", "deny", 2)]);
		expect(winnerId(table, "tool:shell")).toBe("high");
	});

	it("a priority tie keeps the earlier declaration", () => {
		const table = createTgSecRuleTable([rule("first", "tool:shell", "deny", 5), rule("second", "tool:*", "deny", 5)]);
		expect(winnerId(table, "tool:shell")).toBe("first");
	});

	it("negative priorities are finite integers like any other", () => {
		const table = createTgSecRuleTable([
			rule("deep", "tool:shell", "deny", -10),
			rule("less", "tool:shell", "deny", -5),
		]);
		expect(winnerId(table, "tool:shell")).toBe("less");
	});

	it("the winner carries its note through to the consumer", () => {
		const table = createTgSecRuleTable([rule("n", "tool:shell", "deny", 1, { note: "campaign freeze" })]);
		expect(table.match("tool:shell")?.note).toBe("campaign freeze");
	});
});

describe("enabled flag and empty tables", () => {
	it("a disabled rule never matches, so the next effect wins", () => {
		const table = createTgSecRuleTable([
			rule("off", "tool:shell", "deny", 10, { enabled: false }),
			rule("on", "tool:shell", "allow", 1),
		]);
		expect(winnerId(table, "tool:shell")).toBe("on");
	});

	it("an all-disabled table concludes nothing", () => {
		const table = createTgSecRuleTable([rule("off", "tool:*", "deny", 0, { enabled: false })]);
		expect(table.match("tool:shell")).toBeUndefined();
	});

	it("an empty table concludes nothing for any resource", () => {
		const table = createTgSecRuleTable([]);
		expect(table.match("tool:shell")).toBeUndefined();
		expect(table.match("tool:read")).toBeUndefined();
	});
});

describe("compile-time validation: the engine fails closed on itself", () => {
	it("rejects an empty or whitespace id", () => {
		expect(() => createTgSecRuleTable([rule("", "tool:read", "deny")])).toThrow(/empty id/);
		expect(() => createTgSecRuleTable([rule("   ", "tool:read", "deny")])).toThrow(/empty id/);
	});

	it("rejects duplicate ids", () => {
		expect(() => createTgSecRuleTable([rule("dup", "tool:read", "deny"), rule("dup", "tool:shell", "ask")])).toThrow(
			/duplicate intercept rule id "dup"/,
		);
	});

	it("rejects an effect outside allow/deny/ask", () => {
		const bogus = "block";
		expect(() => createTgSecRuleTable([rule("b", "tool:read", bogus as TgSecRuleEffect)])).toThrow(
			/expected "allow", "deny", or "ask"/,
		);
	});

	it("rejects a priority that is not a finite integer", () => {
		for (const priority of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, "10" as unknown as number]) {
			expect(() => createTgSecRuleTable([rule("p", "tool:read", "deny", priority)]), String(priority)).toThrow(
				/not a finite integer/,
			);
		}
	});

	it("rejects a non-boolean enabled", () => {
		expect(() =>
			createTgSecRuleTable([rule("x", "tool:read", "deny", 0, { enabled: "yes" as unknown as boolean })]),
		).toThrow(/enabled must be a boolean/);
	});

	it("rejects a non-string note", () => {
		expect(() => createTgSecRuleTable([rule("x", "tool:read", "deny", 0, { note: 7 as unknown as string })])).toThrow(
			/note must be a string/,
		);
	});
});

describe("parseTgSecRules: JSON in, validated rules out", () => {
	it("parses a valid array including the optional note", () => {
		const text = JSON.stringify([
			{ id: "a", priority: 1, pattern: "tool:read", effect: "allow", enabled: true },
			{ id: "b", priority: 2, pattern: "tool:sh*", effect: "deny", enabled: false, note: "freeze" },
		]);
		const rules = parseTgSecRules(text);
		expect(rules.length).toBe(2);
		expect(rules[1].note).toBe("freeze");
	});

	it("throws on invalid JSON", () => {
		expect(() => parseTgSecRules("{ not json")).toThrow(/not valid JSON/);
	});

	it("throws on a non-array root", () => {
		expect(() => parseTgSecRules('{"id": "a"}')).toThrow(/must be a JSON array/);
	});

	it("throws on a bad entry instead of silently skipping it", () => {
		const text = JSON.stringify([
			{ id: "good", priority: 1, pattern: "tool:read", effect: "allow", enabled: true },
			{ id: "bad", priority: 1, pattern: "tool:read", effect: "maybe", enabled: true },
		]);
		expect(() => parseTgSecRules(text)).toThrow(/entry 1 has effect "maybe"/);
	});

	it("throws on wrong field types", () => {
		const cases: Record<string, unknown>[] = [
			{ id: 1, priority: 1, pattern: "tool:read", effect: "allow", enabled: true },
			{ id: "a", priority: "1", pattern: "tool:read", effect: "allow", enabled: true },
			{ id: "a", priority: 1, pattern: 42, effect: "allow", enabled: true },
			{ id: "a", priority: 1, pattern: "tool:read", effect: "allow", enabled: "true" },
			{ id: "a", priority: 1, pattern: "tool:read", effect: "allow", enabled: true, note: 7 },
		];
		for (const entry of cases) {
			expect(() => parseTgSecRules(JSON.stringify([entry]))).toThrow(/entry 0/);
		}
		expect(() => parseTgSecRules("[3]")).toThrow(/entry 0 is not an object/);
	});

	it("validates semantics through the compile pass, not only shape", () => {
		const text = JSON.stringify([
			{ id: "x", priority: 1, pattern: "bash", effect: "allow", enabled: true },
			{ id: "x", priority: 2, pattern: "tool:read", effect: "allow", enabled: true },
		]);
		expect(() => parseTgSecRules(text)).toThrow(/tool:<name> pattern|duplicate intercept rule id/);
	});
});

describe("loadTgSecRules: the operator-side .tiangong/rules.json", () => {
	async function tempConfig(contents: string): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "tg-sec-rules-"));
		const path = join(directory, "rules.json");
		await writeFile(path, contents, "utf8");
		return path;
	}

	it("a missing file yields an empty table — no rule conclusion, the chain is untouched", async () => {
		const table = await loadTgSecRules(join(tmpdir(), "tg-sec-rules-absent", "rules.json"));
		expect(table.match("tool:read")).toBeUndefined();
	});

	it("a corrupt file throws instead of half-loading", async () => {
		const path = await tempConfig("[ {id: }");
		await expect(loadTgSecRules(path)).rejects.toThrow(/not valid JSON/);
	});

	it("an entry with an illegal pattern throws at load", async () => {
		const path = await tempConfig(
			JSON.stringify([{ id: "a", priority: 0, pattern: "read", effect: "ask", enabled: true }]),
		);
		await expect(loadTgSecRules(path)).rejects.toThrow(/tool:<name> pattern/);
	});

	it("a valid file loads a working table", async () => {
		const path = await tempConfig(
			JSON.stringify([{ id: "ops-deny", priority: 10, pattern: "tool:shell", effect: "deny", enabled: true }]),
		);
		const table = await loadTgSecRules(path);
		expect(winnerId(table, "tool:shell")).toBe("ops-deny");
		expect(table.match("tool:read")).toBeUndefined();
	});
});
