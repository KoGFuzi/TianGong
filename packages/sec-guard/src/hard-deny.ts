import { networkInterfaces } from "node:os";
import {
	extractConnectionTargets,
	hasForcedRecursiveFlags,
	nonFlagTargets,
	scanTextSurface,
	type TgSecCommandGroup,
	type TgSecConnectionTarget,
} from "./command-text.ts";
import type { TgSecRequest } from "./types.ts";

/**
 * Every built-in hard-deny rule, by closed id. These ids are the span `rule` vocabulary. The list
 * is not configurable — that is the point; anything an operator can edit is anything an operator
 * can be talked into editing.
 */
export type TgSecHardDenyRuleId =
	| "self-protection.loopback-hostname"
	| "self-protection.loopback-v4"
	| "self-protection.loopback-v6"
	| "self-protection.local-interface"
	| "self-destruction.rm-root"
	| "self-destruction.rm-home"
	| "self-destruction.fork-bomb"
	| "self-destruction.mkfs"
	| "self-destruction.dd-device"
	| "self-destruction.power";

/** One hard-deny match: the closed rule id and a fixed reason that never quotes the request. */
export type TgSecHardDenyHit = { readonly ruleId: TgSecHardDenyRuleId; readonly reason: string };

/** The self-protection half of that vocabulary: the rules a weak-evidence candidate can trip. */
export type TgSecSelfProtectionRuleId = Extract<TgSecHardDenyRuleId, `self-protection.${string}`>;

/**
 * A self-protection match on a weak-evidence candidate: the same rule id, the host that tripped it,
 * and the reason shown to the human. It is not a deny — hard-deny reasons never quote request text,
 * while an ask has to name its target for the human to judge it.
 */
export type TgSecWeakSelfProtectionHit = {
	readonly ruleId: TgSecSelfProtectionRuleId;
	readonly host: string;
	readonly reason: string;
};

/**
 * The two rule families match different surfaces, deliberately:
 *
 * - **Self-destruction** (`rm-root`, `rm-home`, `fork-bomb`, `mkfs`, `dd-device`, `power`) is
 *   *command* semantics: a rule hits only at a command position — the head token of a command
 *   after wrapper skipping (`sudo reboot`), including inside extracted `sh -c`/`bash -c`
 *   subcommands. Hard deny has no ask channel and no appeal, so a bare word anywhere in the text
 *   would forbid the model from reading a log line (`grep shutdown /var/log/messages`) or fetching
 *   a URL containing the word. `fork-bomb` is the exception the shape forces: the construct spans
 *   tokens, so it matches whitespace-normalized command texts, not command positions.
 * - **Platform self-protection** (loopback hostname/v4/v6, local-interface) is *connection target*
 *   semantics: it matches only the hosts extracted by `extractConnectionTargets` — the same
 *   single extraction the scope resolver reads. Data-flag values, headers, and URL paths and
 *   queries never match (design doc, 2026-10-22 narrowing): SSRF and redirect test payloads are
 *   legitimate work, and hard deny has no appeal channel, so scanning all string values here was
 *   an unacceptable false-positive surface.
 *
 * Self-protection then splits on evidence tier, and this module is the only place that reads the
 * tier: a **strong** candidate that matches a rule hard-denies, a **weak** one does not appear in
 * `evaluateHardDeny` at all — `evaluateWeakSelfProtection` reports it and the guard chain turns it
 * into a forced ask. Both read the one extraction, so no second matching face exists.
 *
 * Machine self-destruction is deliberately **not** filtered by parameter name and not tiered by
 * evidence: `rm -rf /` written into a report body is still worth the unappealable block, and the
 * command-position requirement — not the filter — is what keeps a mere mention (`grep "rm -rf /"
 * notes.txt`) out of that set. The two families filter differently because they price a false
 * positive differently: a wrongly denied connection ends a task with no recourse, a wrongly denied
 * `rm -rf /` does not occur.
 *
 * Matching runs on the two finished views from `command-text.ts`: the **text-scan view**
 * (`scanTextSurface`) for the self-destruction family, and the **connection-target view**
 * (`extractConnectionTargets`) for the self-protection family. This module walks no argument tree
 * and serializes nothing itself; serializing the arguments first let JSON escaping hide token
 * boundaries from every rule, and a second traversal here would put the two-matching-faces rule
 * back to being a convention.
 */

/**
 * Addresses bound on this host's interfaces. Covers the local NIC addresses and, on a Docker host,
 * the docker0/br-* bridge addresses, without shipping a stale table of other machines' layouts.
 */
export function localInterfaceAddresses(): readonly string[] {
	const addresses: string[] = [];
	for (const infos of Object.values(networkInterfaces())) {
		for (const info of infos ?? []) {
			if (typeof info.address === "string" && info.address !== "") addresses.push(info.address);
		}
	}
	return [...new Set(addresses)];
}

const LOOPBACK_RULES: readonly (readonly [TgSecSelfProtectionRuleId, RegExp])[] = [
	["self-protection.loopback-hostname", /\blocalhost\b/],
	["self-protection.loopback-v4", /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
	["self-protection.loopback-v6", /(?:^|[^\w:])::1(?![\w:])/],
];

function escapeForLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which self-protection rule, if any, one candidate host trips. The single matcher behind both the
 * strong-evidence deny and the weak-evidence ask, so the two can never drift apart.
 */
function selfProtectionRule(host: string, hostAddresses: readonly string[]): TgSecSelfProtectionRuleId | undefined {
	const lowered = host.toLowerCase();
	for (const [id, pattern] of LOOPBACK_RULES) {
		if (pattern.test(lowered)) return id;
	}
	for (const address of hostAddresses) {
		if (new RegExp(`(?<![\\w.])${escapeForLiteral(address.toLowerCase())}(?![\\w.])`).test(lowered)) {
			return "self-protection.local-interface";
		}
	}
	return undefined;
}

function selfProtectionDenyReason(ruleId: TgSecSelfProtectionRuleId): string {
	return ruleId === "self-protection.local-interface"
		? "hard deny: this machine's own interface addresses are platform self-protection"
		: "hard deny: loopback targets are platform self-protection";
}

function weakSelfProtectionReason(ruleId: TgSecSelfProtectionRuleId, host: string): string {
	const target = `the connection target "${host}"`;
	const mayBeThisMachine =
		"matched on weak evidence: it may be this machine rather than a host being connected to, so a human decides";
	return ruleId === "self-protection.local-interface"
		? `${target} is one of this machine's own interface addresses, ${mayBeThisMachine}`
		: `${target} is a loopback address, ${mayBeThisMachine}`;
}

/** The first strong-evidence candidate that trips a self-protection rule, as a hard-deny hit. */
function strongSelfProtection(
	targets: readonly TgSecConnectionTarget[],
	hostAddresses: readonly string[],
): TgSecHardDenyHit | undefined {
	for (const target of targets) {
		if (target.evidence !== "strong") continue;
		const ruleId = selfProtectionRule(target.host, hostAddresses);
		if (ruleId === undefined) continue;
		return { ruleId, reason: selfProtectionDenyReason(ruleId) };
	}
	return undefined;
}

const POWER_COMMANDS = new Set(["shutdown", "reboot", "poweroff"]);
const MKFS_HEAD = /^mkfs(\.\w+)?$/;
/** Lowercased, because command tokens are matched lowercased: `~`, `$HOME`, `${HOME}`. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: `${home}` is a literal shell-variable match target, not a template placeholder
const HOME_TARGETS = new Set(["~", "$home", "${home}"]);

function hitsRmRoot(command: TgSecCommandGroup): boolean {
	if (command.head !== "rm") return false;
	if (command.tokens.includes("--no-preserve-root")) return true;
	return (
		hasForcedRecursiveFlags(command.tokens) &&
		nonFlagTargets(command).some((target) => target === "/" || target === "/*")
	);
}

/** `rm -rf ~`, `rm -rf $HOME`, `rm -rf ${HOME}`: same class as the root, one level of home. */
function hitsRmHome(command: TgSecCommandGroup): boolean {
	if (command.head !== "rm") return false;
	if (!hasForcedRecursiveFlags(command.tokens)) return false;
	return nonFlagTargets(command).some((target) => HOME_TARGETS.has(target.replace(/\/\*?$/, "")));
}

/**
 * `dd` outputs that destroy nothing: `/dev/null` discards its input (the standard benchmark sink),
 * and `/dev/zero` as an output target writes zeros into a device whose reads are zeros — the write
 * overwrites no real data and is harmless. Both are excluded from the device-target rule; every
 * other `of=/dev/...` still hits.
 */
const BENIGN_DD_TARGETS = new Set(["of=/dev/null", "of=/dev/zero"]);

function hitsDdDevice(command: TgSecCommandGroup): boolean {
	return (
		command.head === "dd" &&
		command.tokens.some((token) => token.startsWith("of=/dev/") && !BENIGN_DD_TARGETS.has(token))
	);
}

function hitsForkBomb(value: string): boolean {
	return value.replace(/\s+/g, "").includes(":(){:|:&};:");
}

/**
 * Deterministic matching of one request against the built-in list. Returns the first hit, or
 * `undefined`. A strong-evidence self-protection hit outranks machine self-destruction, as before; a
 * weak-evidence candidate that would have matched self-protection is not a deny here at all but a
 * forced ask, reported by `evaluateWeakSelfProtection`. `hostAddresses` is the machine's own
 * interface addresses, passed in rather than read here so the function stays pure and unit-testable;
 * the guard supplies `localInterfaceAddresses()`.
 */
export function evaluateHardDeny(
	request: TgSecRequest,
	hostAddresses: readonly string[],
): TgSecHardDenyHit | undefined {
	const protection = strongSelfProtection(extractConnectionTargets(request), hostAddresses);
	if (protection !== undefined) return protection;
	const view = scanTextSurface(request);
	const values = view.strings.map((value) => value.toLowerCase());
	const commands = view.commands;
	if (commands.some(hitsRmRoot)) {
		return {
			ruleId: "self-destruction.rm-root",
			reason: "hard deny: recursive forced removal of the filesystem root",
		};
	}
	if (commands.some(hitsRmHome)) {
		return {
			ruleId: "self-destruction.rm-home",
			reason: "hard deny: recursive forced removal of the home directory",
		};
	}
	for (const value of values) {
		if (hitsForkBomb(value)) {
			return { ruleId: "self-destruction.fork-bomb", reason: "hard deny: fork bomb" };
		}
	}
	for (const command of commands) {
		if (MKFS_HEAD.test(command.head)) {
			return {
				ruleId: "self-destruction.mkfs",
				reason: "hard deny: this command is machine self-destruction",
			};
		}
		if (hitsDdDevice(command)) {
			return {
				ruleId: "self-destruction.dd-device",
				reason: "hard deny: this command is machine self-destruction",
			};
		}
		if (POWER_COMMANDS.has(command.head)) {
			return {
				ruleId: "self-destruction.power",
				reason: "hard deny: this command is machine self-destruction",
			};
		}
	}
	return undefined;
}

/**
 * The self-protection match on a **weak-evidence** candidate: the same rules, the same single
 * extraction and the same host list as the hard deny above, restricted to the tier that is not
 * certain enough to end the call without a human. Returns the first such candidate, or `undefined`.
 * The guard chain turns a hit into `{ effect: "ask", forced: true }`, which no grant and no mode can
 * exempt; the scope resolver is not involved, so a host that ships its own resolver cannot lose this
 * rule.
 */
export function evaluateWeakSelfProtection(
	request: TgSecRequest,
	hostAddresses: readonly string[],
): TgSecWeakSelfProtectionHit | undefined {
	for (const target of extractConnectionTargets(request)) {
		if (target.evidence !== "weak") continue;
		const ruleId = selfProtectionRule(target.host, hostAddresses);
		if (ruleId === undefined) continue;
		return { ruleId, host: target.host, reason: weakSelfProtectionReason(ruleId, target.host) };
	}
	return undefined;
}
