import { defineExtension, type Extension, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import type { SecAgentLane } from "../bootstrap.ts";
import type { TgSecEvidenceStore } from "../evidence/store.ts";
import type { TgSecFlowFetcher } from "../mcp/flow.ts";
import { createEvidenceTools } from "./evidence-tools.ts";
import { createFindingUpdateTool } from "./finding-tools.ts";
import { createHttpRequestTool } from "./http-tool.ts";
import { createPlanUpdateTool } from "./plan-tool.ts";
import { createReportGenerateTool } from "./report-tool.ts";
import { createTerminalDeclareTool } from "./terminal-tool.ts";
import type { RequestExecutor } from "./transport.ts";

/** The host-side seams the sec tool surface needs: the evidence store and the request executor. */
export type SecToolsExtensionOptions = {
	readonly store: TgSecEvidenceStore;
	readonly executor: RequestExecutor;
	/** The campaign's lane; it fixes which terminal claim the host validates. */
	readonly lane: SecAgentLane;
	/** The MCP flow source `evidence_capture` uses when it is given a flow id instead of bodies. */
	readonly flowFetcher?: TgSecFlowFetcher;
	/** Resolves a CTF flag against the submission record; absent leaves every getflag claim unverified. */
	readonly verifyFlag?: (flag: string) => Promise<boolean>;
	/** Campaign facts the report header names; both default to the empty string. */
	readonly project?: string;
	readonly target?: string;
	readonly now?: () => number;
};

/**
 * The campaign's forensic and campaign-control tool surface as one installable extension:
 * `http_request`, `evidence_capture`, `traffic_query`, `finding_update`, `report_generate`,
 * `plan_update`, and `terminal_declare`. It carries **no hooks** — the `sec-core` extension's
 * `beforeTool` already runs for every registered tool, so the scope and danger layers guard these
 * tools the moment they enter the registry. All are deferred: the model reaches them through
 * `tool_search`, and role/lane filtering decides which are offered. Programs and orchestration tools
 * may call them directly via `executeTool`.
 */
export function createSecTools(options: SecToolsExtensionOptions): readonly ToolRegistration[] {
	return [
		createHttpRequestTool(options),
		...createEvidenceTools(options),
		createFindingUpdateTool(options),
		createReportGenerateTool({
			store: options.store,
			project: options.project ?? "",
			target: options.target ?? "",
			...(options.now === undefined ? {} : { now: options.now }),
		}),
		createPlanUpdateTool(options.now === undefined ? {} : { now: options.now }),
		createTerminalDeclareTool({
			lane: options.lane,
			store: options.store,
			...(options.verifyFlag === undefined ? {} : { verifyFlag: options.verifyFlag }),
			...(options.now === undefined ? {} : { now: options.now }),
		}),
	];
}

/** Bundle the campaign tools into a single `sec-tools` extension the host installs next to `sec-core`. */
export function createSecToolsExtension(options: SecToolsExtensionOptions): Extension {
	return defineExtension({ name: "sec-tools", tools: createSecTools(options) });
}
