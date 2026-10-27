import type { Context } from "@OnePanda-TgSec/chord";
import type { Models } from "@OnePanda-TgSec/tg-ai";
import type { HookApi, ModelRef, ToolHookCall } from "@OnePanda-TgSec/tg-gibraltar";
import {
	createTgSecDangerEvaluator,
	createTgSecGuard,
	createTgSecRuleTable,
	createTgSecScopeRegistry,
	createTgSecScopeResolver,
	createTgSecTwoAxisJudge,
	readTgSecMode,
	type TgSecAskChannel,
	type TgSecAttestContext,
	type TgSecDangerEvaluator,
	type TgSecGuard,
	type TgSecJudgeTransport,
	type TgSecPermissionMode,
	type TgSecRule,
	type TgSecScopeRegistry,
	type TgSecScopeResolver,
	type TgSecSessionPort,
} from "@OnePanda-TgSec/tg-sec-guard";
import type { TelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join, parse } from "node:path";
import type { SecAgentLane } from "./bootstrap.ts";
import { createModelJudgeTransport } from "./judge-transport.ts";

/**
 * The tool set every campaign lane declares: the coding tools, the deferred search surface, the
 * codemode pair, the campaign's own `task`, and the forensic surface (`http_request`,
 * `evidence_capture`, `traffic_query`, `finding_update`, `report_generate`). Attestation probe 4
 * fails closed if the live registry drifts
 * from this list, so a host that installs the `sec-tools` extension matches it exactly.
 *
 * `extraTools` carries the tools a host registered from its own MCP configuration. Deriving them
 * from the same configuration the bridge read is what keeps probe 4 honest: removing a server must
 * narrow the declared set, not turn the probe red.
 */
export function secDeclaredTools(_lane: SecAgentLane, extraTools: readonly string[] = []): readonly string[] {
	return [
		"bash",
		"codemode",
		"edit",
		"evidence_capture",
		"finding_update",
		"http_request",
		"local_tool_check",
		"plan_update",
		"read",
		"report_generate",
		"task",
		"terminal_declare",
		"tg.codemode.models.classify",
		"tg.codemode.models.generateImages",
		"tool_search",
		"traffic_query",
		"write",
		...extraTools,
	];
}

/** The reserved hostname (RFC 2606 `.invalid`, never resolvable) the attestation samples talk to. */
export const SEC_ATTEST_HOST = "tg-sec-attest.invalid";

/** A call whose connection target is outside any registered scope: probes 2 and 7 feed on it. */
export function secAttestForcedAskSample(): ToolHookCall {
	return {
		type: "toolCall",
		id: "sec-attest-forced-ask",
		name: "bash",
		arguments: { command: `curl -s https://${SEC_ATTEST_HOST}/probe` },
	};
}

/**
 * A call carrying no connection target (so the scope layer is silent) that matches
 * `danger.sql.drop-table`: probe 3's danger sample. The host inside the command is an argument
 * value, not a target the command connects to.
 */
export function secAttestDangerSample(): ToolHookCall {
	return {
		type: "toolCall",
		id: "sec-attest-danger",
		name: "bash",
		arguments: { command: "mysql -e 'DROP TABLE attestation_probe' attestation_db" },
	};
}

/** A quiet local read: in scope, no danger, no weak candidate — every rules-table probe runs on it. */
export function secAttestRulesSample(): ToolHookCall {
	return {
		type: "toolCall",
		id: "sec-attest-rules",
		name: "read",
		arguments: { path: "tg-sec-attestation-rules-sample" },
	};
}

/**
 * Probe 1's forbidden read. POSIX: a `000`-mode directory under `dataDir`, then a read attempt
 * inside it — the confined-filesystem shape the probe contract asks for (the parent directory
 * denies the lookup, so the refusal is EACCES before existence ever matters). Under a root uid
 * nothing is unreadable, the read succeeds, and the probe fails: the honest answer, because on a
 * root process no confinement is in effect to attest. Windows: chmod does not produce a readable
 * refusal, so the read targets the volume's ACL-protected system directory — refused by the OS
 * even for administrators, which is the same honest proof.
 */
export function secAttestForbiddenRead(dataDir: string): () => Promise<unknown> {
	return async () => {
		if (process.platform === "win32") {
			// Read the protected directory itself: a file inside it reports ENOENT on Windows,
			// while opening the directory raises the OS refusal the probe expects.
			return readFile(join(parse(dataDir).root, "System Volume Information"));
		}
		const locked = join(dataDir, "attest-locked");
		await mkdir(locked, { recursive: true, mode: 0o700 });
		await chmod(locked, 0o000);
		return readFile(join(locked, "probe.txt"), "utf8");
	};
}

/** The host-side inputs probe 1 and probe 4 read at attestation time. */
export type SecAttestParts = {
	/** Probe 1: the confined read. A host without confinement fails its own attestation, loudly. */
	forbiddenRead: () => Promise<unknown>;
	/** Probe 4: what the registry actually holds. Read lazily, at attestation time. */
	registeredTools: () => readonly string[];
	/** Probe 4: what the lane declares. Defaults to `secDeclaredTools(lane)`. */
	declaredTools?: readonly string[];
};

export type BuildSecGuardOptions = {
	/** The live mode is read from the `tg.sec.mode` session document through this port. */
	session: TgSecSessionPort;
	lane: SecAgentLane;
	context: Context;
	attestParts: SecAttestParts;
	/** Overrides the persisted mode (a CLI `--mode` before the first switch). */
	mode?: TgSecPermissionMode;
	/** Absent means an empty registry: every connection target is out of scope. */
	scopeRegistry?: TgSecScopeRegistry;
	/** The operator intercept rules; absent means an empty table. */
	rules?: readonly TgSecRule[];
	/** Used for a `judge-auto` session; the other modes never call it. */
	judgeModel?: { models: Models; model: ModelRef; resolveModel?: () => ModelRef };
	/** Overrides `judgeModel` — tests and stubbed runs hand in their own transport. */
	judgeTransport?: TgSecJudgeTransport;
	askChannel?: TgSecAskChannel;
	telemetry?: TelemetryContext;
};

/** The guard plus the seam the core extension attests through on the first real hook call. */
export type SecGuardWiring = {
	readonly guard: TgSecGuard;
	readonly mode: TgSecPermissionMode;
	readonly scopeResolver: TgSecScopeResolver;
	readonly dangerEvaluator: TgSecDangerEvaluator;
	/**
	 * Assemble the fail-closed attestation context around a real `HookApi` — the one a gibraltar
	 * tool hook receives. The whole probe set then executes through genuine harness plumbing:
	 * probe 7 feeds that api to `beforeTool`, so no attestation fake is ever constructed.
	 */
	attestContext(hookApi: HookApi, context: Context): TgSecAttestContext;
};

/**
 * Wire one campaign's guard: lane-keyed danger evaluator, scope resolver over the registry (an
 * empty registry means nothing is reachable — fail closed), the two-axis judge when a judge model
 * or transport is configured, and the operator rules table. Construction reads the persisted mode
 * once; every later call re-reads it live through the hook's `HookApi`, so a `switchMode` takes
 * effect without rebuilding the guard.
 */
export async function buildSecGuard(options: BuildSecGuardOptions): Promise<SecGuardWiring> {
	const mode = options.mode ?? (await readTgSecMode(options.session, options.context));
	const scopeResolver = createTgSecScopeResolver(options.scopeRegistry ?? createTgSecScopeRegistry([]));
	const dangerEvaluator = createTgSecDangerEvaluator({ objective: options.lane });
	const transport =
		options.judgeTransport ??
		(options.judgeModel === undefined ? undefined : createModelJudgeTransport(options.judgeModel));
	const guard = createTgSecGuard({
		mode,
		scopeResolver,
		dangerEvaluator,
		...(transport === undefined
			? {}
			: {
					judge: createTgSecTwoAxisJudge({
						transport,
						...(options.judgeModel === undefined
							? {}
							: { model: `${options.judgeModel.model.provider}/${options.judgeModel.model.modelId}` }),
					}),
				}),
		...(options.askChannel === undefined ? {} : { askChannel: options.askChannel }),
		rules: createTgSecRuleTable(options.rules ?? []),
		session: options.session,
		...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
	});
	const declaredTools = options.attestParts.declaredTools ?? secDeclaredTools(options.lane);
	return {
		guard,
		mode,
		scopeResolver,
		dangerEvaluator,
		attestContext: (hookApi, context) => ({
			context,
			modeReader: hookApi,
			hookApi,
			forbiddenRead: options.attestParts.forbiddenRead,
			registeredTools: options.attestParts.registeredTools(),
			declaredTools,
			forcedAskSample: secAttestForcedAskSample(),
			dangerSample: secAttestDangerSample(),
			rulesSample: secAttestRulesSample(),
			probeGuard: { mode, scopeResolver, dangerEvaluator },
		}),
	};
}
