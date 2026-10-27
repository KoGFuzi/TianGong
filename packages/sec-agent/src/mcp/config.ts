import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TgSecAgentRole } from "../role-policies.ts";
import { SEC_AGENT_ROLES } from "../role-policies.ts";

/**
 * One host-configured MCP server. `roles` narrows which role surfaces register its tools at
 * assembly time; absent means every role. `tools` are server-local tool-name patterns (`*` wildcard)
 * in the same sense as the legacy bridge's `toolExposure`, applied before the role split.
 *
 * A server is either stdio (`command`) or Streamable HTTP (`url`), never both. A missing config file
 * means no server and no error: the MCP surface is optional by design, not a connection the campaign
 * assumes at runtime.
 */
export type SecMcpServerConfig = {
	readonly name: string;
	readonly enabled?: boolean;
	readonly roles?: readonly TgSecAgentRole[];
	readonly tools?: readonly string[];
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	/**
	 * Long-lived resources this server starts. Bridges record successful `startTools` calls and call
	 * `stopTool` once per start on session close; `idField` names the start result's field carried to
	 * the stop call as `stopArgument` (default `id`).
	 */
	readonly lifecycle?: SecMcpLifecycleConfig;
};

export type SecMcpLifecycleConfig = {
	readonly startTools: readonly string[];
	readonly stopTool: string;
	readonly idField?: string;
	readonly stopArgument?: string;
};

export type SecMcpConfig = {
	readonly servers: readonly SecMcpServerConfig[];
	readonly errors: readonly string[];
	/** The file that was read, or the path that was looked for when it was absent. */
	readonly path: string;
};

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const DEFAULT_CONFIG_FILE = join(".tiangong", "mcp.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isRole(value: unknown): value is TgSecAgentRole {
	return typeof value === "string" && (SEC_AGENT_ROLES as readonly string[]).includes(value);
}

function stringList(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function roleList(value: unknown): readonly TgSecAgentRole[] | undefined {
	return Array.isArray(value) && value.every(isRole) ? value : undefined;
}

function validateLifecycle(value: unknown): SecMcpLifecycleConfig | string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "lifecycle must be an object";
	const startTools = stringList(value.startTools);
	const stopTool = value.stopTool;
	if (startTools === undefined || startTools.length === 0)
		return "lifecycle.startTools must be a non-empty string array";
	if (typeof stopTool !== "string" || stopTool.trim() === "") return "lifecycle.stopTool must be a non-empty string";
	if (value.idField !== undefined && typeof value.idField !== "string") return "lifecycle.idField must be a string";
	if (value.stopArgument !== undefined && typeof value.stopArgument !== "string") {
		return "lifecycle.stopArgument must be a string";
	}
	return {
		startTools,
		stopTool,
		...(value.idField === undefined ? {} : { idField: value.idField }),
		...(value.stopArgument === undefined ? {} : { stopArgument: value.stopArgument }),
	};
}

/** Validate one `mcpServers` entry. Returns the normalized server or an error message. */
export function validateSecMcpServer(name: string, raw: unknown): SecMcpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const command = raw.command;
	const url = raw.url;
	if (command !== undefined && typeof command !== "string") return `server "${name}": command must be a string`;
	if (url !== undefined && typeof url !== "string") return `server "${name}": url must be a string`;
	if ((command === undefined) === (url === undefined)) {
		return `server "${name}" needs exactly one of command or url`;
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		return `server "${name}": enabled must be a boolean`;
	}
	const roles = roleList(raw.roles);
	if (raw.roles !== undefined && roles === undefined) {
		return `server "${name}": roles must be a subset of ${SEC_AGENT_ROLES.join(", ")}`;
	}
	const tools = stringList(raw.tools);
	if (raw.tools !== undefined && tools === undefined) return `server "${name}": tools must be a string array`;
	if (raw.args !== undefined && stringList(raw.args) === undefined) {
		return `server "${name}": args must be a string array`;
	}
	if (raw.env !== undefined && !isStringRecord(raw.env)) return `server "${name}": env must map names to strings`;
	if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
		return `server "${name}": headers must map names to strings`;
	}
	if (raw.cwd !== undefined && typeof raw.cwd !== "string") return `server "${name}": cwd must be a string`;
	if (
		raw.timeoutMs !== undefined &&
		(typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0)
	) {
		return `server "${name}": timeoutMs must be a positive integer`;
	}
	const lifecycle = validateLifecycle(raw.lifecycle);
	if (typeof lifecycle === "string") return `server "${name}": ${lifecycle}`;
	return {
		name,
		...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
		...(roles === undefined ? {} : { roles }),
		...(tools === undefined ? {} : { tools }),
		...(command === undefined ? {} : { command }),
		...(raw.args === undefined ? {} : { args: raw.args as readonly string[] }),
		...(raw.env === undefined ? {} : { env: raw.env as Readonly<Record<string, string>> }),
		...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
		...(url === undefined ? {} : { url }),
		...(raw.headers === undefined ? {} : { headers: raw.headers as Readonly<Record<string, string>> }),
		...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
		...(lifecycle === undefined ? {} : { lifecycle }),
	};
}

/**
 * Read the host's MCP configuration. The path is, in order: `options.path`, `TG_SEC_MCP_CONFIG`, or
 * `<cwd>/.tiangong/mcp.json`. A missing file is an empty server list, not an error. A malformed
 * server is reported in `errors` and omitted; the rest of the configuration still loads, so one bad
 * entry cannot disable the whole surface.
 */
export async function loadSecMcpConfig(options: {
	readonly cwd: string;
	readonly path?: string;
	readonly env?: NodeJS.ProcessEnv;
}): Promise<SecMcpConfig> {
	const env = options.env ?? process.env;
	const override = env.TG_SEC_MCP_CONFIG;
	const path =
		options.path ?? (override !== undefined && override !== "" ? override : join(options.cwd, DEFAULT_CONFIG_FILE));
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], errors: [], path };
		return { servers: [], errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`], path };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { servers: [], errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`], path };
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		return { servers: [], errors: [`${path}: expected an object with an "mcpServers" object`], path };
	}
	const servers: SecMcpServerConfig[] = [];
	const errors: string[] = [];
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		const result = validateSecMcpServer(name, value);
		if (typeof result === "string") errors.push(`${path}: ${result}`);
		else servers.push(result);
	}
	return { servers, errors, path };
}
