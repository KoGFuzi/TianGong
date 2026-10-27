import type { Extension } from "@OnePanda-TgSec/tg-gibraltar";
import {
	secRolePolicies,
	secRolePoliciesWithMcp,
	type TaskChildPolicy,
	type TgSecAgentRole,
} from "../role-policies.ts";
import { openSecMcpBridge, type SecMcpClientFactory } from "./bridge.ts";
import { loadSecMcpConfig } from "./config.ts";
import type { TgSecFlowFetcher } from "./flow.ts";

/** The MCP surface one host assembles: extensions, composed role policies, and the shutdown seam. */
export type SecMcpHost = {
	readonly extensions: readonly Extension[];
	readonly policies: Readonly<Record<TgSecAgentRole, TaskChildPolicy>>;
	/** Every registered MCP tool name; the guard's declared set is derived from this. */
	readonly declaredTools: readonly string[];
	readonly flowFetcher: TgSecFlowFetcher | undefined;
	/** Configuration problems and failed servers. Empty is the normal state, not a requirement. */
	readonly errors: readonly string[];
	/** Stop long-lived resources and close every client; returns what could not be stopped. */
	close(): Promise<readonly string[]>;
};

export type OpenSecMcpHostOptions = {
	readonly cwd: string;
	/** Overrides `TG_SEC_MCP_CONFIG` and `<cwd>/.tiangong/mcp.json`. */
	readonly configPath?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly clientFactory?: SecMcpClientFactory;
	readonly basePolicies?: Readonly<Record<TgSecAgentRole, TaskChildPolicy>>;
};

/**
 * Read the host's MCP configuration and connect what it names. A missing file, a malformed entry, or
 * a server that will not answer leaves the rest of the campaign untouched: the MCP surface is
 * optional, so absence narrows the tool set instead of failing the run.
 */
export async function openSecMcpHost(options: OpenSecMcpHostOptions): Promise<SecMcpHost> {
	const config = await loadSecMcpConfig({
		cwd: options.cwd,
		...(options.configPath === undefined ? {} : { path: options.configPath }),
		...(options.env === undefined ? {} : { env: options.env }),
	});
	const bridge = await openSecMcpBridge({
		servers: config.servers,
		...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
	});
	return {
		extensions: bridge.extensions,
		policies: secRolePoliciesWithMcp(bridge.toolNamesByRole, options.basePolicies ?? secRolePolicies),
		declaredTools: bridge.declaredTools,
		flowFetcher: bridge.flowFetcher,
		errors: [...config.errors, ...bridge.errors],
		close: async () => {
			const result = await bridge.close();
			return [...result.errors];
		},
	};
}
