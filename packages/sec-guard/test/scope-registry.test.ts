import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createTgSecScopeRegistry,
	loadTgSecScopeRegistry,
	parseTgSecScopeConfig,
	type TgSecScopeEffect,
	type TgSecScopeKind,
	type TgSecScopeRule,
} from "../src/index.ts";

function rule(kind: TgSecScopeKind, pattern: string, effect: TgSecScopeEffect = "allow"): TgSecScopeRule {
	return { kind, pattern, effect, enabled: true };
}

/** A rule the compiler must reject, written without `any`: the lie is the test. */
function badRule(over: Partial<Record<"kind" | "pattern" | "effect" | "enabled", unknown>>): TgSecScopeRule {
	return { ...rule("exact-host", "a.example"), ...over } as TgSecScopeRule;
}

describe("exact-host", () => {
	it("matches case-insensitively", () => {
		const registry = createTgSecScopeRegistry([rule("exact-host", "Target.COM")]);
		expect(registry.contains("target.com")).toBe(true);
		expect(registry.contains("TARGET.com")).toBe(true);
	});

	it("is a set, not a prefix: no suffix or wildcard drift", () => {
		const registry = createTgSecScopeRegistry([rule("exact-host", "target.com")]);
		expect(registry.contains("sub.target.com")).toBe(false);
		expect(registry.contains("target")).toBe(false);
		expect(registry.contains("target.com.evil.net")).toBe(false);
	});

	it("matches a full-form IPv6 host against a compressed registration", () => {
		const registry = createTgSecScopeRegistry([rule("exact-host", "2001:DB8::1")]);
		expect(registry.contains("2001:db8:0:0:0:0:0:1")).toBe(true);
		expect(registry.contains("2001:db8::2")).toBe(false);
	});

	it("matches the compressed host form against a full-form registration", () => {
		const registry = createTgSecScopeRegistry([rule("exact-host", "2001:db8:0:0:0:0:0:1")]);
		expect(registry.contains("2001:DB8::1")).toBe(true);
	});

	it("collapses an IPv4-mapped IPv6 to its dotted quad", () => {
		// The normalization the task demands in both directions: `::ffff:1.2.3.4` and `1.2.3.4`
		// are one host, whichever side carries the mapped form.
		const mapped = createTgSecScopeRegistry([rule("exact-host", "::ffff:1.2.3.4")]);
		expect(mapped.contains("1.2.3.4")).toBe(true);
		expect(mapped.contains("::FFFF:1.2.3.4")).toBe(true);
		const plain = createTgSecScopeRegistry([rule("exact-host", "1.2.3.4")]);
		expect(plain.contains("::ffff:1.2.3.4")).toBe(true);
	});

	it("does not grant localhost any implicit membership", () => {
		const registry = createTgSecScopeRegistry([]);
		expect(registry.contains("localhost")).toBe(false);
		expect(registry.contains("127.0.0.1")).toBe(false);
		expect(registry.contains("::1")).toBe(false);
	});

	it("answers the verdict with the matching rule attached", () => {
		const allowed = rule("exact-host", "target.com");
		const registry = createTgSecScopeRegistry([allowed]);
		const verdict = registry.outcome("target.com");
		expect(verdict.state).toBe("allowed");
		if (verdict.state === "allowed") expect(verdict.rule).toBe(allowed);
	});

	it("answers unlisted with no rule attached", () => {
		const verdict = createTgSecScopeRegistry([rule("exact-host", "target.com")]).outcome("evil.com");
		expect(verdict).toEqual({ state: "unlisted" });
	});
});

describe("suffix-domain", () => {
	it("matches the domain itself and every label beneath it", () => {
		const registry = createTgSecScopeRegistry([rule("suffix-domain", "example.com")]);
		expect(registry.contains("example.com")).toBe(true);
		expect(registry.contains("a.example.com")).toBe(true);
		expect(registry.contains("deep.a.example.com")).toBe(true);
	});

	it("respects the label boundary: notexample.com must not match", () => {
		// The classic suffix bug. Matching is `h === p || h.endsWith("." + p)`, so a host that merely
		// ends with the pattern's characters inside a longer label is refused.
		const registry = createTgSecScopeRegistry([rule("suffix-domain", "example.com")]);
		expect(registry.contains("notexample.com")).toBe(false);
		expect(registry.contains("example.com.evil.net")).toBe(false);
		expect(registry.contains("com")).toBe(false);
	});

	it("matches case-insensitively", () => {
		const registry = createTgSecScopeRegistry([rule("suffix-domain", "EXAMPLE.com")]);
		expect(registry.contains("Sub.Example.COM")).toBe(true);
	});

	it("rejects a single-label pattern: suffix-domain needs a boundary to hang on", () => {
		expect(() => createTgSecScopeRegistry([rule("suffix-domain", "com")])).toThrow(/suffix-domain/);
	});
});

describe("fuzzy-host", () => {
	it("matches by substring containment", () => {
		const registry = createTgSecScopeRegistry([rule("fuzzy-host", "corp")]);
		expect(registry.contains("corp.example.com")).toBe(true);
		expect(registry.contains("my-corp-inner")).toBe(true);
	});

	it("is deliberately broad, and its false-positive surface is part of the contract", () => {
		// Documented in scope-registry.ts: fuzzy-host exists for asset rollups, not tight perimeters.
		// A suffix-domain rule would refuse these; the substring rule matches them, and an operator who
		// registers one is opting into exactly this.
		const registry = createTgSecScopeRegistry([rule("fuzzy-host", "example")]);
		expect(registry.contains("notexample.com")).toBe(true);
		expect(registry.contains("exampl.example.org")).toBe(true);
	});

	it("matches case-insensitively", () => {
		const registry = createTgSecScopeRegistry([rule("fuzzy-host", "CoRp")]);
		expect(registry.contains("CORP.internal")).toBe(true);
	});
});

describe("cidr4", () => {
	it("covers the whole /8", () => {
		const registry = createTgSecScopeRegistry([rule("cidr4", "10.0.0.0/8")]);
		expect(registry.contains("10.9.8.7")).toBe(true);
		expect(registry.contains("10.0.0.1")).toBe(true);
	});

	it("refuses the address one bit outside the prefix", () => {
		const registry = createTgSecScopeRegistry([rule("cidr4", "10.0.0.0/8")]);
		expect(registry.contains("11.0.0.1")).toBe(false);
	});

	it("treats /32 as a single host", () => {
		const registry = createTgSecScopeRegistry([rule("cidr4", "192.168.0.1/32")]);
		expect(registry.contains("192.168.0.1")).toBe(true);
		expect(registry.contains("192.168.0.2")).toBe(false);
	});

	it("treats /0 as every IPv4 address and no name", () => {
		const registry = createTgSecScopeRegistry([rule("cidr4", "0.0.0.0/0")]);
		expect(registry.contains("8.8.8.8")).toBe(true);
		expect(registry.contains("1.2.3.4")).toBe(true);
		// A domain name is not an IPv4 value: the candidate simply never enters the comparison.
		expect(registry.contains("example.com")).toBe(false);
	});

	it("keeps the /24 boundary at the octet", () => {
		const registry = createTgSecScopeRegistry([rule("cidr4", "192.168.0.0/24")]);
		expect(registry.contains("192.168.0.255")).toBe(true);
		expect(registry.contains("192.168.1.0")).toBe(false);
	});

	it("matches an IPv4-mapped IPv6 host", () => {
		// The gateway-probe shape the task calls out: a host that arrives as `::ffff:a.b.c.d` must
		// still land inside its IPv4 network, because it is the same machine.
		const registry = createTgSecScopeRegistry([rule("cidr4", "10.0.0.0/8")]);
		expect(registry.contains("::ffff:10.9.8.7")).toBe(true);
	});

	it("rejects an octet over 255 in the base", () => {
		expect(() => createTgSecScopeRegistry([rule("cidr4", "10.0.0.256/8")])).toThrow(/invalid cidr4 base/);
	});

	it("rejects a prefix longer than 32 bits", () => {
		expect(() => createTgSecScopeRegistry([rule("cidr4", "10.0.0.0/33")])).toThrow(/exceeds cidr4's 32 bits/);
	});

	it("rejects a non-numeric or missing prefix", () => {
		expect(() => createTgSecScopeRegistry([rule("cidr4", "10.0.0.0/abc")])).toThrow(/invalid prefix length/);
		expect(() => createTgSecScopeRegistry([rule("cidr4", "10.0.0.0")])).toThrow(/not a valid cidr4 CIDR/);
		expect(() => createTgSecScopeRegistry([rule("cidr4", "10.0.0.0/")])).toThrow(/not a valid cidr4 CIDR/);
	});
});

describe("cidr6", () => {
	it("covers a /32 regardless of the host's compression or case", () => {
		const registry = createTgSecScopeRegistry([rule("cidr6", "2001:db8::/32")]);
		expect(registry.contains("2001:DB8:1:2::3")).toBe(true);
		expect(registry.contains("2001:0db8:0000:0001:0002:0000:0000:0003")).toBe(true);
	});

	it("refuses a network one increment away", () => {
		const registry = createTgSecScopeRegistry([rule("cidr6", "2001:db8::/32")]);
		expect(registry.contains("2001:db9::1")).toBe(false);
	});

	it("treats /128 as a single host across spellings", () => {
		const registry = createTgSecScopeRegistry([rule("cidr6", "2001:db8::1/128")]);
		expect(registry.contains("2001:db8:0:0:0:0:0:1")).toBe(true);
		expect(registry.contains("2001:db8::2")).toBe(false);
	});

	it("treats ::/0 as every IPv6 host, an IPv4 mapped up included", () => {
		const registry = createTgSecScopeRegistry([rule("cidr6", "::/0")]);
		expect(registry.contains("2001:db8::1")).toBe(true);
		// A bare IPv4 candidate is mapped to `::ffff:a.b.c.d` before the comparison, so a catch-all v6
		// scope covers it too. This is the same normalization that makes dual-stack perimeters work.
		expect(registry.contains("8.8.8.8")).toBe(true);
	});

	it("rejects a prefix longer than 128 bits", () => {
		expect(() => createTgSecScopeRegistry([rule("cidr6", "2001:db8::/129")])).toThrow(/exceeds cidr6's 128 bits/);
	});

	it("holds the family line: an IPv4 base under cidr6 throws", () => {
		// Pattern-side strictness: `10.0.0.0/8` is a legal cidr4 entry and an illegal cidr6 entry, so a
		// config typo cannot silently reclassify a v4 network as a v6 one.
		expect(() => createTgSecScopeRegistry([rule("cidr6", "10.0.0.0/8")])).toThrow(/invalid cidr6 base/);
	});

	it("matches a well-known prefix with an embedded IPv4 tail", () => {
		const registry = createTgSecScopeRegistry([rule("cidr6", "64:ff9b::/96")]);
		expect(registry.contains("64:ff9b::192.0.2.1")).toBe(true);
	});
});

describe("deny-over-allow precedence", () => {
	it("refuses a host that both an allow and a deny entry match", () => {
		// 定调 2: a block hit denies even when the host is also registered as allowed. This is the
		// gateway test the task demands: allow the /24, deny the gateway host inside it.
		const registry = createTgSecScopeRegistry([
			rule("cidr4", "192.168.0.0/24", "allow"),
			rule("cidr4", "192.168.0.1/32", "deny"),
		]);
		expect(registry.contains("192.168.0.1")).toBe(false);
		expect(registry.outcome("192.168.0.1")).toMatchObject({ state: "denied", rule: { pattern: "192.168.0.1/32" } });
		expect(registry.contains("192.168.0.9")).toBe(true);
	});

	it("scans every enabled deny entry before the first allow match", () => {
		// The deny is found first even though it is listed after the allow: precedence is the scan
		// order (denies, then allows), not the config order.
		const registry = createTgSecScopeRegistry([
			rule("suffix-domain", "example.com", "allow"),
			rule("exact-host", "secret.example.com", "deny"),
		]);
		expect(registry.contains("secret.example.com")).toBe(false);
		expect(registry.outcome("secret.example.com").state).toBe("denied");
		expect(registry.contains("www.example.com")).toBe(true);
	});

	it("works across kinds: an allow /0 minus a deny carve-out", () => {
		const registry = createTgSecScopeRegistry([
			rule("cidr4", "0.0.0.0/0", "allow"),
			rule("cidr4", "10.0.0.0/8", "deny"),
		]);
		expect(registry.contains("8.8.8.8")).toBe(true);
		expect(registry.contains("10.1.2.3")).toBe(false);
	});

	it("names the deny rule so a reason can quote it", () => {
		const verdict = createTgSecScopeRegistry([rule("exact-host", "10.9.8.7", "deny")]).outcome("10.9.8.7");
		expect(verdict.state).toBe("denied");
		if (verdict.state === "denied") expect(verdict.rule.kind).toBe("exact-host");
	});
});

describe("registration is the only source of permission", () => {
	it("leaves an empty registry permitting nothing at all", () => {
		// 定调 1, unlike ARTEX semantics where an empty scope means unrestricted: here an empty allow
		// set means no host has ever been permitted, so every network target is a forced ask.
		const registry = createTgSecScopeRegistry([]);
		expect(registry.contains("example.com")).toBe(false);
		expect(registry.contains("8.8.8.8")).toBe(false);
		expect(registry.outcome("8.8.8.8")).toEqual({ state: "unlisted" });
	});

	it("counts a disabled allow as absent", () => {
		const registry = createTgSecScopeRegistry([{ ...rule("exact-host", "target.com"), enabled: false }]);
		expect(registry.contains("target.com")).toBe(false);
		expect(registry.outcome("target.com")).toEqual({ state: "unlisted" });
	});

	it("skips a disabled deny without letting the host through a still-enabled allow", () => {
		// `enabled: false` removes the entry from matching altogether — the disabled deny stops
		// blocking, and the host falls to the remaining allow entry.
		const registry = createTgSecScopeRegistry([
			rule("suffix-domain", "example.com", "allow"),
			{ ...rule("exact-host", "secret.example.com", "deny"), enabled: false },
		]);
		expect(registry.contains("secret.example.com")).toBe(true);
	});
});

describe("construction-time validation", () => {
	it("throws on an unknown kind instead of accepting a dead entry", () => {
		expect(() => createTgSecScopeRegistry([badRule({ kind: "url" })])).toThrow(/unknown scope entry kind/);
	});

	it("throws on an effect outside allow/deny", () => {
		expect(() => createTgSecScopeRegistry([badRule({ effect: "maybe" })])).toThrow(/not allow\/deny/);
	});

	it("rejects an exact-host pattern that is not a host token", () => {
		for (const pattern of ["not a host", "http://example.com", "", "a/b"]) {
			expect(() => createTgSecScopeRegistry([rule("exact-host", pattern)])).toThrow(/not a valid exact-host/);
		}
	});

	it("rejects an empty or whitespace-bearing fuzzy-host pattern", () => {
		expect(() => createTgSecScopeRegistry([rule("fuzzy-host", "")])).toThrow(/not a valid fuzzy-host/);
		expect(() => createTgSecScopeRegistry([rule("fuzzy-host", "a b")])).toThrow(/not a valid fuzzy-host/);
	});

	it("validates a CIDR base that is not an address of its family", () => {
		expect(() => createTgSecScopeRegistry([rule("cidr4", "example.com/24")])).toThrow(/invalid cidr4 base/);
	});
});

describe("parseTgSecScopeConfig", () => {
	it("parses a valid config into rules", () => {
		const text = JSON.stringify([
			{ kind: "cidr4", pattern: "10.0.0.0/8", effect: "allow", enabled: true },
			{ kind: "exact-host", pattern: "10.9.8.7", effect: "deny", enabled: true },
		]);
		expect(parseTgSecScopeConfig(text)).toEqual([
			{ kind: "cidr4", pattern: "10.0.0.0/8", effect: "allow", enabled: true },
			{ kind: "exact-host", pattern: "10.9.8.7", effect: "deny", enabled: true },
		]);
	});

	it("accepts an empty array as the empty registry", () => {
		expect(parseTgSecScopeConfig("[]")).toEqual([]);
	});

	it("throws on invalid JSON rather than yielding a silent empty scope", () => {
		expect(() => parseTgSecScopeConfig("{ not json")).toThrow(/not valid JSON/);
	});

	it("throws on a non-array root", () => {
		expect(() => parseTgSecScopeConfig('{"kind": "exact-host"}')).toThrow(/must be a JSON array/);
	});

	it("throws on an unknown kind and names the entry index", () => {
		expect(() =>
			parseTgSecScopeConfig('[{"kind": "glob", "pattern": "*", "effect": "allow", "enabled": true}]'),
		).toThrow(/entry 0 has unknown kind/);
	});

	it("throws on an effect outside allow/deny", () => {
		expect(() =>
			parseTgSecScopeConfig('[{"kind": "exact-host", "pattern": "a.example", "effect": "ask", "enabled": true}]'),
		).toThrow(/effect "ask"/);
	});

	it("requires enabled to be a boolean: absence is not a default", () => {
		// A missing `enabled` silently defaulting to true or false would quietly widen or narrow the
		// perimeter against the operator's intent, so the config format forces the decision.
		expect(() =>
			parseTgSecScopeConfig('[{"kind": "exact-host", "pattern": "a.example", "effect": "allow"}]'),
		).toThrow(/enabled must be a boolean/);
	});

	it("validates the pattern of every entry, including later ones", () => {
		expect(() =>
			parseTgSecScopeConfig(
				JSON.stringify([
					{ kind: "exact-host", pattern: "a.example", effect: "allow", enabled: true },
					{ kind: "cidr4", pattern: "10.0.0.0/33", effect: "allow", enabled: true },
				]),
			),
		).toThrow(/exceeds cidr4's 32 bits/);
	});

	it("throws on a non-string pattern", () => {
		expect(() =>
			parseTgSecScopeConfig('[{"kind": "exact-host", "pattern": 7, "effect": "allow", "enabled": true}]'),
		).toThrow(/pattern must be a string/);
	});

	it("throws on an entry that is not an object", () => {
		expect(() => parseTgSecScopeConfig('["exact-host"]')).toThrow(/entry 0 is not an object/);
	});
});

describe("loadTgSecScopeRegistry", () => {
	// Each case builds its own temp directory and removes it afterwards; nothing is persisted, per the
	// batch boundary (no DB, no hot reload — that is batch 4).
	async function tempDir(): Promise<string> {
		return mkdtemp(join(tmpdir(), "tg-scope-test-"));
	}

	it("loads a valid config file into a working registry", async () => {
		const dir = await tempDir();
		try {
			const path = join(dir, "scope.json");
			await writeFile(
				path,
				JSON.stringify([{ kind: "cidr4", pattern: "203.0.113.0/24", effect: "allow", enabled: true }]),
				"utf8",
			);
			const registry = await loadTgSecScopeRegistry(path);
			expect(registry.contains("203.0.113.7")).toBe(true);
			expect(registry.contains("198.51.100.7")).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("yields an empty-allow registry for a missing file: fail closed by decision", async () => {
		// Deliberate (documented in scope-registry.ts): "no config yet" means "nothing registered", and
		// under 定调 1 nothing registered means no host is permitted — it is not a "scope disabled,
		// allow everything" fallback.
		const dir = await tempDir();
		try {
			const registry = await loadTgSecScopeRegistry(join(dir, "absent", "scope.json"));
			expect(registry.contains("example.com")).toBe(false);
			expect(registry.outcome("example.com")).toEqual({ state: "unlisted" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("propagates a corrupt config instead of half-loading", async () => {
		const dir = await tempDir();
		try {
			const path = join(dir, "scope.json");
			await writeFile(path, '{"kind": "exact-host"}', "utf8");
			await expect(loadTgSecScopeRegistry(path)).rejects.toThrow(/must be a JSON array/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
