import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import type { HookApi, JsonObject, ToolHookCall } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { describe, expect, it } from "vitest";
import {
	createTgSecGuard,
	probeForcedAskBlocks,
	probeModeDocument,
	probeRestrictedEnv,
	probeScopeOutsideNotAllows,
	probeToolSetAlignment,
	probeUnaffiliatedCallEntersChain,
	runTgSecAttestation,
	type TgSecAttestContext,
	type TgSecDangerEvaluator,
	type TgSecGuard,
	type TgSecScopeResolver,
	toTgSecRequest,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const ALL_IN_SCOPE: TgSecScopeResolver = () => ({ inScope: true });
const NO_DANGER: TgSecDangerEvaluator = () => ({ hit: false });

function eaccesError(): Error & { code: string } {
	const error = new Error("permission denied") as Error & { code: string };
	error.code = "EACCES";
	return error;
}

describe("probe 1: restricted env", () => {
	it("passes when the forbidden read is refused with EACCES", async () => {
		const probe = probeRestrictedEnv(async () => {
			throw eaccesError();
		});
		await expect(probe.run()).resolves.toBeUndefined();
	});

	it("fails when the forbidden read succeeds", async () => {
		const probe = probeRestrictedEnv(async () => "contents");
		await expect(probe.run()).rejects.toThrow(/is not in effect/);
	});

	it("fails when the read is refused with any other code", async () => {
		const probe = probeRestrictedEnv(async () => {
			const error = new Error("not found") as Error & { code: string };
			error.code = "ENOENT";
			throw error;
		});
		await expect(probe.run()).rejects.toThrow(/expected an EACCES refusal/);
	});
});

describe("probe 4: tool set alignment", () => {
	it("passes on the same set in any order", async () => {
		await expect(probeToolSetAlignment(["read", "shell"], ["shell", "read"]).run()).resolves.toBeUndefined();
	});

	it("fails when a declared tool is missing", async () => {
		await expect(probeToolSetAlignment(["read"], ["read", "shell"]).run()).rejects.toThrow(/missing: shell/);
	});

	it("fails when an undeclared tool is registered", async () => {
		await expect(probeToolSetAlignment(["read", "shell", "netfetch"], ["read", "shell"]).run()).rejects.toThrow(
			/extra: netfetch/,
		);
	});
});

describe("probe 5: mode document", () => {
	it("passes on each of the four modes", async () => {
		for (const mode of ["strict", "judge-auto", "auto", "yolo"] as const) {
			await expect(probeModeDocument(async () => mode).run()).resolves.toBeUndefined();
		}
	});

	it("fails on a value outside the four modes", async () => {
		await expect(probeModeDocument(async () => "permissive").run()).rejects.toThrow(/not one of the four modes/);
	});

	it("fails when reading the document throws", async () => {
		await expect(
			probeModeDocument(async () => {
				throw new Error("storage closed");
			}).run(),
		).rejects.toThrow("storage closed");
	});
});

describe("probe 7: forced ask fails closed", () => {
	const sample: ToolHookCall = {
		type: "toolCall",
		id: "probe-7-sample",
		name: "netfetch",
		arguments: { url: "http://target.invalid/x" },
	};
	const hookApi = { snapshot: async () => ({ mode: "auto" }) } as unknown as HookApi;
	const outOfScope: TgSecScopeResolver = () => ({ inScope: false });

	function probe(createGuard: () => TgSecGuard) {
		return probeForcedAskBlocks(sample, hookApi, context, createGuard);
	}

	it("passes when the probe's own guard chain forces the ask and blocks the call", async () => {
		const probe7 = probe(() =>
			createTgSecGuard({ mode: "auto", scopeResolver: outOfScope, dangerEvaluator: NO_DANGER }),
		);
		await expect(probe7.run()).resolves.toBeUndefined();
	});

	it("executes the chain: a host that merely looks passing fails the probe", async () => {
		// The old probe accepted (decision, blocked) from the host and never ran the chain. This
		// fake host wires everything an allow needs, and reports nothing: the probe must see through it.
		let evaluated = 0;
		const fakeHost = probe(() =>
			createTgSecGuard({
				mode: "auto",
				scopeResolver: () => {
					evaluated += 1;
					return { inScope: true };
				},
				dangerEvaluator: NO_DANGER,
				askChannel: async () => "allow",
			}),
		);
		await expect(fakeHost.run()).rejects.toThrow(/must force an ask/);
		expect(evaluated).toBe(1);
	});

	it("fails when the sample decision is an ask that is not forced", async () => {
		const strict = probe(() =>
			createTgSecGuard({ mode: "strict", scopeResolver: ALL_IN_SCOPE, dangerEvaluator: NO_DANGER }),
		);
		await expect(strict.run()).rejects.toThrow(/must force an ask/);
	});

	it("fails when the probe's guard carries an ask channel that would unblock the sample", async () => {
		const withChannel = probe(() =>
			createTgSecGuard({
				mode: "auto",
				scopeResolver: outOfScope,
				dangerEvaluator: NO_DANGER,
				askChannel: async () => "allow",
			}),
		);
		await expect(withChannel.run()).rejects.toThrow(/must block the call/);
	});

	it("fails when the mode read inside beforeTool throws: the probe really walks the adapter", async () => {
		const corrupt = { snapshot: async () => ({ mode: "yololo" }) } as unknown as HookApi;
		const probe7 = probeForcedAskBlocks(sample, corrupt, context, () =>
			createTgSecGuard({ mode: "auto", scopeResolver: outOfScope, dangerEvaluator: NO_DANGER }),
		);
		await expect(probe7.run()).rejects.toThrow(/not one of/);
	});
});

describe("probe 2: a scope-outside sample never allows", () => {
	const sample: ToolHookCall = {
		type: "toolCall",
		id: "probe-2-sample",
		name: "netfetch",
		arguments: { url: "http://target.invalid/x" },
	};
	const outOfScope: TgSecScopeResolver = () => ({
		inScope: false,
		reason: "the target is outside the registered scope",
	});

	it("passes when the chain forces the ask", async () => {
		const probe = probeScopeOutsideNotAllows(sample, () =>
			createTgSecGuard({ mode: "auto", scopeResolver: outOfScope, dangerEvaluator: NO_DANGER }),
		);
		await expect(probe.run()).resolves.toBeUndefined();
	});

	it("fails when the chain allows the scope-outside call", async () => {
		const probe = probeScopeOutsideNotAllows(sample, () =>
			createTgSecGuard({ mode: "yolo", scopeResolver: ALL_IN_SCOPE, dangerEvaluator: NO_DANGER }),
		);
		await expect(probe.run()).rejects.toThrow(/must never resolve to allow/);
	});

	it("fails when the chain asks without forcing", async () => {
		const probe = probeScopeOutsideNotAllows(sample, () =>
			createTgSecGuard({ mode: "strict", scopeResolver: ALL_IN_SCOPE, dangerEvaluator: NO_DANGER }),
		);
		await expect(probe.run()).rejects.toThrow(/forced ask/);
	});
});

describe("probe 6: a call with no placement still enters the chain", () => {
	const sample: ToolHookCall = {
		type: "toolCall",
		id: "probe-6-sample",
		name: "read",
		arguments: { path: "src/index.ts" },
	};

	it("passes when decisionFor answers and records the guard span", async () => {
		const probe = probeUnaffiliatedCallEntersChain(sample, (telemetry) =>
			createTgSecGuard({ mode: "auto", scopeResolver: ALL_IN_SCOPE, dangerEvaluator: NO_DANGER, telemetry }),
		);
		await expect(probe.run()).resolves.toBeUndefined();
	});

	it("fails on the P1-5 bypass shape: an early return with no decision", async () => {
		const bypass = { decisionFor: async () => undefined } as unknown as TgSecGuard;
		const probe = probeUnaffiliatedCallEntersChain(sample, () => bypass);
		await expect(probe.run()).rejects.toThrow(/bypassed/);
	});

	it("fails when a decision arrives without a guard span", async () => {
		const untracked = { decisionFor: async () => ({ effect: "allow" }) } as unknown as TgSecGuard;
		const probe = probeUnaffiliatedCallEntersChain(sample, () => untracked);
		await expect(probe.run()).rejects.toThrow(/tg\.span\.sec\.guard/);
	});

	it("observes the span the real chain wrote", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const guard = createTgSecGuard({
			mode: "auto",
			scopeResolver: ALL_IN_SCOPE,
			dangerEvaluator: NO_DANGER,
			telemetry,
		});
		await guard.decisionFor(toTgSecRequest(sample));
		expect(telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard").length).toBe(1);
	});
});

describe("runTgSecAttestation", () => {
	it("runs every probe when all pass", async () => {
		const seen: string[] = [];
		const probes = ["one", "two"].map((name) => ({
			name,
			run: async () => {
				seen.push(name);
			},
		}));
		await expect(runTgSecAttestation(probes)).resolves.toBeUndefined();
		expect(seen).toEqual(["one", "two"]);
	});

	it("stops at the first failure and names the probe", async () => {
		let ran = 0;
		const probes = [
			{ name: "first", run: async () => {} },
			{
				name: "second",
				run: async () => {
					ran += 1;
					throw new Error("boom");
				},
			},
			{
				name: "third",
				run: async () => {
					ran += 1;
				},
			},
		];
		await expect(runTgSecAttestation(probes)).rejects.toThrow('attestation probe "second" failed: boom');
		expect(ran).toBe(1);
	});
});

describe("guard.attest end to end", () => {
	const DECLARED = ["read", "shell"];
	const OUT_OF_SCOPE_SAMPLE: ToolHookCall = {
		type: "toolCall",
		id: "attest-sample",
		name: "netfetch",
		arguments: { url: "x" },
	};
	const netfetchOutside: TgSecScopeResolver = (request) =>
		request.toolName === "netfetch" ? { inScope: false } : { inScope: true };

	function attestContext(over: Partial<TgSecAttestContext> = {}): TgSecAttestContext {
		return {
			context,
			modeReader: { snapshot: async <T extends JsonObject>() => ({ mode: "auto" }) as unknown as Readonly<T> },
			hookApi: { snapshot: async () => ({ mode: "auto" }) } as unknown as HookApi,
			forbiddenRead: async () => {
				throw eaccesError();
			},
			registeredTools: DECLARED,
			declaredTools: DECLARED,
			forcedAskSample: OUT_OF_SCOPE_SAMPLE,
			probeGuard: { mode: "auto", scopeResolver: netfetchOutside, dangerEvaluator: NO_DANGER },
			...over,
		};
	}

	/** The out-of-scope resolver makes the sample a forced ask; no ask channel means it blocks. */
	function guarded() {
		return createTgSecGuard({ mode: "auto", scopeResolver: netfetchOutside, dangerEvaluator: NO_DANGER });
	}

	it("passes when every probe holds", async () => {
		await expect(guarded().attest(attestContext())).resolves.toBeUndefined();
	});

	it("throws when the tool set drifts (probe 4 negative)", async () => {
		await expect(guarded().attest(attestContext({ registeredTools: ["read"] }))).rejects.toThrow(
			'attestation probe "tool-set-alignment" failed',
		);
	});

	it("throws when the env does not refuse the forbidden read (probe 1 negative)", async () => {
		await expect(guarded().attest(attestContext({ forbiddenRead: async () => "leaked" }))).rejects.toThrow(
			'attestation probe "restricted-env" failed',
		);
	});

	it("throws when the mode document is corrupt (probe 5 negative)", async () => {
		const corrupt = {
			modeReader: { snapshot: async <T extends JsonObject>() => ({ mode: "bogus" }) as unknown as Readonly<T> },
		};
		await expect(guarded().attest(attestContext(corrupt))).rejects.toThrow(
			'attestation probe "mode-document" failed',
		);
	});

	it("the sample is a forced ask through the public chain, and the probe confirms it by executing (probe 7 wiring)", async () => {
		const decision = await guarded().decisionFor(toTgSecRequest(attestContext().forcedAskSample));
		expect(decision).toEqual({ effect: "ask", reason: "the target is outside the registered scope", forced: true });
		await expect(guarded().attest(attestContext())).resolves.toBeUndefined();
	});

	it("the host guard's ask channel does not soften probe 7: the probe builds its own guard", async () => {
		const withChannel = createTgSecGuard({
			mode: "auto",
			scopeResolver: netfetchOutside,
			dangerEvaluator: NO_DANGER,
			askChannel: async () => "allow",
		});
		await expect(withChannel.attest(attestContext())).resolves.toBeUndefined();
	});

	it("fails when the probeGuard pieces allow the sample, whatever the host claims (rebuilt fake-host negative)", async () => {
		const permissive = {
			probeGuard: { mode: "auto" as const, scopeResolver: ALL_IN_SCOPE, dangerEvaluator: NO_DANGER },
		};
		// Batch 1b registered probe 2 ahead of probe 7 in the default sequence, and probe 2 catches
		// this shape first: the assertion moved from "forced-ask-fails-closed" to probe 2's name.
		// Fail-closed coverage is unchanged — an allowing chain is still caught before the attestation ends.
		await expect(guarded().attest(attestContext(permissive))).rejects.toThrow(
			'attestation probe "scope-outside-not-allow" failed',
		);
	});

	it("runs probe 2 in the default sequence: the sample must not resolve to allow", async () => {
		const permissive = {
			probeGuard: { mode: "yolo" as const, scopeResolver: ALL_IN_SCOPE, dangerEvaluator: NO_DANGER },
		};
		await expect(guarded().attest(attestContext(permissive))).rejects.toThrow(/must never resolve to allow/);
	});

	it("runs probe 6 in the default sequence: the unaffiliated call walks the real chain", async () => {
		const hostile: TgSecScopeResolver = (req) => {
			// Probe 2's sample (netfetch) stays a clean forced ask; probe 6's read-path sample
			// explodes inside the resolver, which only happens if probe 6 actually ran the chain.
			if (req.toolName === "netfetch") return { inScope: false };
			throw new Error("resolver exploded");
		};
		const pieces = { probeGuard: { mode: "auto" as const, scopeResolver: hostile, dangerEvaluator: NO_DANGER } };
		await expect(guarded().attest(attestContext(pieces))).rejects.toThrow(
			'attestation probe "unaffiliated-call-enters-chain" failed',
		);
	});
});
