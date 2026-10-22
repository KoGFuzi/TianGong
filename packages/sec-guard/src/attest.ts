import type { Context } from "@OnePanda-TgSec/chord";
import type { TgSecModeReader } from "./mode.ts";
import type { TgSecDecision, TgSecRequest } from "./types.ts";

/**
 * One attestation probe. A probe is a pure function over its injected inputs and fails by throwing;
 * `runTgSecAttestation` executes probes in order and the first throw ends the attestation
 * (fail-closed: the host refuses to start work on a failed attestation).
 *
 * Batch 0.5a lands probes 1, 4, 5, and 7. The remaining slots are reserved, not stubbed:
 *   - probe 2 (a scope-outside call must not yield allow): batch 1, with the scope resolver.
 *   - probe 3 (a danger-set sample must force ask past grants): batch 2, with the danger regex set.
 *   - probe 6 (a placement-free or resumed call still enters the chain): batch 1, with scope wiring.
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
	/** Probe 7: a sample request the chain must force to human review. */
	forcedAskSample: TgSecRequest;
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
 * Probe 7: with no ask channel wired, a forced ask must surface as a block, never as a pass.
 * `blocked` is what `toBeforeToolBlocks` produced for the sample decision without an ask channel.
 */
export function probeForcedAskBlocks(decision: TgSecDecision, blocked: boolean): TgSecProbe {
	return {
		name: "forced-ask-fails-closed",
		async run(): Promise<void> {
			if (decision.effect !== "ask" || !decision.forced) {
				throw new Error(`the attestation sample must force an ask, got ${decision.effect}`);
			}
			if (!blocked) throw new Error("a forced ask without an ask channel must block the call, not pass it");
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
