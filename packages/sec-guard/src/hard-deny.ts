import { networkInterfaces } from "node:os";
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
	| "self-destruction.fork-bomb"
	| "self-destruction.mkfs"
	| "self-destruction.dd-device"
	| "self-destruction.power";

/** One hard-deny match: the closed rule id and a fixed reason that never quotes the request. */
export type TgSecHardDenyHit = { readonly ruleId: TgSecHardDenyRuleId; readonly reason: string };

function escapeForLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The serialized arguments in lowercase, the single text every rule matches against. */
function argumentText(request: TgSecRequest): string {
	return JSON.stringify(request.arguments ?? {}).toLowerCase();
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

type LoopbackId = "loopback-hostname" | "loopback-v4" | "loopback-v6";
type SelfDestructionId = "mkfs" | "dd-device" | "power";

const LOOPBACK_RULES: readonly (readonly [LoopbackId, RegExp])[] = [
	["loopback-hostname", /\blocalhost\b/],
	["loopback-v4", /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
	["loopback-v6", /(?:^|[^\w:])::1(?![\w:])/],
];

const SELF_DESTRUCTION_RULES: readonly (readonly [SelfDestructionId, RegExp])[] = [
	["mkfs", /\bmkfs(\.\w+)?\b(?!\.)/],
	["dd-device", /\bdd\b[^"]*\bof=\/dev\/[^"]/],
	["power", /\b(?:shutdown|reboot|poweroff)\b(?!\.)/],
];

function hitsRmRoot(text: string): boolean {
	if (!/(?:^|["'\s;&|(])rm\s/.test(text)) return false;
	if (text.includes("--no-preserve-root")) return true;
	const flags = [...text.matchAll(/(?:^|\s)-{1,2}[a-z][a-z0-9-]*(?=\s)/g)].map((match) => match[0].trim());
	const recursive = flags.some((flag) => /^-[a-z]*r[a-z]*$/.test(flag) || flag === "--recursive");
	const force = flags.some((flag) => /^-[a-z]*f[a-z]*$/.test(flag) || flag === "--force");
	const rootTarget = /(?:^|\s)\/(?:"|\*|\s|$)/.test(text);
	return recursive && force && rootTarget;
}

function hitsForkBomb(text: string): boolean {
	return text.replace(/\s+/g, "").includes(":(){:|:&};:");
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
	const text = argumentText(request);
	for (const [id, pattern] of LOOPBACK_RULES) {
		if (pattern.test(text)) {
			return { ruleId: `self-protection.${id}`, reason: "hard deny: loopback targets are platform self-protection" };
		}
	}
	for (const address of hostAddresses) {
		if (new RegExp(`(?<![\\w.])${escapeForLiteral(address.toLowerCase())}(?![\\w.])`).test(text)) {
			return {
				ruleId: "self-protection.local-interface",
				reason: "hard deny: this machine's own interface addresses are platform self-protection",
			};
		}
	}
	if (hitsRmRoot(text)) {
		return {
			ruleId: "self-destruction.rm-root",
			reason: "hard deny: recursive forced removal of the filesystem root",
		};
	}
	if (hitsForkBomb(text)) {
		return { ruleId: "self-destruction.fork-bomb", reason: "hard deny: fork bomb" };
	}
	for (const [id, pattern] of SELF_DESTRUCTION_RULES) {
		if (pattern.test(text)) {
			return {
				ruleId: `self-destruction.${id}`,
				reason: "hard deny: this command text is machine self-destruction",
			};
		}
	}
	return undefined;
}
