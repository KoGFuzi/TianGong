import type { Context } from "@OnePanda-TgSec/chord";
import type { HookApi, ToolHookCall } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import type { TgSecGuard } from "./guard.ts";
import type { TgSecModeReader } from "./mode.ts";
import {
	type TgSecDangerEvaluator,
	type TgSecDecision,
	type TgSecPermissionMode,
	type TgSecScopeResolver,
	toTgSecRequest,
} from "./types.ts";

/**
 * One attestation probe. A probe is a pure function over its injected inputs and fails by throwing;
 * `runTgSecAttestation` executes probes in order and the first throw ends the attestation
 * (fail-closed: the host refuses to start work on a failed attestation).
 *
 * Batch 0.5a landed probes 1, 4, 5, and 7; batch 1b added probes 2 and 6 with the scope wiring.
 * The remaining slot is reserved, not stubbed:
 *   - probe 3 (a danger-set sample must force ask past grants): batch 2, with the danger regex set.
 */
export type TgSecProbe = {
	readonly name: string;
	run(): Promise<void>;
};

/** What the host hands the guard at a trigger point (harness open, session resume, fork start). */
export type TgSecAttestContext = {
	/** Context for the gibraltar reads the probes make. */
	context: Context;
	/** Probe 5: the session's mode document, read through a real `HookApi` or `Session`. */
	modeReader: TgSecModeReader;
	/** Probe 1: a read of a path the confined ExecutionEnv must refuse with `EACCES`. */
	forbiddenRead: () => Promise<unknown>;
	/** Probe 4: the tools actually registered, against the track preset's declared set. */
	registeredTools: readonly string[];
	declaredTools: readonly string[];
	/** Probes 2 and 7: a scope-outside sample tool call — probe 2 asserts its decision, probe 7 asserts the block. */
	forcedAskSample: ToolHookCall;
	/** Probe 7: the live document reader the probe's own `beforeTool` call reads the mode through. */
	hookApi: HookApi;
	/**
	 * The chain pieces the decision probes build their guards from. Inputs only, never outputs:
	 * the probes execute the chain themselves instead of trusting host-reported decisions.
	 */
	probeGuard: TgSecProbeGuardPieces;
};

/** The chain inputs the decision probes (2, 6, 7) need to construct a working guard: resolver, danger evaluator, mode. */
export type TgSecProbeGuardPieces = {
	mode: TgSecPermissionMode;
	scopeResolver: TgSecScopeResolver;
	dangerEvaluator: TgSecDangerEvaluator;
};

function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

/** Probe 1: the restricted ExecutionEnv is in effect — the forbidden read must fail with EACCES. */
export function probeRestrictedEnv(read: () => Promise<unknown>): TgSecProbe {
	return {
		name: "restricted-env",
		async run(): Promise<void> {
			try {
				await read();
			} catch (error) {
				const code = errorCode(error);
				if (code === "EACCES") return;
				throw new Error(`expected an EACCES refusal, got ${code ?? String(error)}`);
			}
			throw new Error("the forbidden read succeeded; the confined ExecutionEnv is not in effect");
		},
	};
}

/**
 * Probe 2: a scope-outside sample must never resolve to allow. The probe builds its own guard
 * through `createGuard` and runs `decisionFor` on the sample: the decision must be a forced ask.
 * The sample is expected to be scope-only — a sample that also trips hard deny would surface as a
 * deny and fail the probe, which is the honest signal that the sample is not testing what it claims.
 */
export function probeScopeOutsideNotAllows(sample: ToolHookCall, createGuard: () => TgSecGuard): TgSecProbe {
	return {
		name: "scope-outside-not-allow",
		async run(): Promise<void> {
			const guard = createGuard();
			const decision = await guard.decisionFor(toTgSecRequest(sample));
			if (decision.effect === "allow") {
				throw new Error("a scope-outside sample must never resolve to allow");
			}
			if (decision.effect !== "ask" || !decision.forced) {
				throw new Error(`a scope-outside sample must produce a forced ask, got ${decision.effect}`);
			}
		},
	};
}

/** Probe 4: the registered tool set equals the declared track preset set — missing or extra both fail. */
export function probeToolSetAlignment(registered: readonly string[], declared: readonly string[]): TgSecProbe {
	return {
		name: "tool-set-alignment",
		async run(): Promise<void> {
			const registeredSet = new Set(registered);
			const declaredSet = new Set(declared);
			const missing = [...declaredSet].filter((name) => !registeredSet.has(name));
			const extra = [...registeredSet].filter((name) => !declaredSet.has(name));
			if (missing.length > 0 || extra.length > 0) {
				const parts: string[] = [];
				if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
				if (extra.length > 0) parts.push(`extra: ${extra.join(", ")}`);
				throw new Error(`registered tools do not match the declared set (${parts.join("; ")})`);
			}
		},
	};
}

/** Probe 5: `tg.sec.mode` is readable and its value is one of the four modes; reading throws otherwise. */
export function probeModeDocument(read: () => Promise<unknown>): TgSecProbe {
	return {
		name: "mode-document",
		async run(): Promise<void> {
			const mode = await read();
			if (mode !== "strict" && mode !== "judge-auto" && mode !== "auto" && mode !== "yolo") {
				throw new Error(`tg.sec.mode reads ${JSON.stringify(mode)}, which is not one of the four modes`);
			}
		},
	};
}

/**
 * Probe 6: a call that never walked the regular `beforeTool` path — resumed, placement-free, with
 * no associated assistant message — must still enter the chain. The probe feeds such a sample
 * straight to `decisionFor` (the entry point the batch-0 wiring review found bypassable) and
 * asserts two things: an answer with a real decision shape comes back — never the P1-5
 * "no match, return undefined" bypass — and exactly one `tg.span.sec.guard` span was recorded.
 * `createGuard` receives the probe's own telemetry sink so the span claim is checked, not trusted.
 */
export function probeUnaffiliatedCallEntersChain(
	sample: ToolHookCall,
	createGuard: (telemetry: InMemoryTelemetryContext) => TgSecGuard,
): TgSecProbe {
	return {
		name: "unaffiliated-call-enters-chain",
		async run(): Promise<void> {
			const telemetry = new InMemoryTelemetryContext();
			const guard = createGuard(telemetry);
			// The cast is the probe: a bypassing chain answers `undefined`, which the real type says
			// cannot happen. Checking the shape at runtime is what proves the chain was entered.
			const decision = (await guard.decisionFor(toTgSecRequest(sample))) as TgSecDecision | undefined;
			if (decision === undefined || typeof decision.effect !== "string") {
				throw new Error("the unaffiliated call produced no decision: the chain was bypassed, not entered");
			}
			const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
			if (spans.length !== 1) {
				throw new Error(`every decision must record exactly one tg.span.sec.guard span, saw ${spans.length}`);
			}
		},
	};
}

/**
 * Probe 7: with no ask channel wired, a forced ask must surface as a block, never as a pass.
 * The probe takes no decision and no pass/fail boolean from the host: it builds its own guard
 * through `createGuard` (which must pass no ask channel), runs `decisionFor` on the sample
 * expecting a forced ask, and runs `beforeTool` expecting the block mapping. A host that only
 * claims the chain fails closed now fails the probe instead.
 */
export function probeForcedAskBlocks(
	sample: ToolHookCall,
	hookApi: HookApi,
	context: Context,
	createGuard: () => TgSecGuard,
): TgSecProbe {
	return {
		name: "forced-ask-fails-closed",
		async run(): Promise<void> {
			const guard = createGuard();
			const decision = await guard.decisionFor(toTgSecRequest(sample));
			if (decision.effect !== "ask" || !decision.forced) {
				throw new Error(`the probe guard's own chain must force an ask on the sample, got ${decision.effect}`);
			}
			const result = await guard.beforeTool(sample, hookApi, context);
			if (result === undefined || result.block === undefined) {
				throw new Error("a forced ask without an ask channel must block the call, not pass it");
			}
		},
	};
}

/** Runs the probes in order; the first failure throws and the attestation ends. */
export async function runTgSecAttestation(probes: readonly TgSecProbe[]): Promise<void> {
	for (const probe of probes) {
		try {
			await probe.run();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`attestation probe "${probe.name}" failed: ${message}`, { cause: error });
		}
	}
}
