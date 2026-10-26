import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import type { HookApi, JsonObject, ToolHookCall } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { describe, expect, it } from "vitest";
import {
	createInMemoryGrantStore,
	createTgSecDangerEvaluator,
	createTgSecGuard,
	createTgSecRuleTable,
	createTgSecScopeRegistry,
	createTgSecScopeResolver,
	createTgSecTwoAxisJudge,
	probeDangerSetForcesAskPastGrants,
	probeForcedAskBlocks,
	probeJudgeTimeoutAsks,
	probeJudgeTransportErrorAsks,
	probeModeDocument,
	probeRestrictedEnv,
	probeRuleDenyForcesAskPastExemptions,
	probeScopeOutsideNotAllows,
	probeStrictIgnoresRuleAllow,
	probeToolSetAlignment,
	probeUnaffiliatedCallEntersChain,
	runTgSecAttestation,
	type TgSecAttestContext,
	type TgSecDangerEvaluator,
	type TgSecGuard,
	type TgSecRuleTable,
	type TgSecScopeResolver,
	type TgSecScopeRule,
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
		await expect(probe.run()).rejects.toThrow(/expected an EACCES\/EPERM refusal/);
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
	// Batch 1d rewrote this suite around the real registry engine: the three first cases below walk
	// the same chain the product walks — extraction, evidence tiers, deny-over-allow verdict — instead
	// of trusting an injected fake resolver. Hosts sit in the TEST-NET documentation ranges and the
	// probe guards pin `hostAddresses: []`, so any ask here can only come from the scope layer, never
	// from self-protection.
	const allowNet: TgSecScopeRule = { kind: "cidr4", pattern: "203.0.113.0/24", effect: "allow", enabled: true };
	const denyGateway: TgSecScopeRule = { kind: "exact-host", pattern: "203.0.113.7", effect: "deny", enabled: true };

	function netfetch(url: string): ToolHookCall {
		return { type: "toolCall", id: "probe-2-sample", name: "netfetch", arguments: { url } };
	}

	function registryGuard(...rules: readonly TgSecScopeRule[]): () => TgSecGuard {
		return () =>
			createTgSecGuard({
				mode: "auto",
				scopeResolver: createTgSecScopeResolver(createTgSecScopeRegistry(rules)),
				dangerEvaluator: NO_DANGER,
				hostAddresses: [],
			});
	}

	it("lets a CIDR-inside target through the real engine", async () => {
		const decision = await registryGuard(allowNet)().decisionFor(toTgSecRequest(netfetch("http://203.0.113.5/")));
		expect(decision).toEqual({ effect: "allow" });
	});

	it("passes on a CIDR-outside target: the real engine forces the ask", async () => {
		const probe = probeScopeOutsideNotAllows(netfetch("http://198.51.100.2/"), registryGuard(allowNet));
		await expect(probe.run()).resolves.toBeUndefined();
	});

	it("passes when a deny hit inside an allowed CIDR refuses the host: deny over allow, at the probe", async () => {
		// 定调 2 asserted where it matters — through the whole chain. The host matches the allowed /24
		// and a /32 deny; the decision must be a forced ask naming the deny entry, and the probe must
		// accept it as the out-of-scope shape.
		const outside = netfetch("http://203.0.113.7/");
		const probe = probeScopeOutsideNotAllows(outside, registryGuard(allowNet, denyGateway));
		await expect(probe.run()).resolves.toBeUndefined();
		const decision = await registryGuard(allowNet, denyGateway)().decisionFor(toTgSecRequest(outside));
		expect(decision.effect).toBe("ask");
		if (decision.effect === "ask") {
			expect(decision.forced).toBe(true);
			expect(decision.reason).toContain('refused by the scope deny entry "203.0.113.7"');
		}
	});

	it("fails when the chain allows the scope-outside call", async () => {
		const probe = probeScopeOutsideNotAllows(sample, () =>
			createTgSecGuard({ mode: "yolo", scopeResolver: ALL_IN_SCOPE, dangerEvaluator: NO_DANGER }),
		);
		await expect(probe.run()).rejects.toThrow(/must never resolve to allow/);
	});

	it("fails when a real registry permits everything, so no sample is ever outside", async () => {
		// The same negative as above, produced by the engine rather than a fake resolver: a /0 allow
		// empties the concept of "scope-outside", and the probe must not pass.
		const probe = probeScopeOutsideNotAllows(
			netfetch("http://198.51.100.2/"),
			registryGuard({ kind: "cidr4", pattern: "0.0.0.0/0", effect: "allow", enabled: true }),
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

describe("probe 3: danger set forces ask past grants", () => {
	const sample: ToolHookCall = {
		type: "toolCall",
		id: "probe-3-sample",
		name: "shell",
		arguments: { command: "crontab /etc/cron.d/revshell" },
	};
	const IN_SCOPE: TgSecScopeResolver = () => ({ inScope: true });
	const outOfScope: TgSecScopeResolver = () => ({ inScope: false });

	// The exact wiring guard.attest uses: `yolo` (the most exempt mode) with the sample's resource
	// already carrying an `always` grant. Only a chain immune to both at once can pass.
	function probe(dangerEvaluator: TgSecDangerEvaluator, scopeResolver: TgSecScopeResolver = IN_SCOPE) {
		return probeDangerSetForcesAskPastGrants(sample, (telemetry) => {
			const grants = createInMemoryGrantStore();
			grants.add("tool:shell");
			return createTgSecGuard({ mode: "yolo", scopeResolver, dangerEvaluator, grants, telemetry });
		});
	}

	it("passes when the real danger set forces the ask past the standing grant", async () => {
		await expect(probe(createTgSecDangerEvaluator({ objective: "redteam" })).run()).resolves.toBeUndefined();
	});

	it("fails when the evaluator does not hit: yolo plus the standing grant would allow the call", async () => {
		await expect(probe(NO_DANGER).run()).rejects.toThrow(/must force an ask/);
	});

	it("fails when the forced ask comes from another layer: the sample must test the danger set", async () => {
		// Same decision shape, wrong reason: a scope refusal would satisfy the decision checks on its
		// own, so the probe reads the guard span's `layer` attribute and demands `danger`.
		await expect(probe(NO_DANGER, outOfScope).run()).rejects.toThrow(/must come from the danger layer/);
	});

	it("fails when no guard span was recorded", async () => {
		const untracked = {
			decisionFor: async () => ({ effect: "ask", reason: "x", forced: true }),
		} as unknown as TgSecGuard;
		await expect(probeDangerSetForcesAskPastGrants(sample, () => untracked).run()).rejects.toThrow(
			/exactly one tg\.span\.sec\.guard/,
		);
	});
});

describe("probe 8: a rule deny forces its ask past every exemption", () => {
	const sample: ToolHookCall = {
		type: "toolCall",
		id: "probe-8-sample",
		name: "shell",
		arguments: { command: "ls -la" },
	};
	const IN_SCOPE: TgSecScopeResolver = () => ({ inScope: true });
	const outOfScope: TgSecScopeResolver = () => ({ inScope: false });
	const table = (effect: "allow" | "deny"): TgSecRuleTable =>
		createTgSecRuleTable([
			{ id: "fixture-shell-rule", priority: 1000, pattern: "tool:shell", effect, enabled: true },
		]);

	// The exact wiring guard.attest uses: `yolo` plus a standing `always` grant on the sample's
	// resource plus the fixture rule. Only the rules layer's forced ask can clear this probe.
	function probe(rules: TgSecRuleTable, scopeResolver: TgSecScopeResolver = IN_SCOPE) {
		return probeRuleDenyForcesAskPastExemptions(sample, (telemetry) => {
			const grants = createInMemoryGrantStore();
			grants.add("tool:shell");
			return createTgSecGuard({ mode: "yolo", scopeResolver, dangerEvaluator: NO_DANGER, grants, rules, telemetry });
		});
	}

	it("passes when the deny rule forces the ask past yolo and the standing grant", async () => {
		await expect(probe(table("deny")).run()).resolves.toBeUndefined();
	});

	it("fails when the matching rule allows: yolo plus the grant releases the call", async () => {
		await expect(probe(table("allow")).run()).rejects.toThrow(/must force an ask/);
	});

	it("fails when the forced ask comes from another layer: the sample must test the rules table", async () => {
		// Same decision shape, wrong reason — the scope layer would satisfy the decision checks alone.
		await expect(probe(createTgSecRuleTable([]), outOfScope).run()).rejects.toThrow(/must come from the rules layer/);
	});

	it("fails when no guard span was recorded", async () => {
		const untracked = {
			decisionFor: async () => ({ effect: "ask", reason: "x", forced: true }),
		} as unknown as TgSecGuard;
		await expect(probeRuleDenyForcesAskPastExemptions(sample, () => untracked).run()).rejects.toThrow(
			/exactly one tg\.span\.sec\.guard/,
		);
	});
});

describe("probe 9: strict ignores a matching rule allow", () => {
	const sample: ToolHookCall = {
		type: "toolCall",
		id: "probe-9-sample",
		name: "read",
		arguments: { path: "notes.md" },
	};
	const allowRead = createTgSecRuleTable([
		{ id: "fixture-allow-read", priority: 1000, pattern: "tool:read", effect: "allow", enabled: true },
	]);
	const askRead = createTgSecRuleTable([
		{ id: "fixture-ask-read", priority: 1000, pattern: "tool:read", effect: "ask", enabled: true },
	]);

	function probe(mode: "strict" | "judge-auto", rules: TgSecRuleTable) {
		return probeStrictIgnoresRuleAllow(sample, (telemetry) =>
			createTgSecGuard({
				mode,
				scopeResolver: ALL_IN_SCOPE,
				dangerEvaluator: NO_DANGER,
				rules,
				// judge-auto construction fails closed without a judge; the allow judge is exactly what
				// must not be consulted when a matching allow rule is present, and the negative proves it.
				judge: async () => ({ decision: "allow" as const, comment: "healthy judge" }),
				telemetry,
			}),
		);
	}

	it("passes on strict with a matching allow rule: the ask comes from mode dispatch", async () => {
		await expect(probe("strict", allowRead).run()).resolves.toBeUndefined();
	});

	it("fails when the allow leaks through: judge-auto takes the same rule and answers allow", async () => {
		// The negative proves the probe is watching this rule, not a coincidence: only the mode
		// semantics differ between the two guards.
		await expect(probe("judge-auto", allowRead).run()).rejects.toThrow(/got allow/);
	});

	it("fails when the ask is attributed to the rules layer: an ask rule on strict is not mode dispatch", async () => {
		await expect(probe("strict", askRead).run()).rejects.toThrow(/must come from mode dispatch/);
	});
});

describe("probes 10 and 11: a degraded judge escalates", () => {
	const sample: ToolHookCall = {
		type: "toolCall",
		id: "probe-10-sample",
		name: "read",
		arguments: { path: "notes.md" },
	};
	const errorJudge = createTgSecTwoAxisJudge({
		transport: {
			complete: () => {
				throw new Error("attestation transport failure");
			},
		},
		timeoutMs: 1000,
	});
	const hangingJudge = createTgSecTwoAxisJudge({
		transport: { complete: () => new Promise<string>(() => {}) },
		timeoutMs: 5,
	});
	const allowJudge = createTgSecTwoAxisJudge({
		transport: { complete: async () => '{"decision":"allow","comment":"fine"}' },
		timeoutMs: 1000,
	});

	function probe10(judge: ReturnType<typeof createTgSecTwoAxisJudge>) {
		return probeJudgeTransportErrorAsks(sample, (telemetry) =>
			createTgSecGuard({
				mode: "judge-auto",
				scopeResolver: ALL_IN_SCOPE,
				dangerEvaluator: NO_DANGER,
				judge,
				telemetry,
			}),
		);
	}
	function probe11(judge: ReturnType<typeof createTgSecTwoAxisJudge>) {
		return probeJudgeTimeoutAsks(sample, (telemetry) =>
			createTgSecGuard({
				mode: "judge-auto",
				scopeResolver: ALL_IN_SCOPE,
				dangerEvaluator: NO_DANGER,
				judge,
				telemetry,
			}),
		);
	}

	it("probe 10 passes when the transport throws: the ask is attributed to the mode layer", async () => {
		await expect(probe10(errorJudge).run()).resolves.toBeUndefined();
	});

	it("probe 10 fails when the judge answers healthily: nothing degraded, nothing tested", async () => {
		await expect(probe10(allowJudge).run()).rejects.toThrow(/must escalate/);
	});

	it("probe 11 passes when the transport hangs past its budget", async () => {
		await expect(probe11(hangingJudge).run()).resolves.toBeUndefined();
	});

	it("probe 11 fails when the judge answers inside the budget", async () => {
		await expect(probe11(allowJudge).run()).rejects.toThrow(/must escalate/);
	});

	it("both fail when no guard span was recorded", async () => {
		const untracked = {
			decisionFor: async () => ({ effect: "ask", reason: "x", forced: false }),
		} as unknown as TgSecGuard;
		await expect(probeJudgeTransportErrorAsks(sample, () => untracked).run()).rejects.toThrow(
			/exactly one tg\.span\.sec\.guard/,
		);
		await expect(probeJudgeTimeoutAsks(sample, () => untracked).run()).rejects.toThrow(
			/exactly one tg\.span\.sec\.guard/,
		);
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
	// Probe 3's sample: in scope for `netfetchOutside`, clean for every layer ahead of danger, and a
	// redteam-armed danger rule (`--os-shell`). The fixture dogfoods the real evaluator rather than a
	// fake: the e2e attestation is where the built set and the chain meet.
	const DANGER_SAMPLE: ToolHookCall = {
		type: "toolCall",
		id: "attest-danger-sample",
		name: "shell",
		arguments: { command: "sqlmap -u http://target.invalid/ --os-shell" },
	};
	const REDTEAM_DANGER = createTgSecDangerEvaluator({ objective: "redteam" });
	// Probes 8-11's sample: in scope, no weak-evidence candidate, no danger match, so the forced ask
	// probe 8 demands can only come from the rules layer and probe 9's strict ask can only come from
	// mode dispatch. The probes wire their own fixture rules and broken judges around this call.
	const RULES_SAMPLE: ToolHookCall = {
		type: "toolCall",
		id: "attest-rules-sample",
		name: "shell",
		arguments: { command: "ls -la" },
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
			dangerSample: DANGER_SAMPLE,
			rulesSample: RULES_SAMPLE,
			probeGuard: { mode: "auto", scopeResolver: netfetchOutside, dangerEvaluator: REDTEAM_DANGER },
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

	it("runs probe 3 in the default sequence: the danger sample must force its ask", async () => {
		// Probe 2 passes (netfetchOutside still refuses it), so the attestation advances to probe 3 —
		// where a chain that does not hit the danger set on the sample fails the attestation.
		const noDanger = {
			probeGuard: { mode: "auto" as const, scopeResolver: netfetchOutside, dangerEvaluator: NO_DANGER },
		};
		await expect(guarded().attest(attestContext(noDanger))).rejects.toThrow(
			'attestation probe "danger-set-forced-ask-past-grants" failed',
		);
	});

	it("runs probe 6 in the default sequence: the unaffiliated call walks the real chain", async () => {
		const hostile: TgSecScopeResolver = (req) => {
			// Probe 2's sample (netfetch) stays a clean forced ask and probe 3's sample (shell) stays
			// in scope; probe 6's read-path sample explodes inside the resolver, which only happens if
			// probe 6 actually ran the chain.
			if (req.toolName === "netfetch") return { inScope: false };
			if (req.toolName === "shell") return { inScope: true };
			throw new Error("resolver exploded");
		};
		const pieces = {
			probeGuard: { mode: "auto" as const, scopeResolver: hostile, dangerEvaluator: REDTEAM_DANGER },
		};
		await expect(guarded().attest(attestContext(pieces))).rejects.toThrow(
			'attestation probe "unaffiliated-call-enters-chain" failed',
		);
	});

	it("runs probes 8-11 in the default sequence: a rulesSample that is not silent on the earlier layers is caught", async () => {
		// `crontab -e` matches the redteam danger set. Probe 8 still passes — its deny rule sits ahead
		// of danger in the chain and attributes the ask to the rules layer either way. Probe 9's allow
		// rule cannot short-circuit an allow-shaped hit, so the strict guard's ask comes from the
		// danger layer, not mode dispatch, and the attestation fails exactly there.
		const notSilent: ToolHookCall = {
			type: "toolCall",
			id: "attest-rules-sample-danger",
			name: "shell",
			arguments: { command: "crontab -e" },
		};
		await expect(guarded().attest(attestContext({ rulesSample: notSilent }))).rejects.toThrow(
			'attestation probe "strict-ignores-rule-allow" failed',
		);
	});
});
