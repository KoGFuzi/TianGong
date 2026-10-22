import { networkInterfaces } from "node:os";
import { connectionTargetsFromSurface, extractCommandSurface, type TgSecToken } from "./command-text.ts";
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
 *   semantics: it matches only the hosts extracted by `connectionTargetsFromSurface` — the same
 *   single extraction the scope resolver reads. Data-flag values, headers, and URL paths and
 *   queries never match (design doc, 2026-10-22 narrowing): SSRF and redirect test payloads are
 *   legitimate work, and hard deny has no appeal channel, so scanning all string values here was
 *   an unacceptable false-positive surface.
 *
 * Matching runs on the unserialized string values from `command-text.ts`; serializing the
 * arguments first let JSON escaping hide token boundaries from every rule.
 */
type Command = { readonly head: string; readonly tokens: readonly string[] };

function escapeForLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/** Split a token stream into commands: every command-position token starts a new command. */
function toCommands(streams: readonly (readonly TgSecToken[])[]): readonly Command[] {
	const groups: string[][] = [];
	for (const stream of streams) {
		let current: string[] | undefined;
		for (const token of stream) {
			if (token.commandPosition || current === undefined) {
				current = [];
				groups.push(current);
			}
			current.push(token.text.toLowerCase());
		}
	}
	return groups.map((tokens) => ({ head: tokens[0] ?? "", tokens }));
}

type LoopbackId = "loopback-hostname" | "loopback-v4" | "loopback-v6";

const LOOPBACK_RULES: readonly (readonly [LoopbackId, RegExp])[] = [
	["loopback-hostname", /\blocalhost\b/],
	["loopback-v4", /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
	["loopback-v6", /(?:^|[^\w:])::1(?![\w:])/],
];

const POWER_COMMANDS = new Set(["shutdown", "reboot", "poweroff"]);
const MKFS_HEAD = /^mkfs(\.\w+)?$/;
/** Lowercased, because command tokens are matched lowercased: `~`, `$HOME`, `${HOME}`. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: `${home}` is a literal shell-variable match target, not a template placeholder
const HOME_TARGETS = new Set(["~", "$home", "${home}"]);

function hasForcedRecursiveFlags(tokens: readonly string[]): boolean {
	const flags = tokens.filter((token) => token.startsWith("-"));
	const recursive = flags.some((flag) => /^-[a-z]*r[a-z]*$/.test(flag) || flag === "--recursive");
	const force = flags.some((flag) => /^-[a-z]*f[a-z]*$/.test(flag) || flag === "--force");
	return recursive && force;
}

function rmTargets(command: Command): readonly string[] {
	return command.tokens.slice(1).filter((token) => !token.startsWith("-"));
}

function hitsRmRoot(command: Command): boolean {
	if (command.head !== "rm") return false;
	if (command.tokens.includes("--no-preserve-root")) return true;
	return (
		hasForcedRecursiveFlags(command.tokens) && rmTargets(command).some((target) => target === "/" || target === "/*")
	);
}

/** `rm -rf ~`, `rm -rf $HOME`, `rm -rf ${HOME}`: same class as the root, one level of home. */
function hitsRmHome(command: Command): boolean {
	if (command.head !== "rm") return false;
	if (!hasForcedRecursiveFlags(command.tokens)) return false;
	return rmTargets(command).some((target) => HOME_TARGETS.has(target.replace(/\/\*?$/, "")));
}

/**
 * `dd` outputs that destroy nothing: `/dev/null` discards its input (the standard benchmark sink),
 * and `/dev/zero` as an output target writes zeros into a device whose reads are zeros — the write
 * overwrites no real data and is harmless. Both are excluded from the device-target rule; every
 * other `of=/dev/...` still hits.
 */
const BENIGN_DD_TARGETS = new Set(["of=/dev/null", "of=/dev/zero"]);

function hitsDdDevice(command: Command): boolean {
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
 * `undefined`. `hostAddresses` is the machine's own interface addresses, passed in rather than
 * read here so the function stays pure and unit-testable; the guard supplies
 * `localInterfaceAddresses()`.
 */
export function evaluateHardDeny(
	request: TgSecRequest,
	hostAddresses: readonly string[],
): TgSecHardDenyHit | undefined {
	const surface = extractCommandSurface(request);
	const values = surface.values.map((value) => value.toLowerCase());
	for (const target of connectionTargetsFromSurface(surface)) {
		for (const [id, pattern] of LOOPBACK_RULES) {
			if (pattern.test(target)) {
				return {
					ruleId: `self-protection.${id}`,
					reason: "hard deny: loopback targets are platform self-protection",
				};
			}
		}
		for (const address of hostAddresses) {
			if (new RegExp(`(?<![\\w.])${escapeForLiteral(address.toLowerCase())}(?![\\w.])`).test(target)) {
				return {
					ruleId: "self-protection.local-interface",
					reason: "hard deny: this machine's own interface addresses are platform self-protection",
				};
			}
		}
	}
	const commands = toCommands(surface.streams);
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
