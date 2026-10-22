import type { TgSecRequest } from "./types.ts";

/**
 * One lexical token of a command text: the token's text (quotes stripped) and whether it sits at
 * a command position — the first token of a segment, or a token right after `;`, `&&`, `||`, `|`,
 * `&`, a newline, or `$(`.
 */
export type TgSecToken = { text: string; commandPosition: boolean };

/**
 * The surface hard deny matches on, built from the request's argument **values** before any
 * serialization. `values` is every string found in the arguments tree, unserialized, so JSON
 * escaping can never hide a token boundary from a rule. `streams` is one token stream per command
 * text plus one per extracted `sh -c`/`bash -c` subcommand, with wrapper prefixes accounted for.
 */
export type TgSecCommandSurface = {
	readonly values: readonly string[];
	readonly streams: readonly (readonly TgSecToken[])[];
};

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

/** Judge one token by the candidate shapes: URL (authority only), bare IPv4, the reserved name, bare domain. */
function addTarget(text: string, out: Set<string>): void {
	const token = text.toLowerCase();
	if (token === "") return;
	if (URL_HEAD.test(token)) {
		const host = authorityOf(token);
		if (host !== "") out.add(host);
		return;
	}
	if (BARE_IPV4.test(token) || token === "localhost") {
		out.add(token);
		return;
	}
	if (BARE_DOMAIN.test(token)) {
		const suffix = token.slice(token.lastIndexOf(".") + 1);
		if (!FILE_SUFFIXES.has(suffix)) out.add(token);
	}
}

/** Walk one command's tokens: consume data-flag values, resolve target-flag values, judge bare tokens. */
function scanCommand(tokens: readonly TgSecToken[], out: Set<string>): void {
	for (let i = 0; i < tokens.length; i++) {
		const lowered = tokens[i].text.toLowerCase();
		if (TARGET_VALUE_FLAGS.has(lowered)) {
			if (i + 1 < tokens.length) addTarget(tokens[i + 1].text, out);
			i += 1;
			continue;
		}
		if (lowered.startsWith("--")) {
			const eq = lowered.indexOf("=");
			if (eq > 2) {
				const flag = lowered.slice(0, eq);
				if (DATA_VALUE_FLAGS.has(flag)) continue;
				if (TARGET_VALUE_FLAGS.has(flag)) addTarget(tokens[i].text.slice(eq + 1), out);
				continue;
			}
		}
		if (DATA_VALUE_FLAGS.has(lowered)) {
			if (!DATA_BOOLEAN_FLAGS.has(lowered)) i += 1;
			continue;
		}
		addTarget(tokens[i].text, out);
	}
}

/**
 * Host/authority candidates of a request, from the same token streams `extractCommandSurface`
 * builds (including recursive `sh -c`-family subcommands up to the depth limit): bare tokens after
 * the command position that are not a data-flag value, plus the values of `-u`/`--url`/`--host`.
 * URLs contribute their authority only — path and query are payload, not target.
 *
 * The command-position token itself is judged too, not skipped: a non-shell tool's `url` argument
 * arrives as a single token, and treating it as a command name would hide HTTP-request tools'
 * targets from self-protection. Shell command names (`curl`, `rm`, `sh`) match none of the
 * candidate shapes, so this costs nothing there.
 */
export function connectionTargetsFromSurface(surface: TgSecCommandSurface): readonly string[] {
	const out = new Set<string>();
	for (const stream of surface.streams) {
		for (const command of splitCommands(stream)) scanCommand(command, out);
	}
	return [...out];
}

/** The connection targets of one request. See `connectionTargetsFromSurface` for the extraction rule. */
export function extractConnectionTargets(request: TgSecRequest): readonly string[] {
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
			if (/\s/.test(current) || SEPARATORS.has(current)) break;
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
	for (let i = 0; i + 2 < tokens.length; i++) {
		if (!tokens[i].commandPosition || !SUBCOMMAND_SHELLS.has(tokens[i].text)) continue;
		if (tokens[i + 1].text !== "-c") continue;
		pushStreams(tokens[i + 2].text, depth + 1, streams);
	}
}

/** Every string value inside an arguments tree, in traversal order. Objects and arrays recurse; strings are taken whole. */
function collectStrings(value: unknown, out: string[]): void {
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) collectStrings(item, out);
	}
}

/** Build the hard-deny matching surface for one request: raw string values plus tokenized command streams. */
export function extractCommandSurface(request: TgSecRequest): TgSecCommandSurface {
	const values: string[] = [];
	collectStrings(request.arguments ?? {}, values);
	const streams: TgSecToken[][] = [];
	for (const value of values) pushStreams(value, 0, streams);
	return { values, streams };
}
