import type { TgSecRequest } from "./types.ts";

/**
 * One lexical token of a command text: the token's text (quotes stripped) and whether it sits at
 * a command position — the first token of a segment, or a token right after `;`, `&&`, `||`, `|`,
 * `&`, a newline, or `$(`.
 */
export type TgSecToken = { text: string; commandPosition: boolean };

/**
 * How firmly a candidate host is known to be a connection target.
 *
 * - **`strong`**: the value is declared to be a target — the authority of a URL with a scheme, the
 *   value of `-u`/`--url`/`--host` (including the attached `--url=` form), or the whole value of a
 *   parameter whose name declares a connection target (`url`, `host`, `target`, ...). Platform
 *   self-protection hard-denies these.
 * - **`weak`**: a bare token that merely has the shape of a host (`127.0.0.1`, `localhost`, a bare
 *   IPv6, a bare domain) inside command text. Such a token may be a search pattern, an argument to
 *   a command that never connects, or anything else, so it never hard-denies: it forces an ask.
 *
 * Both tiers participate in scope-registry comparison; the tier never relaxes scope.
 */
export type TgSecTargetEvidence = "strong" | "weak";

/** One connection-target candidate and the evidence tier it was extracted on. */
export type TgSecConnectionTarget = { readonly host: string; readonly evidence: TgSecTargetEvidence };

/**
 * A token stream that participates in connection-target extraction. `declaredTarget` is the
 * parameter name's own verdict: true when the value *is* the connection target rather than command
 * text to be parsed, which makes every candidate taken from it strong.
 */
export type TgSecTargetStream = { readonly tokens: readonly TgSecToken[]; readonly declaredTarget: boolean };

/**
 * The surface hard deny matches on, built from the request's argument **values** before any
 * serialization. `values` is every string found in the arguments tree, unserialized, so JSON
 * escaping can never hide a token boundary from a rule. `streams` is one token stream per command
 * text plus one per extracted `sh -c`/`bash -c` subcommand, with wrapper prefixes accounted for —
 * the machine self-destruction rules match on it whole, because `rm -rf /` deserves to be caught
 * wherever it appears. `targetStreams` is the filtered half: only the streams whose parameter name
 * is allowed to produce connection-target candidates (see the parameter roles below), which is what
 * self-protection and the scope resolver read.
 *
 * This type is the internal carrier of both sanctioned views, not a view itself: handing it out
 * (in either direction) would let a consumer choose its own filtering and rebuild the second
 * matching face the design forbids. Module-internal by contract and checked in
 * `test/boundary.test.ts`: the only exports a matcher may take from this file are
 * `extractConnectionTargets`, `scanTextSurface`, and the command-shape helpers.
 */
export type TgSecCommandSurface = {
	readonly values: readonly string[];
	readonly streams: readonly (readonly TgSecToken[])[];
	readonly targetStreams: readonly TgSecTargetStream[];
};

/**
 * How the name of the parameter a string value sits under qualifies that value. The nearest key wins:
 * a nested object's own keys decide its values, while an array passes its own key's role down to
 * every element.
 */
type ParameterRole = "command-text" | "declared-target" | "detail";

/**
 * Parameter names whose string values are declared connection targets, so a host-shaped value is
 * strong evidence on the parameter name alone — the non-shell analogue of the `-u`/`--url`/`--host`
 * flags, which are strong for exactly the same reason.
 */
const TARGET_VALUE_PARAMETERS = new Set([
	"url",
	"uri",
	"urls",
	"uris",
	"host",
	"hosts",
	"hostname",
	"hostnames",
	"target",
	"targets",
	"domain",
	"domains",
	"endpoint",
	"endpoints",
	"address",
	"addresses",
	"addr",
	"ip",
	"dest",
	"destination",
]);

/** Parameter names whose values are command text: parsed, with evidence taken from each token's role. */
const COMMAND_TEXT_PARAMETERS = new Set([
	"command",
	"commands",
	"cmd",
	"command_line",
	"commandline",
	"shell",
	"shell_command",
	"script",
	"scripts",
]);

/**
 * Parameter names whose values are document or detail payloads — report bodies, file paths, search
 * patterns, notes. They never produce connection-target candidates, which is what stops a report
 * mentioning `localhost` from being read as a connection to it.
 */
const DETAIL_PARAMETERS = new Set([
	"content",
	"contents",
	"text",
	"body",
	"file_path",
	"filepath",
	"path",
	"paths",
	"pattern",
	"query",
	"note",
	"notes",
	"message",
	"description",
]);

/**
 * The role of the value under one parameter name. A name in neither list defaults to
 * `command-text`, which is the conservative direction and a deliberate choice: missing a real
 * target costs self-protection (an unappealable miss), while treating a detail value as command text
 * costs one forced ask that a human can approve.
 */
function parameterRole(key: string): ParameterRole {
	const lowered = key.toLowerCase();
	if (TARGET_VALUE_PARAMETERS.has(lowered)) return "declared-target";
	if (COMMAND_TEXT_PARAMETERS.has(lowered)) return "command-text";
	if (DETAIL_PARAMETERS.has(lowered)) return "detail";
	return "command-text";
}

/** How deep subcommand extraction recurses into `sh -c`/`bash -c` bodies. Subcommands at this depth are still produced, deeper ones are not. */
export const TG_SEC_SUBCOMMAND_DEPTH_LIMIT = 2;

/** Commands that wrap a following `-c` string as a subcommand to re-parse. */
const SUBCOMMAND_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * Flags whose value is data: it never participates in host resolution. This list and the target
 * flags below are the single text-matching surface — hard deny's self-protection rules and the
 * scope resolver both read `extractConnectionTargets`, never their own scan (design doc,
 * 2026-10-22 narrowing: no two matching surfaces may exist).
 */
const DATA_VALUE_FLAGS = new Set([
	"-d",
	"--data",
	"--data-raw",
	"--data-binary",
	"--data-ascii",
	"--data-urlencode",
	"--form-string",
	"-F",
	"--form",
	"-H",
	"--header",
	"-b",
	"--cookie",
	"--cookie-jar",
	"-A",
	"--user-agent",
	"-e",
	"--referer",
	"--json",
	"--url-query",
	"--mail-from",
	"--mail-rcpt",
	"--aws-sigv4",
	"--oauth2-bearer",
	"-x",
	"--proxy",
	"--socks5",
	"--socks5-hostname",
	"-o",
	"-D",
	"-L",
	"-R",
]);

/**
 * Data-family flags that are boolean switches with a value of their own never taken: they do not
 * consume the following token. `-L`/`-R` have no value in curl; letting them eat the next token
 * would hide `curl -L http://localhost/` from every host rule — a hard-deny bypass, the one
 * direction the data/target split may not cut.
 */
const DATA_BOOLEAN_FLAGS = new Set(["-L", "-R"]);

/** Flags whose value is a connection target and participates in host resolution. */
const TARGET_VALUE_FLAGS = new Set(["-u", "--url", "--host"]);

const URL_HEAD = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const BARE_IPV4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
/** One IPv6 group, and the embedded IPv4 form an address may end with (`::ffff:127.0.0.1`). */
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;
const IPV4_TAIL = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;
/** Dotted labels, alphanumeric-hyphen, final label alphabetic and at least two characters. */
const BARE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/**
 * Final labels that mark a token as a filename, not a host (`report.md`, `bundle.js`). Only
 * suffixes with no realistic use as a TLD are listed; the TLD blacklist mechanism of the design
 * document stays seeded empty — that is a different registry and batch 1c's problem.
 */
const FILE_SUFFIXES = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"md",
	"txt",
	"log",
	"lock",
	"csv",
	"tsv",
	"xml",
	"yaml",
	"yml",
	"toml",
	"ini",
	"conf",
	"cfg",
	"env",
	"html",
	"htm",
	"css",
	"sql",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"py",
	"rb",
	"pl",
	"php",
	"java",
	"kt",
	"swift",
	"go",
	"rs",
	"cpp",
	"cc",
	"cxx",
	"hpp",
	"cs",
	"mm",
	"exe",
	"dll",
	"so",
	"dylib",
	"lib",
	"class",
	"jar",
	"war",
	"apk",
	"wasm",
	"deb",
	"rpm",
	"pkg",
	"zip",
	"tar",
	"gz",
	"tgz",
	"bz2",
	"xz",
	"zst",
	"rar",
	"iso",
	"img",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"svg",
	"webp",
	"ico",
	"mp3",
	"mp4",
	"avi",
	"mov",
	"wav",
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"key",
	"pem",
	"crt",
	"cer",
	"bak",
	"tmp",
	"swp",
	"orig",
]);

/** Split one stream into commands: every command-position token starts a new command. */
function splitCommands(stream: readonly TgSecToken[]): TgSecToken[][] {
	const groups: TgSecToken[][] = [];
	for (const token of stream) {
		if (token.commandPosition || groups.length === 0) groups.push([]);
		groups[groups.length - 1].push(token);
	}
	return groups;
}

/** The host part of a URL: after the scheme, up to the first delimiter, minus userinfo and port. */
function authorityOf(url: string): string {
	const rest = url.slice(url.indexOf("://") + 3);
	const cut = rest.search(/[/?#]/);
	const authority = cut === -1 ? rest : rest.slice(0, cut);
	const at = authority.lastIndexOf("@");
	const hostPart = at === -1 ? authority : authority.slice(at + 1);
	if (hostPart.startsWith("[")) {
		const close = hostPart.indexOf("]");
		return close === -1 ? hostPart.slice(1) : hostPart.slice(1, close);
	}
	const colon = hostPart.lastIndexOf(":");
	return colon === -1 ? hostPart : hostPart.slice(0, colon);
}

/**
 * A bare IPv6 token: bracketed with an optional port (`[::1]:8080`) or plain (`::1`), else undefined.
 * Structural rather than one monster regex: at most one `::` run, every group hex with an optional
 * embedded-IPv4 tail, and a group count that can still fill eight — which is what keeps `12:30` and
 * a `key:value` pair out of the candidate set while `2001:db8::1` stays in it.
 */
function bareIpv6Host(token: string): string | undefined {
	if (token.startsWith("[")) {
		const close = token.indexOf("]");
		if (close === -1) return undefined;
		const tail = token.slice(close + 1);
		if (tail !== "" && !/^:[0-9]+(?:[/?#].*)?$/.test(tail)) return undefined;
		return bareIpv6Host(token.slice(1, close));
	}
	if (!token.includes(":")) return undefined;
	const runs = token.split("::");
	if (runs.length > 2) return undefined;
	const groups = runs.filter((run) => run !== "").flatMap((run) => run.split(":"));
	if (groups.length === 0) return undefined;
	const hasIpv4Tail = IPV4_TAIL.test(groups[groups.length - 1]);
	const hexGroups = hasIpv4Tail ? groups.slice(0, -1) : groups;
	if (!hexGroups.every((group) => IPV6_GROUP.test(group))) return undefined;
	// An embedded IPv4 stands for two groups; a `::` run stands for at least one, so a compressed
	// address never reaches eight listed groups.
	const counted = hexGroups.length + (hasIpv4Tail ? 2 : 0);
	if (runs.length === 2 ? counted >= 8 : counted !== 8) return undefined;
	return token;
}

/** Judge one token by the candidate shapes: URL (authority only), bare IPv4, the reserved name, bare IPv6, bare domain. */
function addTarget(text: string, strong: boolean, out: Map<string, TgSecTargetEvidence>): void {
	const token = text.toLowerCase();
	if (token === "") return;
	if (URL_HEAD.test(token)) {
		const host = authorityOf(token);
		if (host !== "") recordTarget(out, host, "strong");
		return;
	}
	const tier: TgSecTargetEvidence = strong ? "strong" : "weak";
	if (BARE_IPV4.test(token) || token === "localhost") {
		recordTarget(out, token, tier);
		return;
	}
	const ipv6 = bareIpv6Host(token);
	if (ipv6 !== undefined) {
		recordTarget(out, ipv6, tier);
		return;
	}
	if (BARE_DOMAIN.test(token)) {
		const suffix = token.slice(token.lastIndexOf(".") + 1);
		if (!FILE_SUFFIXES.has(suffix)) recordTarget(out, token, tier);
	}
}

/** A host seen twice keeps the stronger of the two verdicts. */
function recordTarget(out: Map<string, TgSecTargetEvidence>, host: string, evidence: TgSecTargetEvidence): void {
	if (out.get(host) === "strong") return;
	out.set(host, evidence);
}

/** Walk one command's tokens: consume data-flag values, resolve target-flag values, judge bare tokens. */
function scanCommand(
	tokens: readonly TgSecToken[],
	declaredTarget: boolean,
	out: Map<string, TgSecTargetEvidence>,
): void {
	for (let i = 0; i < tokens.length; i++) {
		const lowered = tokens[i].text.toLowerCase();
		if (TARGET_VALUE_FLAGS.has(lowered)) {
			if (i + 1 < tokens.length) addTarget(tokens[i + 1].text, true, out);
			i += 1;
			continue;
		}
		if (lowered.startsWith("--")) {
			const eq = lowered.indexOf("=");
			if (eq > 2) {
				const flag = lowered.slice(0, eq);
				if (DATA_VALUE_FLAGS.has(flag)) continue;
				if (TARGET_VALUE_FLAGS.has(flag)) addTarget(tokens[i].text.slice(eq + 1), true, out);
				continue;
			}
		}
		if (DATA_VALUE_FLAGS.has(lowered)) {
			if (!DATA_BOOLEAN_FLAGS.has(lowered)) i += 1;
			continue;
		}
		addTarget(tokens[i].text, declaredTarget, out);
	}
}

/**
 * Host/authority candidates of a request, with the evidence tier each was extracted on, from the
 * token streams `extractCommandSurface` filters to command-flavored parameters (including recursive
 * `sh -c`/`bash -c` subcommands up to the depth limit): bare tokens that are not a data-flag value,
 * plus the values of `-u`/`--url`/`--host`. URLs contribute their authority only — path and query
 * are payload, not target.
 *
 * The command-position token itself is judged too, not skipped: a non-shell tool's `url` argument
 * arrives as a single token, and treating it as a command name would hide HTTP-request tools'
 * targets from self-protection. Shell command names (`curl`, `rm`, `sh`) match none of the
 * candidate shapes, so this costs nothing there. What the batch 1b rule could not tell apart was a
 * token that *is* a target from a token that merely *looks* like one — that is what the evidence
 * tier now says, and it is the criterion self-protection and the scope resolver read.
 *
 * This is the package's single host-matching surface. `extractCommandSurface` and
 * `connectionTargetsFromSurface` are module-internal and deliberately not re-exported from
 * `index.ts`: handing them out would let a consumer skip the filter and scan the raw values or
 * streams itself, reintroducing the second matching face the design forbids. Consumers take hosts
 * from here; the scope registry consumes those host strings and nothing else.
 */
export function connectionTargetsFromSurface(surface: TgSecCommandSurface): readonly TgSecConnectionTarget[] {
	const out = new Map<string, TgSecTargetEvidence>();
	for (const stream of surface.targetStreams) {
		for (const command of splitCommands(stream.tokens)) scanCommand(command, stream.declaredTarget, out);
	}
	return [...out].map(([host, evidence]) => ({ host, evidence }));
}

/** The connection targets of one request. See `connectionTargetsFromSurface` for the extraction rule. */
export function extractConnectionTargets(request: TgSecRequest): readonly TgSecConnectionTarget[] {
	return connectionTargetsFromSurface(extractCommandSurface(request));
}

/**
 * Prefixes that consume themselves (or themselves plus one argument) before the real command
 * name. Interpreter `-c`/`-e`/`-r` values (python, ruby, node, perl, php) are script bodies, not
 * subcommands: this batch does not parse them, so they are deliberately absent here and their
 * bodies participate in matching only as ordinary string values.
 */
const WRAPPER_COMMANDS = new Set([
	"env",
	"sudo",
	"nohup",
	"stdbuf",
	"nice",
	"setsid",
	"time",
	"proxychains",
	"proxychains4",
	"sshpass",
]);

const TIMEOUT_COMMAND = "timeout";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const SEPARATORS = new Set([";", "|", "&", "\n"]);

/** Split one command text into tokens, marking command positions. Quoted content is a single token and never a separator. */
export function tokenize(text: string): TgSecToken[] {
	const tokens: TgSecToken[] = [];
	let atCommandPosition = true;
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (char === "\n" || char === ";" || char === "|" || char === "&") {
			if ((char === "|" || char === "&") && text[i + 1] === char) i += 1;
			i += 1;
			atCommandPosition = true;
			continue;
		}
		if (/\s/.test(char)) {
			i += 1;
			continue;
		}
		if (char === "$" && text[i + 1] === "(") {
			i += 2;
			atCommandPosition = true;
			continue;
		}
		// A bare subshell `(...)` runs its contents like a command too, and `(` cannot appear
		// unquoted inside a shell word.
		if (char === "(") {
			i += 1;
			atCommandPosition = true;
			continue;
		}
		// `)` closes a substitution or a subshell: it ends the word before it, so `$(rm -rf /)` yields
		// the target `/` rather than `/)` and the rm rules can match it. It is not a separator: no
		// command starts after it.
		if (char === ")") {
			i += 1;
			continue;
		}
		let value = "";
		while (i < text.length) {
			const current = text[i];
			if (current === "'" || current === '"') {
				const quote = current;
				i += 1;
				while (i < text.length && text[i] !== quote) {
					if (quote === '"' && text[i] === "\\" && i + 1 < text.length) {
						value += text[i + 1];
						i += 2;
						continue;
					}
					value += text[i];
					i += 1;
				}
				i += 1;
				continue;
			}
			if (current === "\\" && i + 1 < text.length) {
				value += text[i + 1];
				i += 2;
				continue;
			}
			// `$(` can start mid-word (`echo$(rm -rf /)`); ending the word here lets the outer loop
			// open the substitution and mark its first token as a command position.
			if (current === "$" && text[i + 1] === "(") break;
			if (/\s/.test(current) || SEPARATORS.has(current)) break;
			if (current === ")") break;
			value += current;
			i += 1;
		}
		tokens.push({ text: value, commandPosition: atCommandPosition });
		atCommandPosition = false;
	}
	return tokens;
}

/**
 * Re-annotate a token stream for wrapper skipping: starting at every command-position token, a run
 * of wrapper commands (`sudo`, `proxychains4`, ...), leading `VAR=value` assignments, and
 * `timeout <duration>` (two tokens) is passed over, and the surviving token is marked as at
 * command position. The wrapper tokens themselves are kept.
 */
function withWrappersSkipped(tokens: readonly TgSecToken[]): TgSecToken[] {
	const out = tokens.map((token) => ({ ...token }));
	for (let i = 0; i < out.length; i++) {
		if (!out[i].commandPosition) continue;
		let j = i;
		for (;;) {
			const token = out[j];
			if (token === undefined) break;
			if (token.text === TIMEOUT_COMMAND) {
				j += 2;
				continue;
			}
			if (WRAPPER_COMMANDS.has(token.text) || ASSIGNMENT.test(token.text)) {
				j += 1;
				continue;
			}
			break;
		}
		if (j > i && j < out.length) out[j].commandPosition = true;
	}
	return out;
}

/** Produce the token stream for one command text and recurse into its `sh -c`/`bash -c` subcommands. */
function pushStreams(text: string, depth: number, streams: TgSecToken[][]): void {
	const tokens = withWrappersSkipped(tokenize(text));
	streams.push(tokens);
	if (depth >= TG_SEC_SUBCOMMAND_DEPTH_LIMIT) return;
	for (let i = 0; i + 1 < tokens.length; i++) {
		if (!tokens[i].commandPosition || !SUBCOMMAND_SHELLS.has(tokens[i].text)) continue;
		const body = subcommandShellBody(tokens, i);
		if (body === undefined) continue;
		pushStreams(body, depth + 1, streams);
	}
}

/**
 * The body of a subcommand-shell invocation whose shell token sits at `shellIndex`, or `undefined`
 * when the shell was not asked to run one. Shells accept `-c` fused into a short-flag cluster
 * (`bash -lc '...'`, `sh -ic '...'`) and behind other flags (`bash -l -c '...'`), so the flag run is
 * walked instead of demanding the literal next token `-c`: any short-cluster flag carrying `c`
 * arms the body, `--flag value` pairs step over their value, and the first non-flag token after the
 * run is the body. A bare `bash script.sh` never arms it.
 */
function subcommandShellBody(tokens: readonly TgSecToken[], shellIndex: number): string | undefined {
	let sawCommandFlag = false;
	let i = shellIndex + 1;
	while (i < tokens.length) {
		const text = tokens[i].text;
		if (!text.startsWith("-")) break;
		if (text.startsWith("--")) {
			// No long flag of the supported shells means `-c`, so a `--flag value` pair is skipped
			// whole and its value is never mistaken for the body.
			if (!text.includes("=") && tokens[i + 1] !== undefined && !tokens[i + 1].text.startsWith("-")) i += 2;
			else i += 1;
			continue;
		}
		if (/^-[a-z]*c[a-z]*$/.test(text)) sawCommandFlag = true;
		i += 1;
	}
	if (!sawCommandFlag) return undefined;
	return tokens[i]?.text;
}

/** One leaf string of an arguments tree and the role of the parameter name it sits under. */
type CollectedValue = { readonly text: string; readonly role: ParameterRole };

/**
 * Every string inside an arguments tree, in traversal order, each tagged with the role of its
 * nearest key. Objects decide per key; arrays pass their own key's role down to every element;
 * strings are taken whole.
 */
function collectValues(value: unknown, role: ParameterRole, out: CollectedValue[]): void {
	if (typeof value === "string") {
		out.push({ text: value, role });
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectValues(item, role, out);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, item] of Object.entries(value)) collectValues(item, parameterRole(key), out);
	}
}

/**
 * Build the hard-deny matching surface for one request: raw string values, the token streams the
 * self-destruction rules match on, and the filtered streams connection targets are drawn from.
 *
 * Internal carrier of both views. Consumers take one of the two finished views instead —
 * `extractConnectionTargets` for the connection-target half, `scanTextSurface` for the text-scan
 * half — so no consumer ever holds the unfiltered `targetStreams` alongside the raw values
 * (`test/boundary.test.ts` keeps it that way).
 */
export function extractCommandSurface(request: TgSecRequest): TgSecCommandSurface {
	const collected: CollectedValue[] = [];
	collectValues(request.arguments ?? {}, "command-text", collected);
	const values: string[] = [];
	const streams: TgSecToken[][] = [];
	const targetStreams: TgSecTargetStream[] = [];
	for (const entry of collected) {
		values.push(entry.text);
		const perValue: TgSecToken[][] = [];
		pushStreams(entry.text, 0, perValue);
		streams.push(...perValue);
		if (entry.role === "detail") continue;
		const declaredTarget = entry.role === "declared-target";
		perValue.forEach((tokens, index) => {
			// Only the parameter value itself carries the name's verdict; an extracted `sh -c` body is
			// command text, where evidence comes from each token's role.
			targetStreams.push({ tokens, declaredTarget: index === 0 && declaredTarget });
		});
	}
	return { values, streams, targetStreams };
}

/**
 * One command inside a stream: its lowercased tokens and its head. Commands are produced per
 * stream, so a head is the first token of a segment **after wrapper skipping** — `sudo rm` has head
 * `rm`. Quoted content, `$(...)` innards, and extracted `sh -c` bodies are tokens/streams like any
 * other, which is what lets one rule set cover nested shells without re-parsing.
 */
export type TgSecCommandGroup = { readonly head: string; readonly tokens: readonly string[] };

/**
 * The **text-scan view** of a request: everything a payload/SQL/command-text matcher may look at,
 * as finished data. `strings` is every argument string value, `detail` keys included — the danger
 * set matches payload bodies by design, and the parameter-name filter constrains connection
 * targets, not text. `streams` is the raw token streams; `commands` is the same data already split
 * into lowercased command groups so no matcher re-implements the split and the two could drift.
 *
 * Deliberately **not** re-exported from `index.ts`: the view is package-internal (batch 2a's shape
 * decision), the host gets a guard, not a scanner. It also carries no connection targets — that is
 * the other view's job, and keeping the two apart is what stops the detail-key filter's false
 * positives (batch 1c) from being reintroduced by a future batch merging the faces.
 */
export type TgSecTextSurface = {
	readonly strings: readonly string[];
	readonly streams: readonly (readonly TgSecToken[])[];
	readonly commands: readonly TgSecCommandGroup[];
};

/** Split token streams into lowercased command groups at command positions. */
function toCommands(streams: readonly (readonly TgSecToken[])[]): TgSecCommandGroup[] {
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

/** The text-scan view of one request. See `TgSecTextSurface` for what it does and does not contain. */
export function scanTextSurface(request: TgSecRequest): TgSecTextSurface {
	const surface = extractCommandSurface(request);
	return { strings: surface.values, streams: surface.streams, commands: toCommands(surface.streams) };
}

/**
 * True when a command's flags carry both recursive and force (`-rf`, `-fr`, `-r -f`,
 * `--recursive --force`). Shared by the hard-deny rm rules and the danger rm-critical-path rule so
 * the two can never drift on what "forced recursive" means.
 */
export function hasForcedRecursiveFlags(tokens: readonly string[]): boolean {
	const flags = tokens.filter((token) => token.startsWith("-"));
	const recursive = flags.some((flag) => /^-[a-z]*r[a-z]*$/.test(flag) || flag === "--recursive");
	const force = flags.some((flag) => /^-[a-z]*f[a-z]*$/.test(flag) || flag === "--force");
	return recursive && force;
}

/** A command's non-flag arguments: everything after the head that is not an option token. */
export function nonFlagTargets(command: TgSecCommandGroup): readonly string[] {
	return command.tokens.slice(1).filter((token) => !token.startsWith("-"));
}
