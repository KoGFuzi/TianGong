import { defineExtension, type Extension, type ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import type { TgSecEvidenceStore } from "../evidence/store.ts";
import { createEvidenceTools } from "./evidence-tools.ts";
import { createHttpRequestTool } from "./http-tool.ts";
import type { RequestExecutor } from "./transport.ts";

/** The host-side seams the sec tool surface needs: the evidence store and the request executor. */
export type SecToolsExtensionOptions = {
	readonly store: TgSecEvidenceStore;
	readonly executor: RequestExecutor;
	readonly now?: () => number;
};

/**
 * The campaign's forensic tool surface as one installable extension: `http_request`, `evidence_capture`,
 * `traffic_query`. It carries **no hooks** — the `sec-core` extension's `beforeTool` already runs for every
 * registered tool, so the scope and danger layers guard these tools the moment they enter the registry.
 * All three are deferred: the model reaches them through `tool_search`, and lane filtering decides which are
 * offered. Programs and orchestration tools may call them directly via `executeTool`.
 */
export function createSecTools(options: SecToolsExtensionOptions): readonly ToolRegistration[] {
	return [createHttpRequestTool(options), ...createEvidenceTools(options)];
}

/** Bundle the three forensic tools into a single `sec-tools` extension the host installs next to `sec-core`. */
export function createSecToolsExtension(options: SecToolsExtensionOptions): Extension {
	return defineExtension({ name: "sec-tools", tools: createSecTools(options) });
}
