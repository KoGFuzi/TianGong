import {
	type CallToolResult,
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpClient,
	McpError,
	type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

/** One tool the faux MCP server advertises; `handler` defaults to a one-line text result. */
export type TgSecMcpStubTool = {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: Record<string, unknown>;
	readonly handler?: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
};

export type TgSecMcpStubCall = { readonly name: string; readonly args: Record<string, unknown> };

/** A connected client plus the server-side record of what the bridge asked for. */
export type TgSecMcpStub = {
	readonly client: McpClient;
	readonly calls: readonly TgSecMcpStubCall[];
	/** Calls of one tool name, in order. */
	callsOf(name: string): readonly Record<string, unknown>[];
	readonly closed: boolean;
	close(): Promise<void>;
	/** Fail `tools/list` or `tools/call` after the handshake, to test a server that answers badly. */
	fail(method: "tools/list" | "tools/call", reason: string): void;
};

/**
 * A faux MCP server over the vendored in-memory transport. The protocol is real — the bridge does
 * not see a fake — so registration, pagination, calls and close all exercise the vendored client.
 * No process is spawned and no socket is opened; connecting a real yak/mitan instance is never part
 * of a test run.
 */
export async function createTgSecMcpStub(tools: readonly TgSecMcpStubTool[]): Promise<TgSecMcpStub> {
	const pair = createInMemoryTransportPair();
	const calls: TgSecMcpStubCall[] = [];
	const failures = new Map<string, string>();
	const listed: McpTool[] = tools.map((tool) => ({
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
	}));
	pair.server.onMessage((message: JsonRpcMessage) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		queueMicrotask(async () => {
			try {
				const failure = failures.get(request.method);
				if (failure !== undefined) throw new McpError(-32603, failure);
				const result = respond(request, tools, listed, calls);
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result });
			} catch (error) {
				const mcpError = error instanceof McpError ? error : new McpError(-32603, String(error));
				await pair.server.send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: mcpError.code, message: mcpError.message },
				});
			}
		});
	});
	await pair.server.start();
	const client = new McpClient({ name: "tg-sec-test", version: "2.0.1" });
	await client.connect(pair.client);
	return {
		client,
		calls,
		callsOf: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
		get closed() {
			return client.connectionState === "closed";
		},
		async close() {
			await client.close();
			await pair.server.close();
		},
		fail(method, reason) {
			failures.set(method, reason);
		},
	};
}

function respond(
	request: JsonRpcRequest,
	tools: readonly TgSecMcpStubTool[],
	listed: readonly McpTool[],
	calls: TgSecMcpStubCall[],
): unknown {
	switch (request.method) {
		case "initialize":
			return {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "tg-sec-stub", version: "1.0.0" },
			};
		case "tools/list":
			return { tools: listed };
		case "tools/call": {
			const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
			const name = params?.name ?? "";
			const args = params?.arguments ?? {};
			calls.push({ name, args });
			const tool = tools.find((entry) => entry.name === name);
			if (tool === undefined) throw new McpError(-32602, `Unknown tool: ${name}`);
			return tool.handler?.(args) ?? { content: [{ type: "text", text: `${name} ok` }] };
		}
		default:
			throw new McpError(-32601, `Method not found: ${request.method}`);
	}
}
