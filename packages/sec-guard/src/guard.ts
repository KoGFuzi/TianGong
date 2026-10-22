import type { Context } from "@OnePanda-TgSec/chord";
import type { ToolHookCall, ToolHooks } from "@OnePanda-TgSec/tg-gibraltar";
import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	TG_SPAN_SCHEMA,
} from "@OnePanda-TgSec/tg-telemetry";
import { createHash } from "node:crypto";
import {
	probeForcedAskBlocks,
	probeModeDocument,
	probeRestrictedEnv,
	probeScopeOutsideNotAllows,
	probeToolSetAlignment,
	probeUnaffiliatedCallEntersChain,
	runTgSecAttestation,
	type TgSecAttestContext,
	type TgSecProbe,
} from "./attest.ts";
import { evaluateHardDeny, localInterfaceAddresses, type TgSecHardDenyRuleId } from "./hard-deny.ts";
import { isTgSecMode, readTgSecMode, switchTgSecMode, type TgSecSessionPort } from "./mode.ts";
import {
	type TgSecAskReply,
	type TgSecDangerEvaluator,
	type TgSecDecision,
	type TgSecJudge,
	type TgSecPermissionMode,
	type TgSecRequest,
	type TgSecScopeResolver,
	toTgSecRequest,
} from "./types.ts";

/** The layer of the chain that produced a decision, recorded on the guard span. */
export type TgSecMatchedLayer = "hard-deny" | "scope" | "danger" | "grants" | "mode";

/** One evaluation outcome: the public decision plus the closed-vocabulary audit facts of its path. */
export type TgSecEvaluation = {
	readonly decision: TgSecDecision;
	readonly layer: TgSecMatchedLayer;
	/** Built-in hard-deny rule id; present exactly when the layer is `hard-deny`. */
	readonly ruleId?: TgSecHardDenyRuleId;
};

/** The human reply channel for an ask. Absent means fail-closed: every ask blocks. */
export type TgSecAskChannel = (
	request: TgSecRequest,
	decision: TgSecDecision & { effect: "ask" },
) => Promise<TgSecAskReply>;

/** Session-scoped `always` grants, keyed on the exact `tool:<name>` resource. Set keys, no patterns. */
export type TgSecGrantStore = {
	has(resource: string): boolean;
	add(resource: string): void;
};

/** The minimal in-memory grant store. A host that wants durable grants injects its own store. */
export function createInMemoryGrantStore(): TgSecGrantStore {
	const granted = new Set<string>();
	return {
		has: (resource) => granted.has(resource),
		add: (resource) => {
			granted.add(resource);
		},
	};
}

export type TgSecGuardOptions = {
	/** The mode in effect at construction. Construction and switching fail closed from it. */
	mode: TgSecPermissionMode;
	/** Required. The guard ships no allow-all default; a missing resolver is a construction error. */
	scopeResolver?: TgSecScopeResolver;
	/** Required. The guard ships no allow-all default; a missing evaluator is a construction error. */
	dangerEvaluator?: TgSecDangerEvaluator;
	/** Required for `judge-auto`, the only mode that consults it. The judge has no deny power. */
	judge?: TgSecJudge;
	/** Ask channel. Absent means an ask resolves to a block — never to a pass. */
	askChannel?: TgSecAskChannel;
	/** `always` grants. Defaults to a fresh in-memory store owned by this guard. */
	grants?: TgSecGrantStore;
	/** Writes and reads the `tg.sec.mode` document. Required for `switchMode`. */
	session?: TgSecSessionPort;
	/** Audit sink for the guard and mode-switch spans. Defaults to no-op. */
	telemetry?: TelemetryContext;
	/** Addresses of this machine for hard deny. Defaults to `localInterfaceAddresses()`. */
	hostAddresses?: readonly string[] | (() => readonly string[]);
	/** Wall-clock budget for the judge before a `judge-auto` decision falls back to ask. */
	judgeTimeoutMs?: number;
};

export type TgSecGuard = {
	/** Adapter for gibraltar `ToolHooks.beforeTool`. Every call enters the chain. */
	beforeTool: ToolHooks["beforeTool"];
	/** Runs the registered attestation probes in order; the first failure throws (fail-closed). */
	attest(context: TgSecAttestContext): Promise<void>;
	/** Hot-switches the session mode: validates, writes the document, records the switch span. */
	switchMode(mode: TgSecPermissionMode, actor: string, context: Context): Promise<void>;
	/** One decision for one request at the guard's current mode. Emits exactly one guard span. */
	decisionFor(request: TgSecRequest): Promise<TgSecDecision>;
};

/** Deterministic JSON with sorted keys, so equal arguments always produce equal digests. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function digestArguments(request: TgSecRequest): string {
	return createHash("sha256").update(canonicalJson(request.arguments)).digest("hex").slice(0, 16);
}

async function judgeWithTimeout(judge: TgSecJudge, request: TgSecRequest, timeoutMs: number): Promise<TgSecEvaluation> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clock = new Promise<{ decision: "ask"; comment: string }>((resolve) => {
		timer = setTimeout(() => resolve({ decision: "ask", comment: "the judge timed out" }), timeoutMs);
	});
	try {
		const verdict = await Promise.race([judge(request), clock]);
		if (verdict.decision === "allow") return { decision: { effect: "allow" }, layer: "mode" };
		return {
			decision: { effect: "ask", reason: verdict.comment || "the judge asked for a human", forced: false },
			layer: "mode",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			decision: {
				effect: "ask",
				reason: `the judge failed and the call escalates to a human: ${message}`,
				forced: false,
			},
			layer: "mode",
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function resolveHostAddresses(
	provided: readonly string[] | (() => readonly string[]) | undefined,
): () => readonly string[] {
	if (provided === undefined) return localInterfaceAddresses;
	if (typeof provided === "function") return provided;
	return () => provided;
}

/**
 * Build the guard. Construction fails closed on a missing required dependency and never silently
 * loosens: no scope resolver, no danger evaluator, or a `judge-auto` mode without a judge all throw.
 * A missing ask channel does not throw at construction; it makes every ask block at decision time.
 */
export function createTgSecGuard(options: TgSecGuardOptions): TgSecGuard {
	if (!isTgSecMode(options.mode)) {
		throw new TypeError(`createTgSecGuard: mode ${JSON.stringify(options.mode)} is not one of the four modes`);
	}
	if (options.scopeResolver === undefined) {
		throw new TypeError("createTgSecGuard: a scope resolver is required; the guard ships no allow-all default");
	}
	if (options.dangerEvaluator === undefined) {
		throw new TypeError("createTgSecGuard: a danger evaluator is required; the guard ships no allow-all default");
	}
	if (options.mode === "judge-auto" && options.judge === undefined) {
		throw new TypeError("createTgSecGuard: mode judge-auto requires an injected judge");
	}

	const scopeResolver = options.scopeResolver;
	const dangerEvaluator = options.dangerEvaluator;
	const grants = options.grants ?? createInMemoryGrantStore();
	const telemetry = options.telemetry ?? NOOP_TELEMETRY_CONTEXT;
	const hostAddresses = resolveHostAddresses(options.hostAddresses);
	const judgeTimeoutMs = options.judgeTimeoutMs ?? 15_000;
	let currentMode = options.mode;

	// The chain body. Every request enters at step 0 and short-circuits only once a layer has
	// produced its decision; forced asks (scope, danger) return before mode dispatch. Grants are an
	// internal step of the `auto`/`yolo` branch, not a global pre-layer: `strict` puts every call in
	// front of a human and `judge-auto` routes every call through the judge, so a stored `always`
	// grant must never exempt either mode. Only auto/yolo may be short-circuited by a grant.
	async function evaluate(request: TgSecRequest, mode: TgSecPermissionMode): Promise<TgSecEvaluation> {
		const denial = evaluateHardDeny(request, hostAddresses());
		if (denial !== undefined) {
			return {
				decision: { effect: "deny", reason: denial.reason, hard: true },
				layer: "hard-deny",
				ruleId: denial.ruleId,
			};
		}
		const scope = scopeResolver(request);
		if (!scope.inScope) {
			return {
				decision: {
					effect: "ask",
					reason: scope.reason ?? "the target is outside the registered scope",
					forced: true,
				},
				layer: "scope",
			};
		}
		const danger = dangerEvaluator(request);
		if (danger.hit) {
			return {
				decision: {
					effect: "ask",
					reason: danger.reason ?? "the call matches the dangerous-instruction set",
					forced: true,
				},
				layer: "danger",
			};
		}
		switch (mode) {
			case "strict":
				return {
					decision: {
						effect: "ask",
						reason: "strict mode puts every tool call in front of a human",
						forced: false,
					},
					layer: "mode",
				};
			case "judge-auto": {
				if (options.judge === undefined) throw new TypeError("judge-auto reached evaluation without a judge");
				return judgeWithTimeout(options.judge, request, judgeTimeoutMs);
			}
			case "auto":
			case "yolo":
				if (grants.has(request.resource)) return { decision: { effect: "allow" }, layer: "grants" };
				return { decision: { effect: "allow" }, layer: "mode" };
		}
	}

	async function decisionFor(request: TgSecRequest): Promise<TgSecDecision> {
		const startSpan = createTypedSpanStarter(telemetry, [TG_SPAN_SCHEMA]);
		const mode = currentMode;
		return startSpan("tg.span.sec.guard", { mode, argsDigest: digestArguments(request) }, async (span) => {
			const evaluation = await evaluate(request, mode);
			span.setAttributes({
				layer: evaluation.layer,
				effect: evaluation.decision.effect,
				forced: evaluation.decision.effect === "ask" ? evaluation.decision.forced : undefined,
				rule: evaluation.ruleId,
			});
			return evaluation.decision;
		});
	}

	const beforeTool: ToolHooks["beforeTool"] = async (call, api, context) => {
		// Step 0: every call enters the chain, including resumed or placement-free ones. The live
		// document value wins over the cached mode; a corrupt mode read throws, and gibraltar
		// turns a throwing beforeTool into a block — fail-closed, never a bypass.
		currentMode = await readTgSecMode(api, context);
		const request = toTgSecRequest(call);
		const decision = await decisionFor(request);
		if (decision.effect === "allow") return undefined;
		if (decision.effect === "deny") return { block: decision.reason };
		if (options.askChannel === undefined) {
			return { block: `the guard fails closed without an ask channel: ${decision.reason}` };
		}
		const reply = await options.askChannel(request, decision);
		if (reply === "always") {
			// A forced ask accepts no standing grant; `always` approves this call only.
			if (!decision.forced) grants.add(request.resource);
			return undefined;
		}
		if (reply === "allow") return undefined;
		return { block: decision.reason };
	};

	async function switchMode(mode: TgSecPermissionMode, actor: string, context: Context): Promise<void> {
		if (!isTgSecMode(mode)) throw new TypeError(`switchMode: ${JSON.stringify(mode)} is not one of the four modes`);
		if (mode === "judge-auto" && options.judge === undefined) {
			throw new TypeError("switchMode: cannot switch to judge-auto without an injected judge");
		}
		if (options.session === undefined) throw new TypeError("switchMode: this guard was built without a session port");
		await switchTgSecMode(options.session, mode, actor, context, telemetry);
		currentMode = mode;
	}

	async function attest(attestContext: TgSecAttestContext): Promise<void> {
		const pieces = attestContext.probeGuard;
		const chainProbeGuard = (telemetry: TelemetryContext) =>
			createTgSecGuard({
				mode: pieces.mode,
				scopeResolver: pieces.scopeResolver,
				dangerEvaluator: pieces.dangerEvaluator,
				telemetry,
			});
		// Probe 6's sample is a deliberately unaffiliated call: no assistant message backs it and it
		// is never carried by beforeTool. That is the shape the wiring review (P1-5) found bypassable.
		const unaffiliatedSample: ToolHookCall = {
			type: "toolCall",
			id: "attestation-unaffiliated",
			name: "read",
			arguments: { path: "tg-sec-attestation-probe-6" },
		};
		const probes: TgSecProbe[] = [
			probeRestrictedEnv(attestContext.forbiddenRead),
			probeScopeOutsideNotAllows(attestContext.forcedAskSample, () => chainProbeGuard(NOOP_TELEMETRY_CONTEXT)),
			probeToolSetAlignment(attestContext.registeredTools, attestContext.declaredTools),
			probeModeDocument(() => readTgSecMode(attestContext.modeReader, attestContext.context)),
			probeUnaffiliatedCallEntersChain(unaffiliatedSample, (telemetry) => chainProbeGuard(telemetry)),
			// Probe 7 builds its guard right here, deliberately without an ask channel: fail-closed is what it proves.
			probeForcedAskBlocks(attestContext.forcedAskSample, attestContext.hookApi, attestContext.context, () =>
				chainProbeGuard(NOOP_TELEMETRY_CONTEXT),
			),
		];
		await runTgSecAttestation(probes);
	}

	return { beforeTool, attest, switchMode, decisionFor };
}
