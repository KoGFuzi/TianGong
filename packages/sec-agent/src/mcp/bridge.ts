import type { JsonValue } from "@OnePanda-TgSec/chord";
import type { TSchema } from "@OnePanda-TgSec/tg-ai";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { createHash } from "node:crypto";
import {
	type CallToolResult,
	type LlmContent,
	McpClient,
	type Tool as McpTool,
	StdioTransport,
	StreamableHttpTransport,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { SEC_AGENT_ROLES, type SecRoleToolNames, secMcpExtensionName, type TgSecAgentRole } from "../role-policies.ts";
import type { SecMcpLifecycleConfig, SecMcpServerConfig } from "./config.ts";
import type { TgSecFlowFetcher, TgSecFlowPacket } from "./flow.ts";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;
/** Model-facing text beyond this keeps its start and end with the middle cut out. */
export const SEC_MCP_OUTPUT_MAX_BYTES = 20 * 1024;
/** The yak tool that resolves an http-flow id to its stored packet bytes. */
export const SEC_MCP_FLOW_TOOL = "fetch_http_packet_by_id";

/** The seam tests use to connect a faux MCP server without spawning a process or opening a socket. */
export type SecMcpClientFactory = (server: SecMcpServerConfig) => Promise<McpClient>;

/** What the bridge exposes to the host: role-scoped extensions and the flow/cleanup seams. */
export type SecMcpBridge = {
	/** One extension per role with at least one tool, named `sec-mcp-<role>`. */
	readonly extensions: readonly Extension[];
	readonly toolNamesByRole: SecRoleToolNames;
	/** Every registered MCP tool name; probe 4's declared set is derived from this. */
	readonly declaredTools: readonly string[];
	/** Servers that failed to connect or list tools, and why. One failure never disables the rest. */
	readonly errors: readonly string[];
	/** Present when a connected server offers `fetch_http_packet_by_id`. */
	readonly flowFetcher: TgSecFlowFetcher | undefined;
	/** Stop recorded long-lived resources, then close every client. Idempotent. */
	close(): Promise<{ readonly stopped: number; readonly errors: readonly string[] }>;
};

export type OpenSecMcpBridgeOptions = {
	readonly servers: readonly SecMcpServerConfig[];
	/** Tests inject a connected client; production defaults to stdio/Streamable HTTP. */
	readonly clientFactory?: SecMcpClientFactory;
	/** Maps a `fetch_http_packet_by_id` result to packet bytes; the default reads base64 fields. */
	readonly flowPacket?: (result: CallToolResult) => TgSecFlowPacket;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long or taken. */
export function createSecMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function patternMatches(pattern: string, name: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(name);
}

function toolIncluded(server: SecMcpServerConfig, tool: string): boolean {
	return server.tools === undefined || server.tools.some((pattern) => patternMatches(pattern, tool));
}

function roleIncluded(server: SecMcpServerConfig, role: TgSecAgentRole): boolean {
	return server.enabled !== false && (server.roles === undefined || server.roles.includes(role));
}

function toParameters(schema: Record<string, unknown>): TSchema {
	return {
		...schema,
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	} as unknown as TSchema;
}

const RESULT_SCHEMA = Type.Object(
	{
		content: Type.Array(Type.Object({ type: Type.String() }, { additionalProperties: true })),
		structuredContent: Type.Optional(Type.Any()),
		isError: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);

/**
 * Keep the model-facing text bounded without losing both ends: images pass through, and the middle
 * of over-long text is replaced by a byte count. The full result still reaches programs as
 * `structuredOutput`.
 */
function limitContent(content: readonly LlmContent[]): LlmContent[] {
	const text = content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= SEC_MCP_OUTPUT_MAX_BYTES) return [...content];
	const half = Math.floor(SEC_MCP_OUTPUT_MAX_BYTES / 2);
	const head = bytes.subarray(0, half).toString("utf8");
	const tail = bytes.subarray(bytes.length - half).toString("utf8");
	const truncated = `${head}\n[... ${bytes.length - half * 2} bytes truncated ...]\n${tail}`;
	return [{ type: "text", text: truncated }, ...content.filter((block) => block.type === "image")];
}

/** The model-facing content of one result, with an error fallback when the server sent nothing. */
function modelContent(result: CallToolResult): LlmContent[] {
	const content = toLlmContent(result);
	if (content.length === 0 && result.isError === true) return [{ type: "text", text: "MCP tool returned an error" }];
	return limitContent(content);
}

/** The script-facing result: the `CallToolResult` without `_meta`, which the protocol reserves. */
function structuredContent(result: CallToolResult): JsonValue {
	const { _meta: _ignored, ...rest } = result;
	return rest as unknown as JsonValue;
}

type StartRecord = {
	readonly client: McpClient;
	readonly server: SecMcpServerConfig;
	readonly lifecycle: SecMcpLifecycleConfig;
	readonly result: CallToolResult;
};

function startArguments(record: StartRecord): Record<string, unknown> {
	const field = record.lifecycle.idField;
	if (field === undefined) return {};
	const value = isRecord(record.result.structuredContent) ? record.result.structuredContent[field] : undefined;
	if (value === undefined) return {};
	return { [record.lifecycle.stopArgument ?? "id"]: value };
}

function createMcpToolRegistration(options: {
	readonly client: McpClient;
	readonly server: SecMcpServerConfig;
	readonly tool: McpTool;
	readonly name: string;
	readonly onStart: (record: StartRecord) => void;
}): ToolRegistration {
	const { server, tool, client } = options;
	const title = tool.title ?? tool.annotations?.title;
	const lifecycle = server.lifecycle;
	return defineTool({
		name: options.name,
		description:
			tool.description?.trim() ||
			title ||
			`MCP tool ${tool.name} from server ${server.name}. Call it through the campaign guard like any other tool.`,
		parameters: toParameters(tool.inputSchema),
		structuredOutputSchema: RESULT_SCHEMA,
		callers: ["model", "tools"],
		deferred: true,
		replay: "unsafe",
		async execute(args) {
			const result = await client.callTool(tool.name, (args ?? {}) as Record<string, unknown>, {
				...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
			});
			if (lifecycle?.startTools.includes(tool.name) && result.isError !== true) {
				options.onStart({ client, server, lifecycle, result });
			}
			return {
				output: modelContent(result),
				structuredOutput: structuredContent(result),
				...(result.isError === true ? { isError: true } : {}),
			};
		},
	});
}

function defaultFlowPacket(result: CallToolResult): TgSecFlowPacket {
	const value = isRecord(result.structuredContent) ? result.structuredContent : undefined;
	const request = value?.requestBase64;
	const response = value?.responseBase64;
	if (value === undefined || typeof request !== "string" || typeof response !== "string") {
		throw new TypeError(
			`${SEC_MCP_FLOW_TOOL} must return structuredContent.requestBase64 and structuredContent.responseBase64`,
		);
	}
	const text = (key: string): string | undefined =>
		typeof value[key] === "string" ? (value[key] as string) : undefined;
	const status = typeof value.status === "number" ? value.status : undefined;
	return {
		request: Buffer.from(request, "base64"),
		response: Buffer.from(response, "base64"),
		...(text("url") === undefined ? {} : { url: text("url") }),
		...(text("method") === undefined ? {} : { method: text("method") }),
		...(status === undefined ? {} : { status }),
		...(text("contentType") === undefined ? {} : { contentType: text("contentType") }),
		...(text("reqHead") === undefined ? {} : { reqHead: text("reqHead") }),
		...(text("respHead") === undefined ? {} : { respHead: text("respHead") }),
	};
}

async function connectDefault(server: SecMcpServerConfig): Promise<McpClient> {
	const client = new McpClient({ name: "tg-sec-agent", version: "2.0.1" });
	const transport =
		server.url === undefined
			? new StdioTransport({
					command: server.command ?? "",
					args: server.args,
					cwd: server.cwd,
					...(server.env === undefined ? {} : { env: { ...server.env } }),
				})
			: new StreamableHttpTransport({
					url: server.url,
					...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
				});
	await client.connect(transport);
	return client;
}

/**
 * Connect the host's configured MCP servers and translate their tools into gibraltar tool
 * registrations. Every tool is `deferred` and registered under `mcp__<server>__<tool>`, so it enters
 * the same registry and the same `beforeTool` guard chain as the built-in tools: the MCP bridge opens
 * no separate permission surface.
 *
 * Role narrowing happens here, at assembly time: a server's `roles`/`tools` decide which role
 * extensions carry its tools, and each role extension is selected by that role's static policy.
 */
export async function openSecMcpBridge(options: OpenSecMcpBridgeOptions): Promise<SecMcpBridge> {
	const errors: string[] = [];
	const clients: { readonly server: SecMcpServerConfig; readonly client: McpClient }[] = [];
	const toolNames = new Set<string>();
	const roleTools: Record<TgSecAgentRole, ToolRegistration[]> = { redteam: [], binary: [], reporting: [] };
	const starts: StartRecord[] = [];
	let flowFetcher: TgSecFlowFetcher | undefined;
	const flowPacket = options.flowPacket ?? defaultFlowPacket;
	const factory = options.clientFactory ?? connectDefault;

	for (const server of options.servers) {
		if (server.enabled === false) continue;
		let client: McpClient;
		try {
			client = await factory(server);
		} catch (error) {
			errors.push(`${server.name}: connect failed: ${errorText(error)}`);
			continue;
		}
		clients.push({ server, client });
		let listed: McpTool[];
		try {
			listed = await client.listTools(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs });
		} catch (error) {
			errors.push(`${server.name}: tools/list failed: ${errorText(error)}`);
			continue;
		}
		for (const tool of listed) {
			if (!toolIncluded(server, tool.name)) continue;
			const name = createSecMcpToolName(server.name, tool.name, (candidate) => toolNames.has(candidate));
			toolNames.add(name);
			const registration = createMcpToolRegistration({
				client,
				server,
				tool,
				name,
				onStart: (record) => starts.push(record),
			});
			for (const role of SEC_AGENT_ROLES) if (roleIncluded(server, role)) roleTools[role].push(registration);
			if (tool.name === SEC_MCP_FLOW_TOOL && flowFetcher === undefined) {
				flowFetcher = async (flowId: string) => {
					if (flowId.trim() === "") throw new TypeError("a flow id must not be empty");
					const result = await client.callTool(
						tool.name,
						{ id: flowId },
						server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs },
					);
					if (result.isError === true) throw new Error(`${SEC_MCP_FLOW_TOOL} failed for flow ${flowId}`);
					return flowPacket(result);
				};
			}
		}
	}

	const extensions = SEC_AGENT_ROLES.filter((role) => roleTools[role].length > 0).map((role) =>
		defineExtension({ name: secMcpExtensionName(role), tools: roleTools[role] }),
	);
	const toolNamesByRole: SecRoleToolNames = {
		redteam: roleTools.redteam.map((tool) => tool.name),
		binary: roleTools.binary.map((tool) => tool.name),
		reporting: roleTools.reporting.map((tool) => tool.name),
	};

	let closed = false;
	return {
		extensions,
		toolNamesByRole,
		declaredTools: [...toolNames].sort(),
		errors,
		flowFetcher,
		async close() {
			if (closed) return { stopped: 0, errors: [] };
			closed = true;
			const closeErrors: string[] = [];
			let stopped = 0;
			for (const record of starts.reverse()) {
				try {
					await record.client.callTool(
						record.lifecycle.stopTool,
						startArguments(record),
						record.server.timeoutMs === undefined ? {} : { timeoutMs: record.server.timeoutMs },
					);
					stopped += 1;
				} catch (error) {
					closeErrors.push(`${record.server.name}: ${record.lifecycle.stopTool} failed: ${errorText(error)}`);
				}
			}
			for (const { server, client } of clients) {
				try {
					await client.close();
				} catch (error) {
					closeErrors.push(`${server.name}: close failed: ${errorText(error)}`);
				}
			}
			return { stopped, errors: closeErrors };
		},
	};
}
