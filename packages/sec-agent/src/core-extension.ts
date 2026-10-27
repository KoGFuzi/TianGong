import type { Context } from "@OnePanda-TgSec/chord";
import type { Extension, HookApi, ToolHookCall, ToolHooks } from "@OnePanda-TgSec/tg-gibraltar";
import { defineExtension, hook, ToolTask } from "@OnePanda-TgSec/tg-gibraltar";
import type { TelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import type { SecAgentLane } from "./bootstrap.ts";
import type { SecGuardWiring } from "./guard-wiring.ts";
import type { TaskChildPolicy, TgSecAgentRole } from "./role-policies.ts";
import type { SecPromptSections } from "./sections.ts";
import { secPromptSections, secScopePromptSections } from "./sections.ts";
import { createTaskTool } from "./task-tool.ts";

export type SecCoreExtensionOptions = {
	lane: SecAgentLane;
	/** The guard under test. Attestation runs against it before its first verdict. */
	wiring: SecGuardWiring;
	/** The closed role catalog for `task`; the host decides what a delegation may carry. */
	policies: Readonly<Record<TgSecAgentRole, TaskChildPolicy>>;
	/** Prompt sections; defaults to the host lane's map for the root and role+lane maps for children. */
	sections?: SecPromptSections;
	/** Audit sink shared with the guard; the `task` tool records `tg.span.sec.fork` through it. */
	telemetry?: TelemetryContext;
};

/**
 * The campaign's core extension: the `task` tool, the lane's prompt sections, and the guard's
 * `beforeTool` wired onto the built-in tool task.
 *
 * Attestation is one-shot and happens **inside the first hook call**: gibraltar hands every tool
 * hook a real `HookApi` for a real task, which is exactly the object probe 7 needs
 * (`beforeTool(sample, hookApi, ctx)` must read the live mode document through genuine harness
 * plumbing). A host therefore gets fail-closed wiring before any tool effect: the first call is
 * blocked if attestation throws, and until attestation passes nothing after it has executed. The
 * flag flips only on success, so a failing attestation retries on the next call rather than
 * silently degrading to unattested running.
 */
export function createSecCoreExtension(options: SecCoreExtensionOptions): Extension {
	const taskTool = createTaskTool({
		lane: options.lane,
		policies: options.policies,
		...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
	});
	const guard = options.wiring.guard;
	let attested = false;
	const beforeTool: ToolHooks["beforeTool"] = async (call: ToolHookCall, api: HookApi, context: Context) => {
		if (!attested) {
			await guard.attest(options.wiring.attestContext(api, context));
			attested = true;
		}
		return guard.beforeTool(call, api, context);
	};
	return defineExtension({
		name: "sec-core",
		tools: [taskTool],
		sections:
			options.sections === undefined ? secScopePromptSections(options.lane) : secPromptSections(options.sections),
		hooks: [hook(ToolTask, { beforeTool })],
	});
}
