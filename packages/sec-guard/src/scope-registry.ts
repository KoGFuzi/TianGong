import { readFile } from "node:fs/promises";

/**
 * A scope entry kind. The registry only ever sees a candidate **host** string — the authority
 * `extractConnectionTargets` produces after userinfo, port and IPv6 brackets are stripped — so every
 * kind here consumes exactly that form. There is deliberately no URL/path kind: after the extraction
 * has authority-ized a candidate, a path or query is never present to match, so such a kind would be
 * dead code that can never be fed. The set below is the whole matching surface for scope.
 */
export type TgSecScopeKind = "exact-host" | "suffix-domain" | "fuzzy-host" | "cidr4" | "cidr6";

/** The polarity of a scope entry. Deny outranks allow: see `TgSecScopeRegistry.outcome`. */
export type TgSecScopeEffect = "allow" | "deny";

/** One registry entry. `enabled: false` entries are compiled but skipped at match time. */
export type TgSecScopeRule = {
	readonly kind: TgSecScopeKind;
	readonly pattern: string;
	readonly effect: TgSecScopeEffect;
	readonly enabled: boolean;
};

/** The verdict for one candidate host: denied by a rule, allowed by a rule, or matched by nothing. */
export type TgSecScopeVerdict =
	| { readonly state: "denied"; readonly rule: TgSecScopeRule }
	| { readonly state: "allowed"; readonly rule: TgSecScopeRule }
	| { readonly state: "unlisted" };

/**
 * The registered set of hosts a campaign may talk to. `contains` is the boolean shape the resolver
 * seam has always exposed (and what older callers consume); `outcome` adds the precedence result and
 * the matching rule so the resolver can tell a human *why* a host was refused — denied by a named
 * rule, or simply never allowed.
 *
 * This engine consumes only host strings. It never touches a request's `arguments` or the raw command
 * surface; the single extraction that feeds it lives in `command-text.ts`. That is what keeps the
 * "no two text-matching surfaces" rule checkable rather than conventional (see `test/boundary.test.ts`).
 */
export interface TgSecScopeRegistry {
	/** True when the host is permitted: it matches an enabled allow entry and no enabled deny entry. */
	contains(host: string): boolean;
	/** The full precedence result, so a reason can name the deny rule that fired. */
	outcome(host: string): TgSecScopeVerdict;
}

const MAX_IPV4 = 0xffffffffn;
const MAPPED_V6_PREFIX = 0xffffn << 32n;
const IPV4_DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Parse a dotted-quad IPv4 into its 32-bit value, or undefined if it is not a bare IPv4 literal. */
function ipv4Value(text: string): bigint | undefined {
	const parts = text.split(".");
	if (parts.length !== 4) return undefined;
	let value = 0n;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		value = (value << 8n) | BigInt(octet);
	}
	return value;
}

/** Expand one side of an address into 16-bit groups; an embedded IPv4 tail only counts on the final side. */
function expandIpv6Side(tokens: readonly string[], mayEndInV4: boolean): number[] | undefined {
	const groups: number[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.includes(".")) {
			if (!mayEndInV4 || i !== tokens.length - 1) return undefined;
			const v4 = ipv4Value(token);
			if (v4 === undefined) return undefined;
			groups.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
			continue;
		}
		if (!/^[0-9a-f]{1,4}$/.test(token)) return undefined;
		groups.push(Number.parseInt(token, 16));
	}
	return groups;
}

function groupsTo128(groups: readonly number[]): bigint {
	let value = 0n;
	for (const group of groups) value = (value << 16n) | BigInt(group);
	return value;
}

/** Parse a full or compressed IPv6 address (with optional embedded IPv4) into its 128-bit value. */
function ipv6Value(text: string): bigint | undefined {
	const lower = text.toLowerCase();
	if (lower === "" || !/^[0-9a-f:.]+$/.test(lower)) return undefined;
	const halves = lower.split("::");
	if (halves.length > 2) return undefined;
	const headTokens = halves[0] === "" ? [] : halves[0].split(":");
	if (halves.length === 1) {
		const groups = expandIpv6Side(headTokens, true);
		if (groups === undefined || groups.length !== 8) return undefined;
		return groupsTo128(groups);
	}
	const tailTokens = halves[1] === "" ? [] : halves[1].split(":");
	const head = expandIpv6Side(headTokens, false);
	const tail = expandIpv6Side(tailTokens, true);
	if (head === undefined || tail === undefined) return undefined;
	if (head.length + tail.length > 7) return undefined;
	const zeros = Array.from({ length: 8 - head.length - tail.length }, () => 0);
	return groupsTo128([...head, ...zeros, ...tail]);
}

/** True for an IPv4-mapped address (`::ffff:a.b.c.d`): the top 96 bits are zero and bits 32-47 are ffff. */
function isMappedV4(value: bigint): boolean {
	return value >> 32n === 0xffffn;
}

/** The 32-bit value of a host, reading a bare IPv4 or an IPv4-mapped IPv6; undefined for anything else. */
function hostToV4(host: string): bigint | undefined {
	const v4 = ipv4Value(host);
	if (v4 !== undefined) return v4;
	const v6 = ipv6Value(host);
	if (v6 !== undefined && isMappedV4(v6)) return v6 & MAX_IPV4;
	return undefined;
}

/** The 128-bit value of a host, mapping a bare IPv4 up to `::ffff:a.b.c.d`; undefined for a non-IP. */
function hostToV6(host: string): bigint | undefined {
	const v6 = ipv6Value(host);
	if (v6 !== undefined) return v6;
	const v4 = ipv4Value(host);
	if (v4 !== undefined) return MAPPED_V6_PREFIX | v4;
	return undefined;
}

function renderV4(value: bigint): string {
	return [value >> 24n, (value >> 16n) & 0xffn, (value >> 8n) & 0xffn, value & 0xffn]
		.map((octet) => String(octet & 0xffn))
		.join(".");
}

function renderV6(value: bigint): string {
	const groups: string[] = [];
	for (let i = 7; i >= 0; i--)
		groups.push(String(((value >> BigInt(16 * i)) & 0xffffn).toString(16).padStart(4, "0")));
	return groups.join(":");
}

/**
 * Canonicalize a host for exact comparison: lowercase, and any IP literal reduced to a single spelling.
 * An IPv4-mapped IPv6 collapses to its dotted form, so `1.2.3.4` and `::ffff:1.2.3.4` are the same host;
 * a non-IP is just lowercased.
 */
function canonicalHost(host: string): string {
	const lower = host.trim().toLowerCase();
	const v4 = ipv4Value(lower);
	if (v4 !== undefined) return renderV4(v4);
	const v6 = ipv6Value(lower);
	if (v6 === undefined) return lower;
	if (isMappedV4(v6)) return renderV4(v6 & MAX_IPV4);
	return renderV6(v6);
}

/** `value` and `base` share their top `prefix` bits; prefix 0 matches everything, prefix === bits is exact. */
function inNetwork(value: bigint, base: bigint, prefix: number, bits: number): boolean {
	if (prefix === 0) return true;
	const shift = BigInt(bits - prefix);
	return value >> shift === base >> shift;
}

function isHostToken(text: string): boolean {
	if (text === "" || text.includes("/") || text.includes("://") || /\s/.test(text)) return false;
	if (ipv4Value(text) !== undefined || ipv6Value(text) !== undefined) return true;
	return text.split(".").every((label) => IPV4_DOMAIN_LABEL.test(label));
}

/** A compiled entry: the original rule plus a host predicate. Invalid patterns throw at compile time. */
function compileRule(rule: TgSecScopeRule): (host: string) => boolean {
	const pattern = rule.pattern.trim().toLowerCase();
	switch (rule.kind) {
		case "exact-host": {
			if (!isHostToken(pattern)) {
				throw new TypeError(`scope entry "${rule.pattern}" is not a valid exact-host pattern`);
			}
			const want = canonicalHost(pattern);
			return (host) => canonicalHost(host) === want;
		}
		case "suffix-domain": {
			if (!DOMAIN_PATTERN.test(pattern)) {
				throw new TypeError(`scope entry "${rule.pattern}" is not a valid suffix-domain pattern`);
			}
			const dotted = `.${pattern}`;
			return (host) => {
				const h = host.trim().toLowerCase();
				return h === pattern || h.endsWith(dotted);
			};
		}
		case "fuzzy-host": {
			if (pattern === "" || /\s/.test(pattern)) {
				throw new TypeError(`scope entry "${rule.pattern}" is not a valid fuzzy-host pattern`);
			}
			// Substring containment, deliberately broad: it aggregates assets whose host names share a
			// fragment. That breadth is its cost — "example" also matches "notexample.com" and any host
			// merely containing it. It exists for asset rollups, not for tight perimeters; operators
			// choosing it accept that false-positive surface, which is why it sits alongside suffix-domain.
			return (host) => host.toLowerCase().includes(pattern);
		}
		case "cidr4": {
			const { base, prefix } = parseCidr(rule.kind, pattern, 32, ipv4Value);
			return (host) => {
				const value = hostToV4(host);
				return value !== undefined && inNetwork(value, base, prefix, 32);
			};
		}
		case "cidr6": {
			const { base, prefix } = parseCidr(rule.kind, pattern, 128, ipv6Value);
			return (host) => {
				const value = hostToV6(host);
				return value !== undefined && inNetwork(value, base, prefix, 128);
			};
		}
		default: {
			const kind: never = rule.kind;
			throw new TypeError(`unknown scope entry kind ${JSON.stringify(kind)}`);
		}
	}
}

function parseCidr(
	kind: TgSecScopeKind,
	pattern: string,
	bits: number,
	parse: (text: string) => bigint | undefined,
): { base: bigint; prefix: number } {
	const slash = pattern.lastIndexOf("/");
	if (slash <= 0 || slash === pattern.length - 1) {
		throw new TypeError(`scope entry "${pattern}" is not a valid ${kind} CIDR`);
	}
	const base = parse(pattern.slice(0, slash));
	if (base === undefined) throw new TypeError(`scope entry "${pattern}" has an invalid ${kind} base address`);
	const prefixText = pattern.slice(slash + 1);
	if (!/^\d{1,3}$/.test(prefixText)) throw new TypeError(`scope entry "${pattern}" has an invalid prefix length`);
	const prefix = Number(prefixText);
	if (prefix > bits) throw new TypeError(`scope entry "${pattern}": prefix ${prefix} exceeds ${kind}'s ${bits} bits`);
	return { base, prefix };
}

/** Build a registry from entries. Invalid kinds or patterns throw — the engine is fail-closed on itself. */
export function createTgSecScopeRegistry(rules: readonly TgSecScopeRule[]): TgSecScopeRegistry {
	const compiled = rules.map((rule) => {
		if (rule.effect !== "allow" && rule.effect !== "deny") {
			throw new TypeError(`scope entry "${rule.pattern}" has effect ${JSON.stringify(rule.effect)}, not allow/deny`);
		}
		return { rule, matches: compileRule(rule) };
	});
	const enabled = compiled.filter((entry) => entry.rule.enabled);
	const denies = enabled.filter((entry) => entry.rule.effect === "deny");
	const allows = enabled.filter((entry) => entry.rule.effect === "allow");
	const verdict = (host: string): TgSecScopeVerdict => findVerdict(denies, allows, host);
	return {
		contains: (host) => verdict(host).state === "allowed",
		outcome: verdict,
	};
}

function findVerdict(
	denies: readonly { rule: TgSecScopeRule; matches: (host: string) => boolean }[],
	allows: readonly { rule: TgSecScopeRule; matches: (host: string) => boolean }[],
	host: string,
): TgSecScopeVerdict {
	for (const entry of denies) {
		if (entry.matches(host)) return { state: "denied", rule: entry.rule };
	}
	for (const entry of allows) {
		if (entry.matches(host)) return { state: "allowed", rule: entry.rule };
	}
	return { state: "unlisted" };
}

function parseRule(entry: unknown, index: number): TgSecScopeRule {
	if (typeof entry !== "object" || entry === null) {
		throw new TypeError(`scope config entry ${index} is not an object`);
	}
	const raw = entry as Record<string, unknown>;
	const kind = raw.kind;
	if (
		kind !== "exact-host" &&
		kind !== "suffix-domain" &&
		kind !== "fuzzy-host" &&
		kind !== "cidr4" &&
		kind !== "cidr6"
	) {
		throw new TypeError(`scope config entry ${index} has unknown kind ${JSON.stringify(kind)}`);
	}
	const effect = raw.effect;
	if (effect !== "allow" && effect !== "deny") {
		throw new TypeError(
			`scope config entry ${index} has effect ${JSON.stringify(effect)}, expected "allow" or "deny"`,
		);
	}
	const pattern = raw.pattern;
	if (typeof pattern !== "string") throw new TypeError(`scope config entry ${index} pattern must be a string`);
	const enabled = raw.enabled;
	if (typeof enabled !== "boolean") {
		throw new TypeError(`scope config entry ${index} enabled must be a boolean (set true or false)`);
	}
	// Validate the pattern by compiling it; a bad pattern throws here rather than silently never matching.
	compileRule({ kind, pattern, effect, enabled });
	return { kind, pattern, effect, enabled };
}

/**
 * Parse the operator-side scope config (a JSON array of entries) into rules. Any failure — invalid JSON,
 * a non-array root, an unknown kind, a bad pattern or prefix, an effect outside allow/deny — throws;
 * no entry is silently dropped, because a dropped entry would quietly widen or narrow the perimeter.
 */
export function parseTgSecScopeConfig(text: string): readonly TgSecScopeRule[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TypeError(`scope config is not valid JSON: ${message}`);
	}
	if (!Array.isArray(parsed)) throw new TypeError("scope config must be a JSON array of entries");
	return parsed.map((entry, index) => parseRule(entry, index));
}

/**
 * Load the registry from an operator-side config file (by convention `.tiangong/scope.json`). A missing
 * file yields an **empty-allow registry**: scope registration is the only source of permission, so no
 * host is allowed and every network target becomes a forced ask. That fail-closed default is deliberate
 * (it is not a "whitelist disabled" fallback); a parse or pattern error propagates instead of half-loading.
 */
export async function loadTgSecScopeRegistry(path: string): Promise<TgSecScopeRegistry> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return createTgSecScopeRegistry([]);
		}
		throw error;
	}
	return createTgSecScopeRegistry(parseTgSecScopeConfig(text));
}
