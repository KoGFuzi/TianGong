import type { Context } from "@OnePanda-TgSec/chord";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { Type } from "typebox";

/** One tool's availability, exactly as the local shell reported it. */
export type LocalToolCheckEntry = {
	readonly name: string;
	readonly path: string;
	readonly available: boolean;
	/** The first line of `<path> --version`; empty when the program has no `--version` or `timeout` is absent. */
	readonly version: string;
};

export const TG_SEC_LOCAL_TOOL_CHECK_LIMIT = 32;

const VERSION_TIMEOUT_SECONDS = 3;
const PROBE_TIMEOUT_SECONDS = 20;
const MAX_VERSION_CHARS = 200;

const localToolCheckSchema = Type.Object({
	tools: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: TG_SEC_LOCAL_TOOL_CHECK_LIMIT,
		description: "Executable names to probe, e.g. hydra, searchsploit, nmap",
	}),
});

const localToolCheckStructuredOutputSchema = Type.Object({
	tools: Type.Array(
		Type.Object({
			name: Type.String(),
			path: Type.String({ description: "The path `command -v` printed; empty when the name is not installed" }),
			available: Type.Boolean(),
			version: Type.String({ description: "The first line of `<path> --version`; empty when unknown" }),
		}),
	),
});

/**
 * One shell invocation probes every name: `command -v` for the path, then the first line of
 * `<path> --version`. Names arrive as positional parameters (`"$@"`), never interpolated into the
 * script, so a name cannot become shell syntax. `timeout` bounds a version probe that would hang; when
 * the host lacks `timeout`, the version is left empty rather than risking an unbounded call.
 */
const PROBE_SCRIPT = [
	'for name in "$@"; do',
	'\tpath=$(command -v "$name" 2>/dev/null) || path=""',
	'\tversion=""',
	'\tif [ -n "$path" ] && command -v timeout >/dev/null 2>&1; then',
	`\t\tversion=$(timeout ${VERSION_TIMEOUT_SECONDS} "$path" --version 2>&1 | head -n 1)`,
	"\tfi",
	`\tprintf '%s\\0%s\\0%s\\0' "$name" "$path" "$version"`,
	"done",
].join("\n");

function normalizeNames(raw: readonly string[]): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const value of raw) {
		const name = value.trim();
		if (name === "") throw new TypeError("local_tool_check: every tool name must be non-empty");
		if (name.includes("\0")) throw new TypeError("local_tool_check: a tool name cannot contain a NUL byte");
		if (seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	if (names.length > TG_SEC_LOCAL_TOOL_CHECK_LIMIT) {
		throw new TypeError(`local_tool_check: at most ${TG_SEC_LOCAL_TOOL_CHECK_LIMIT} names per call`);
	}
	return names;
}

function parseProbeOutput(text: string): LocalToolCheckEntry[] {
	const fields = text.split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length % 3 !== 0) throw new Error("local_tool_check: malformed probe output");
	const entries: LocalToolCheckEntry[] = [];
	for (let i = 0; i < fields.length; i += 3) {
		const name = fields[i] ?? "";
		const path = (fields[i + 1] ?? "").trim();
		const version = (fields[i + 2] ?? "").trim().split("\n")[0]?.slice(0, MAX_VERSION_CHARS) ?? "";
		entries.push({ name, path, available: path !== "", version });
	}
	return entries;
}

/**
 * Report which local executables are actually installed, in one batch: `command -v` for the path and
 * the first line of `--version` for a human-usable version. The point is to keep the model from
 * inventing tools or spending turns on a binary the host lacks. The probe runs in the call's
 * execution environment (local or host-injected remote), so it answers for the machine the campaign
 * actually acts on.
 *
 * The result is free text and stays in the tool return: nothing here becomes a span attribute.
 * Deferred by default, so the model loads it through `tool_search` when it needs availability facts.
 */
export function createLocalToolCheckTool(): ToolRegistration<typeof localToolCheckSchema> {
	return defineTool({
		name: "local_tool_check",
		description:
			"Check which local terminal tools are installed: runs `command -v` and reports the first line of `--version` for each name in one batch. Read-only; it executes no target action. Use it before planning a tool-driven step so you do not name a binary the host lacks.",
		parameters: localToolCheckSchema,
		structuredOutputSchema: localToolCheckStructuredOutputSchema,
		callers: ["model", "tools"],
		deferred: true,
		replay: "safe",
		async execute(args, api, context: Context): Promise<ToolExecutionResult> {
			const names = normalizeNames(args.tools);
			const env = api.env;
			if (env === undefined) throw new Error("No execution environment is configured");
			let text = "";
			const result = await env.exec(
				["sh", "-c", PROBE_SCRIPT, "sh", ...names],
				{
					timeout: PROBE_TIMEOUT_SECONDS,
					onOutput: (chunk) => {
						text += chunk;
					},
				},
				context,
			);
			if (!result.ok) throw result.error;
			const tools = parseProbeOutput(text);
			api.output(
				tools
					.map((tool) =>
						tool.available
							? `${tool.name}: ${tool.path}${tool.version === "" ? "" : ` (${tool.version})`}`
							: `${tool.name}: not found`,
					)
					.join("\n"),
			);
			return { structuredOutput: { tools } };
		},
	});
}
