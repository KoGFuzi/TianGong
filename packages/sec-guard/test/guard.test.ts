import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import type { HookApi, JsonObject, ToolHookCall, Tx } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { describe, expect, it } from "vitest";
import {
	createInMemoryGrantStore,
	createTgSecDangerEvaluator,
	createTgSecGuard,
	createTgSecRuleTable,
	createTgSecTwoAxisJudge,
	TG_SEC_MODES,
	type TgSecAskChannel,
	type TgSecDangerEvaluator,
	type TgSecGuardOptions,
	type TgSecJudgeTransport,
	type TgSecPermissionMode,
	type TgSecRequest,
	type TgSecRule,
	type TgSecScopeResolver,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const IN_SCOPE: TgSecScopeResolver = () => ({ inScope: true });
const NO_DANGER: TgSecDangerEvaluator = () => ({ hit: false });
const JUDGE_ALLOW = async () => ({ decision: "allow" as const, comment: "" });

function request(toolName: string, args: Record<string, unknown>): TgSecRequest {
	return { toolName, resource: `tool:${toolName}`, arguments: args };
}

const NORMAL = request("read", { path: "src/index.ts" });
const RM_ROOT = request("shell", { command: "rm -rf /" });

function guard(mode: TgSecPermissionMode, over: Partial<TgSecGuardOptions> = {}) {
	return createTgSecGuard({
		mode,
		scopeResolver: IN_SCOPE,
		dangerEvaluator: NO_DANGER,
		judge: JUDGE_ALLOW,
		...over,
	});
}

function fakeApi(mode: string | undefined): HookApi {
	return { snapshot: async () => (mode === undefined ? undefined : { mode }) } as unknown as HookApi;
}

let callCounter = 0;
function toolCall(name: string, args: ToolHookCall["arguments"]): ToolHookCall {
	callCounter += 1;
	return { type: "toolCall", id: `call-${callCounter}`, name, arguments: args };
}

describe("construction fails closed", () => {
	it("rejects a missing scope resolver", () => {
		expect(() => createTgSecGuard({ mode: "auto", dangerEvaluator: NO_DANGER })).toThrow(
			/scope resolver is required/,
		);
	});

	it("rejects a missing danger evaluator", () => {
		expect(() => createTgSecGuard({ mode: "auto", scopeResolver: IN_SCOPE })).toThrow(/danger evaluator is required/);
	});

	it("rejects judge-auto without a judge", () => {
		expect(() =>
			createTgSecGuard({ mode: "judge-auto", scopeResolver: IN_SCOPE, dangerEvaluator: NO_DANGER }),
		).toThrow(/judge-auto requires an injected judge/);
	});

	it("rejects a mode outside the four", () => {
		const bogus: string = "permissive";
		expect(() =>
			createTgSecGuard({
				mode: bogus as TgSecPermissionMode,
				scopeResolver: IN_SCOPE,
				dangerEvaluator: NO_DANGER,
			}),
		).toThrow(TypeError);
	});
});

describe("mode matrix: four modes by normal and hard-deny request", () => {
	const expected: Record<TgSecPermissionMode, "allow" | "ask"> = {
		strict: "ask",
		"judge-auto": "allow",
		auto: "allow",
		yolo: "allow",
	};
	for (const mode of TG_SEC_MODES) {
		it(`${mode}: a normal request resolves to ${expected[mode]}`, async () => {
			const decision = await guard(mode).decisionFor(NORMAL);
			expect(decision.effect).toBe(expected[mode]);
			if (decision.effect === "ask") {
				expect(decision.forced).toBe(false);
			}
		});
		it(`${mode}: rm -rf / is denied outright`, async () => {
			const decision = await guard(mode).decisionFor(RM_ROOT);
			expect(decision.effect).toBe("deny");
			if (decision.effect === "deny") expect(decision.hard).toBe(true);
		});
	}

	it("an out-of-scope target forces an ask even in yolo", async () => {
		const out: TgSecScopeResolver = (req) => (req.toolName === "netfetch" ? { inScope: false } : { inScope: true });
		const decision = await guard("yolo", { scopeResolver: out }).decisionFor(request("netfetch", { url: "x" }));
		expect(decision).toEqual({ effect: "ask", reason: "the target is outside the registered scope", forced: true });
	});

	it("a danger-set hit forces an ask even in yolo", async () => {
		const danger: TgSecDangerEvaluator = () => ({ hit: true, reason: "matches the danger set" });
		const decision = await guard("yolo", { dangerEvaluator: danger }).decisionFor(NORMAL);
		expect(decision).toEqual({ effect: "ask", reason: "matches the danger set", forced: true });
	});
});

describe("judge behavior in judge-auto", () => {
	const base = { mode: "judge-auto" as const, scopeResolver: IN_SCOPE, dangerEvaluator: NO_DANGER };

	it("a judge ask surfaces as a non-forced ask carrying the judge comment", async () => {
		const g = createTgSecGuard({ ...base, judge: async () => ({ decision: "ask", comment: "needs review" }) });
		const decision = await g.decisionFor(NORMAL);
		expect(decision).toEqual({ effect: "ask", reason: "needs review", forced: false });
	});

	it("a judge failure escalates to a human instead of allowing or denying", async () => {
		const g = createTgSecGuard({
			...base,
			judge: async () => {
				throw new Error("provider down");
			},
		});
		const decision = await g.decisionFor(NORMAL);
		expect(decision.effect).toBe("ask");
		if (decision.effect === "ask") expect(decision.reason).toContain("provider down");
	});

	it("a judge timeout falls back to an ask", async () => {
		const g = createTgSecGuard({ ...base, judge: () => new Promise(() => {}), judgeTimeoutMs: 5 });
		const decision = await g.decisionFor(NORMAL);
		expect(decision.effect).toBe("ask");
		if (decision.effect === "ask") expect(decision.reason).toContain("timed out");
	});

	it("a judge has no deny power: even a rogue deny decision surfaces as an ask", async () => {
		const rogue: { decision: string; comment: string } = { decision: "deny", comment: "rogue" };
		const g = createTgSecGuard({
			...base,
			judge: async () => ({ decision: rogue.decision as "allow", comment: rogue.comment }),
		});
		const decision = await g.decisionFor(NORMAL);
		expect(decision.effect).toBe("ask");
	});
});

describe("grants", () => {
	it("a stored grant does not exempt strict: the call still asks", async () => {
		const grants = createInMemoryGrantStore();
		grants.add("tool:read");
		const decision = await guard("strict", { grants }).decisionFor(NORMAL);
		expect(decision).toEqual({
			effect: "ask",
			reason: "strict mode puts every tool call in front of a human",
			forced: false,
		});
	});

	it("a stored grant does not exempt judge-auto from the judge", async () => {
		const grants = createInMemoryGrantStore();
		grants.add("tool:read");
		let judged = 0;
		const judge = async () => {
			judged += 1;
			return { decision: "ask" as const, comment: "the judge wants a human" };
		};
		const decision = await guard("judge-auto", { grants, judge }).decisionFor(NORMAL);
		expect(judged).toBe(1);
		expect(decision).toEqual({ effect: "ask", reason: "the judge wants a human", forced: false });
	});

	it("a grant hit in auto allows the call and is recorded on the grants layer", async () => {
		const grants = createInMemoryGrantStore();
		grants.add("tool:read");
		const telemetry = new InMemoryTelemetryContext();
		const decision = await guard("auto", { grants, telemetry }).decisionFor(NORMAL);
		expect(decision).toEqual({ effect: "allow" });
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans.length).toBe(1);
		expect(spans[0].attributes).toMatchObject({ mode: "auto", layer: "grants", effect: "allow" });
	});

	it("a forced ask is immune to grants", async () => {
		const grants = createInMemoryGrantStore();
		grants.add("tool:netfetch");
		const out: TgSecScopeResolver = () => ({ inScope: false });
		const decision = await guard("auto", { grants, scopeResolver: out }).decisionFor(
			request("netfetch", { url: "x" }),
		);
		expect(decision.effect).toBe("ask");
		if (decision.effect === "ask") expect(decision.forced).toBe(true);
	});

	it("an always reply to a non-forced ask grants the exact resource for the rest of the session", async () => {
		let asked = 0;
		const askChannel: TgSecAskChannel = async () => {
			asked += 1;
			return "always";
		};
		const g = guard("strict", { askChannel });
		const first = await g.beforeTool(toolCall("read", { path: "src/index.ts" }), fakeApi("strict"), context);
		expect(first).toBeUndefined();
		expect(asked).toBe(1);
		// strict never consults grants, so a second strict call escalates to the human again...
		const again = await g.beforeTool(toolCall("read", { path: "src/other.ts" }), fakeApi("strict"), context);
		expect(again).toBeUndefined();
		expect(asked).toBe(2);
		// ...while the recorded grant is honored by the mode that does consult it.
		const honored = await g.beforeTool(toolCall("read", { path: "src/third.ts" }), fakeApi("auto"), context);
		expect(honored).toBeUndefined();
		expect(asked).toBe(2);
	});

	it("an always reply to a forced ask never records a grant", async () => {
		let asked = 0;
		const askChannel: TgSecAskChannel = async () => {
			asked += 1;
			return "always";
		};
		const out: TgSecScopeResolver = () => ({ inScope: false });
		const g = guard("yolo", { askChannel, scopeResolver: out });
		await expect(g.beforeTool(toolCall("netfetch", { url: "x" }), fakeApi("yolo"), context)).resolves.toBeUndefined();
		expect(asked).toBe(1);
		await expect(g.beforeTool(toolCall("netfetch", { url: "y" }), fakeApi("yolo"), context)).resolves.toBeUndefined();
		expect(asked).toBe(2);
	});
});

describe("beforeTool adapter", () => {
	it("allows an in-chain call in auto", async () => {
		const result = await guard("auto").beforeTool(toolCall("read", { path: "a.ts" }), fakeApi("auto"), context);
		expect(result).toBeUndefined();
	});

	it("the live document mode wins over the constructed mode", async () => {
		const result = await guard("strict").beforeTool(toolCall("read", { path: "a.ts" }), fakeApi("yolo"), context);
		expect(result).toBeUndefined();
	});

	it("blocks a hard denial in every mode without consulting the ask channel", async () => {
		let asked = 0;
		const askChannel: TgSecAskChannel = async () => {
			asked += 1;
			return "allow";
		};
		const result = await guard("yolo", { askChannel }).beforeTool(
			toolCall("shell", { command: "rm -rf /" }),
			fakeApi("yolo"),
			context,
		);
		expect(result).toEqual({ block: "hard deny: recursive forced removal of the filesystem root" });
		expect(asked).toBe(0);
	});

	it("an ask without an ask channel blocks, fail-closed", async () => {
		const result = await guard("auto").beforeTool(toolCall("read", { path: "a.ts" }), fakeApi("strict"), context);
		expect(result?.block).toMatch(/fails closed without an ask channel/);
	});

	it("an ask with a channel follows the reply", async () => {
		const approve: TgSecAskChannel = async () => "allow";
		const refuse: TgSecAskChannel = async () => "deny";
		const ok = await guard("auto", { askChannel: approve }).beforeTool(
			toolCall("read", { path: "a.ts" }),
			fakeApi("strict"),
			context,
		);
		expect(ok).toBeUndefined();
		const blocked = await guard("auto", { askChannel: refuse }).beforeTool(
			toolCall("read", { path: "a.ts" }),
			fakeApi("strict"),
			context,
		);
		expect(blocked?.block).toMatch(/strict mode/);
	});

	it("a corrupt mode document throws instead of degrading: the harness turns the throw into a block", async () => {
		await expect(
			guard("auto").beforeTool(toolCall("read", { path: "a.ts" }), fakeApi("yololo"), context),
		).rejects.toThrow(TypeError);
	});
});

describe("weak self-protection evidence (batch 1c)", () => {
	it("a loopback mention in a command that never connects is a forced ask, not a deny", async () => {
		// The demotion of weak evidence lands on its own layer, ahead of the scope resolver and of
		// mode dispatch, so it asks in every mode and no grant can clear it.
		const telemetry = new InMemoryTelemetryContext();
		const decision = await guard("yolo", { telemetry }).decisionFor(
			request("shell", { command: "grep 127.0.0.1 access.log" }),
		);
		expect(decision).toEqual({ effect: "ask", reason: expect.stringContaining("127.0.0.1"), forced: true });
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans[0].attributes).toMatchObject({
			layer: "self-protection",
			effect: "ask",
			forced: true,
			rule: "self-protection.loopback-v4",
		});
	});

	it("a weak-evidence forced ask is immune to grants", async () => {
		const grants = createInMemoryGrantStore();
		grants.add("tool:shell");
		const decision = await guard("yolo", { grants }).decisionFor(request("shell", { command: "ping 127.0.0.1" }));
		expect(decision.effect).toBe("ask");
		if (decision.effect === "ask") expect(decision.forced).toBe(true);
	});

	it("a local interface address named as a bare token asks instead of denying", async () => {
		const decision = await guard("auto", { hostAddresses: ["192.168.1.5"] }).decisionFor(
			request("shell", { command: "nc 192.168.1.5 4444" }),
		);
		expect(decision).toEqual({ effect: "ask", reason: expect.stringContaining("192.168.1.5"), forced: true });
	});

	it("a report body that mentions loopback addresses is allowed outright", async () => {
		// False positive 2: the write body is a detail parameter, so it produces no candidate at all —
		// neither a deny nor an ask. A model must be able to write a report about the loopback address.
		const decision = await guard("yolo").decisionFor(
			request("write", { file_path: "report.md", content: "scanned localhost and 127.0.0.1; both answered" }),
		);
		expect(decision).toEqual({ effect: "allow" });
	});

	it("strong evidence still denies in every mode", async () => {
		for (const mode of TG_SEC_MODES) {
			const decision = await guard(mode).decisionFor(request("shell", { command: "curl http://localhost:8080/" }));
			expect(decision.effect).toBe("deny");
			if (decision.effect === "deny") expect(decision.hard).toBe(true);
		}
	});

	it("asks on a weak mention even when the registry has approved that host", async () => {
		// The two questions stay separate on purpose: registration answers "is this host permitted",
		// self-protection answers "is this host possibly this machine", and an approved loopback
		// mention still goes to a human because a hard deny would have no appeal.
		const decision = await guard("yolo").decisionFor(request("shell", { command: "ping 127.0.0.1" }));
		expect(decision).toEqual({ effect: "ask", reason: expect.stringContaining("127.0.0.1"), forced: true });
	});

	it("keeps the strict-mode answer an ask", async () => {
		// Unchanged in effect: strict asked before and asks now. It becomes a *forced* ask, so the
		// human reply cannot bank a standing grant for a call that may be hitting this machine.
		const decision = await guard("strict").decisionFor(request("shell", { command: "ping 127.0.0.1" }));
		expect(decision).toEqual({ effect: "ask", reason: expect.stringContaining("weak evidence"), forced: true });
	});

	it("an always reply to a weak-evidence ask banks no grant", async () => {
		let asked = 0;
		const askChannel: TgSecAskChannel = async () => {
			asked += 1;
			return "always";
		};
		const g = guard("auto", { askChannel });
		const command = { command: "ping localhost" };
		await expect(g.beforeTool(toolCall("shell", command), fakeApi("auto"), context)).resolves.toBeUndefined();
		expect(asked).toBe(1);
		// The reply banked nothing, so the second identical call reaches the human again.
		await expect(g.beforeTool(toolCall("shell", command), fakeApi("auto"), context)).resolves.toBeUndefined();
		expect(asked).toBe(2);
	});

	it("fails closed on a weak-evidence ask with no ask channel", async () => {
		const result = await guard("yolo").beforeTool(
			toolCall("shell", { command: "ping 127.0.0.1" }),
			fakeApi("yolo"),
			context,
		);
		expect(result?.block).toMatch(/fails closed without an ask channel/);
	});
});

describe("danger set in the chain (batch 2a)", () => {
	const REDTEAM = createTgSecDangerEvaluator({ objective: "redteam" });
	const DANGER_CALL = request("shell", { command: "crontab -e" });

	it("a danger hit is a forced ask under yolo with a standing always grant on the resource", async () => {
		// Both exemptions at once, the strongest allow-shaped setting the chain can be put in: the mode
		// that exempts everything and a grant for this exact resource. The answer is still an ask.
		const grants = createInMemoryGrantStore();
		grants.add("tool:shell");
		const telemetry = new InMemoryTelemetryContext();
		const marked = request("shell", { command: "crontab -e top-secret-token" });
		const decision = await guard("yolo", { dangerEvaluator: REDTEAM, grants, telemetry }).decisionFor(marked);
		expect(decision).toEqual({ effect: "ask", reason: expect.stringContaining("danger set"), forced: true });
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans.length).toBe(1);
		expect(spans[0].attributes).toMatchObject({
			mode: "yolo",
			layer: "danger",
			effect: "ask",
			forced: true,
			rule: "danger.persist.crontab",
		});
		// The span stays closed-vocabulary. The leak test reads for the argument value, not for a token
		// the rule id legitimately shares with it: `danger.persist.crontab` names the matched family.
		const serialized = JSON.stringify(telemetry.getSpans());
		expect(serialized).not.toContain("top-secret-token");
		expect(serialized).not.toContain("crontab -e");
	});

	it("the danger ask is forced in every mode, unlike the mode-layer ask", async () => {
		for (const mode of TG_SEC_MODES) {
			const decision = await guard(mode, { dangerEvaluator: REDTEAM }).decisionFor(DANGER_CALL);
			expect(decision.effect, mode).toBe("ask");
			if (decision.effect === "ask") expect(decision.forced, mode).toBe(true);
		}
	});

	it("an always reply to a danger ask approves the call and banks no grant", async () => {
		let asked = 0;
		const askChannel: TgSecAskChannel = async () => {
			asked += 1;
			return "always";
		};
		const grants = createInMemoryGrantStore();
		const g = guard("auto", { askChannel, dangerEvaluator: REDTEAM, grants });
		await expect(
			g.beforeTool(toolCall("shell", { command: "crontab -e" }), fakeApi("auto"), context),
		).resolves.toBeUndefined();
		expect(asked).toBe(1);
		expect(grants.has("tool:shell")).toBe(false);
		// The second identical call reaches the human again: the reply was for that call only.
		await expect(
			g.beforeTool(toolCall("shell", { command: "crontab -e" }), fakeApi("auto"), context),
		).resolves.toBeUndefined();
		expect(asked).toBe(2);
	});

	it("an injected evaluator that hits without naming a rule leaves the span's rule attribute absent", async () => {
		// The seam widens, it does not force: `rule` is optional on the hit and optional on the span,
		// so a host evaluator keeps working while the built-in ids remain the closed vocabulary.
		const anonymous: TgSecDangerEvaluator = () => ({ hit: true, reason: "host rule fired" });
		const telemetry = new InMemoryTelemetryContext();
		const decision = await guard("auto", { dangerEvaluator: anonymous, telemetry }).decisionFor(NORMAL);
		expect(decision).toEqual({ effect: "ask", reason: "host rule fired", forced: true });
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect("rule" in spans[0].attributes).toBe(false);
	});

	it("a clean call still reaches mode dispatch and allows, so the set is not a blanket ask", async () => {
		const decision = await guard("yolo", { dangerEvaluator: REDTEAM }).decisionFor(NORMAL);
		expect(decision).toEqual({ effect: "allow" });
	});
});

describe("switchMode", () => {
	function fakeSessionPort(stored: { mode: string }) {
		return {
			stored,
			snapshot: async <T extends JsonObject>() => stored as unknown as Readonly<T>,
			commit: async <T>(change: (tx: Tx) => T | Promise<T>) => change({ doc: async () => stored } as unknown as Tx),
		};
	}

	it("refuses to switch without a session port", async () => {
		await expect(guard("auto").switchMode("yolo", "operator-1", context)).rejects.toThrow(/without a session port/);
	});

	it("refuses a switch to judge-auto without a judge", async () => {
		const session = fakeSessionPort({ mode: "auto" });
		const g = createTgSecGuard({
			mode: "auto",
			scopeResolver: IN_SCOPE,
			dangerEvaluator: NO_DANGER,
			session,
		});
		await expect(g.switchMode("judge-auto", "operator-1", context)).rejects.toThrow(/without an injected judge/);
		expect(session.stored.mode).toBe("auto");
	});

	it("a successful switch changes the mode the next decision uses", async () => {
		const session = fakeSessionPort({ mode: "auto" });
		const g = guard("auto", { session });
		await g.switchMode("strict", "operator-1", context);
		expect(session.stored.mode).toBe("strict");
		const decision = await g.decisionFor(NORMAL);
		expect(decision.effect).toBe("ask");
	});
});

describe("guard spans", () => {
	it("every decision records exactly one tg.span.sec.guard with closed-vocabulary attributes", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const g = guard("auto", { telemetry });
		const decision = await g.decisionFor(request("shell", { command: "rm -rf / top-secret-token" }));
		expect(decision.effect).toBe("deny");
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans.length).toBe(1);
		expect(spans[0].attributes).toMatchObject({
			mode: "auto",
			layer: "hard-deny",
			effect: "deny",
			rule: "self-destruction.rm-root",
		});
		expect(String(spans[0].attributes.argsDigest)).toMatch(/^[0-9a-f]{16}$/);
		expect(spans[0].status.status).toBe("ok");
	});

	it("attributes never carry command text", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const g = guard("auto", { telemetry });
		await g.decisionFor(request("shell", { command: "rm -rf / top-secret-token" }));
		const serialized = JSON.stringify(telemetry.getSpans());
		expect(serialized).not.toContain("top-secret-token");
		expect(serialized).not.toContain("rm -rf");
	});

	it("allow decisions are recorded too", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const g = guard("yolo", { telemetry });
		await g.decisionFor(NORMAL);
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans.length).toBe(1);
		expect(spans[0].attributes).toMatchObject({ mode: "yolo", layer: "mode", effect: "allow" });
	});

	it("the digest is stable for equal arguments regardless of key order", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const g = guard("auto", { telemetry });
		await g.decisionFor(request("write", { path: "a.ts", content: "x" }));
		await g.decisionFor(request("write", { content: "x", path: "a.ts" }));
		await g.decisionFor(request("write", { path: "b.ts", content: "y" }));
		const digests = telemetry
			.getSpans()
			.filter((span) => span.name === "tg.span.sec.guard")
			.map((span) => String(span.attributes.argsDigest));
		expect(digests.length).toBe(3);
		expect(digests[0]).toBe(digests[1]);
		expect(digests[0]).not.toBe(digests[2]);
	});
});

describe("intercept rules table in the chain (batch 2b)", () => {
	const rule = (
		id: string,
		pattern: string,
		effect: "allow" | "deny" | "ask",
		over: Partial<TgSecRule> = {},
	): TgSecRule => ({ id, priority: 1000, pattern, effect, enabled: true, ...over });
	const outForNetfetch: TgSecScopeResolver = (req) =>
		req.toolName === "netfetch" ? { inScope: false } : { inScope: true };

	it("a rule deny is a forced ask in every mode, immune to the mode and to a standing grant", async () => {
		for (const mode of TG_SEC_MODES) {
			const grants = createInMemoryGrantStore();
			grants.add("tool:shell");
			const g = guard(mode, { grants, rules: createTgSecRuleTable([rule("ops.no-shell", "tool:shell", "deny")]) });
			const decision = await g.decisionFor(request("shell", { command: "ls -la" }));
			expect(decision.effect, mode).toBe("ask");
			if (decision.effect === "ask") {
				expect(decision.forced, mode).toBe(true);
				expect(decision.reason).toContain('intercept rule "ops.no-shell" (tool:shell)');
				expect(decision.reason).toContain("no grant and no mode exempts it");
			}
		}
	});

	it("the rule deny span records the rules layer and carries no rule attribute: operator ids stay out of the closed vocabulary", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const g = guard("auto", { rules: createTgSecRuleTable([rule("ops.no-shell", "tool:shell", "deny")]), telemetry });
		const decision = await g.decisionFor(request("shell", { command: "ls -la" }));
		expect(decision.effect).toBe("ask");
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans.length).toBe(1);
		expect(spans[0].attributes).toMatchObject({ layer: "rules", effect: "ask", forced: true });
		expect("rule" in spans[0].attributes).toBe(false);
	});

	it("a rule note is appended to the human-facing reason", async () => {
		const g = guard("auto", {
			rules: createTgSecRuleTable([
				rule("ops.no-shell", "tool:shell", "deny", { note: "engagement scope forbids shell" }),
			]),
		});
		const decision = await g.decisionFor(request("shell", { command: "ls -la" }));
		expect(decision).toEqual({
			effect: "ask",
			reason: expect.stringContaining("engagement scope forbids shell"),
			forced: true,
		});
	});

	it("hard deny stays ahead of the rules table: no allow rule can rescue rm -rf /", async () => {
		const g = guard("yolo", { rules: createTgSecRuleTable([rule("allow-everything", "tool:*", "allow")]) });
		const decision = await g.decisionFor(RM_ROOT);
		expect(decision.effect).toBe("deny");
		if (decision.effect === "deny") expect(decision.hard).toBe(true);
	});

	it("the rule deny precedes weak self-protection: the winning layer attributes the ask", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const g = guard("yolo", {
			rules: createTgSecRuleTable([rule("ops.no-shell", "tool:shell", "deny")]),
			telemetry,
			hostAddresses: [],
		});
		const decision = await g.decisionFor(request("shell", { command: "ping 127.0.0.1" }));
		expect(decision).toEqual({ effect: "ask", reason: expect.stringContaining("ops.no-shell"), forced: true });
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans[0].attributes).toMatchObject({ layer: "rules" });
	});

	it("a rule allow cannot beat a forced-ask layer: scope still refuses its host in yolo", async () => {
		const g = guard("yolo", {
			scopeResolver: outForNetfetch,
			rules: createTgSecRuleTable([rule("allow-fetch", "tool:netfetch", "allow")]),
		});
		const decision = await g.decisionFor(request("netfetch", { url: "http://target.invalid/x" }));
		expect(decision).toEqual({ effect: "ask", reason: "the target is outside the registered scope", forced: true });
	});

	it("a rule allow cannot beat the danger set", async () => {
		const g = guard("yolo", {
			dangerEvaluator: createTgSecDangerEvaluator({ objective: "redteam" }),
			rules: createTgSecRuleTable([rule("allow-shell", "tool:shell", "allow")]),
		});
		const decision = await g.decisionFor(request("shell", { command: "crontab -e" }));
		expect(decision).toEqual({ effect: "ask", reason: expect.stringContaining("danger set"), forced: true });
	});

	it("deny outranks a higher-priority allow: priority orders attribution inside one effect, never across effects", async () => {
		const table = createTgSecRuleTable([
			rule("hi-allow", "tool:read", "allow", { priority: 9000 }),
			rule("lo-deny", "tool:read", "deny", { priority: 1 }),
		]);
		const decision = await guard("yolo", { rules: table }).decisionFor(NORMAL);
		expect(decision).toEqual({ effect: "ask", reason: expect.stringContaining("lo-deny"), forced: true });
	});

	it("a rule ask is a non-forced ask that banks its always reply yet keeps asking: the layer precedes the grant check", async () => {
		// The chain diagram is the authority: 规则 ask sits ahead of mode dispatch, so a standing
		// grant cannot clear it. `forced: false` means the human may answer `always` — and the reply
		// is recorded — but the ask rule re-fires every call by construction.
		const grants = createInMemoryGrantStore();
		let asked = 0;
		const askChannel: TgSecAskChannel = async () => {
			asked += 1;
			return "always";
		};
		const g = guard("auto", {
			askChannel,
			grants,
			rules: createTgSecRuleTable([rule("review", "tool:read", "ask")]),
		});
		await expect(g.beforeTool(toolCall("read", { path: "a.ts" }), fakeApi("auto"), context)).resolves.toBeUndefined();
		expect(asked).toBe(1);
		expect(grants.has("tool:read")).toBe(true);
		await expect(g.beforeTool(toolCall("read", { path: "b.ts" }), fakeApi("auto"), context)).resolves.toBeUndefined();
		expect(asked).toBe(2);
	});

	it("strict ignores a matching allow rule: the ask comes from mode dispatch with the strict reason", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const g = guard("strict", {
			rules: createTgSecRuleTable([rule("allow-read", "tool:read", "allow")]),
			telemetry,
		});
		const decision = await g.decisionFor(NORMAL);
		expect(decision).toEqual({
			effect: "ask",
			reason: "strict mode puts every tool call in front of a human",
			forced: false,
		});
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans[0].attributes).toMatchObject({ layer: "mode", effect: "ask" });
	});

	it("judge-auto takes a matching allow rule without consulting the judge", async () => {
		let judged = 0;
		const judge = async () => {
			judged += 1;
			return { decision: "ask" as const, comment: "must not be consulted" };
		};
		const telemetry = new InMemoryTelemetryContext();
		const g = guard("judge-auto", {
			judge,
			rules: createTgSecRuleTable([rule("allow-read", "tool:read", "allow")]),
			telemetry,
		});
		const decision = await g.decisionFor(NORMAL);
		expect(decision).toEqual({ effect: "allow" });
		expect(judged).toBe(0);
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans[0].attributes).toMatchObject({ layer: "rules", effect: "allow" });
	});

	it("auto attribution: allow-plus-grant and allow-only record rules, grant-only records grants, neither records mode", async () => {
		const allow = createTgSecRuleTable([rule("allow-read", "tool:read", "allow")]);
		const granted = () => {
			const grants = createInMemoryGrantStore();
			grants.add("tool:read");
			return grants;
		};
		const cases: readonly {
			label: string;
			grants: ReturnType<typeof granted>;
			rules: typeof allow | undefined;
			layer: string;
		}[] = [
			{ label: "allow rule and standing grant", grants: granted(), rules: allow, layer: "rules" },
			{ label: "standing grant only", grants: granted(), rules: undefined, layer: "grants" },
			{ label: "allow rule only", grants: createInMemoryGrantStore(), rules: allow, layer: "rules" },
			{ label: "neither", grants: createInMemoryGrantStore(), rules: undefined, layer: "mode" },
		];
		for (const c of cases) {
			const telemetry = new InMemoryTelemetryContext();
			const decision = await guard("auto", { grants: c.grants, rules: c.rules, telemetry }).decisionFor(NORMAL);
			expect(decision, c.label).toEqual({ effect: "allow" });
			const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
			expect(spans[0].attributes.layer, c.label).toBe(c.layer);
		}
	});

	it("an empty or disabled table is indistinguishable from no rules", async () => {
		for (const table of [
			createTgSecRuleTable([]),
			createTgSecRuleTable([rule("off", "tool:read", "deny", { enabled: false })]),
		]) {
			const decision = await guard("auto", { rules: table }).decisionFor(NORMAL);
			expect(decision).toEqual({ effect: "allow" });
		}
	});
});

describe("two-axis judge wired into judge-auto (batch 2b)", () => {
	const transportReturning = (reply: string): TgSecJudgeTransport => ({ complete: async () => reply });

	it("an allow verdict allows on the mode layer", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const judge = createTgSecTwoAxisJudge({
			transport: transportReturning('{"decision":"allow","comment":"reversible, test-side"}'),
			timeoutMs: 1000,
		});
		const decision = await guard("judge-auto", { judge, telemetry }).decisionFor(NORMAL);
		expect(decision).toEqual({ effect: "allow" });
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		expect(spans[0].attributes).toMatchObject({ layer: "mode", effect: "allow" });
	});

	it("the judge comment surfaces in the ask reason and never in the span attributes", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const judge = createTgSecTwoAxisJudge({
			transport: transportReturning('{"decision":"ask","comment":"target production asset top-secret-comment"}'),
			timeoutMs: 1000,
		});
		const decision = await guard("judge-auto", { judge, telemetry }).decisionFor(NORMAL);
		expect(decision).toEqual({
			effect: "ask",
			reason: "target production asset top-secret-comment",
			forced: false,
		});
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("top-secret-comment");
	});

	it("a transport that throws escalates to a human: never a release, never a deny", async () => {
		const judge = createTgSecTwoAxisJudge({
			transport: {
				complete: () => {
					throw new Error("provider down");
				},
			},
			timeoutMs: 1000,
		});
		const decision = await guard("judge-auto", { judge }).decisionFor(NORMAL);
		expect(decision).toEqual({
			effect: "ask",
			reason: expect.stringContaining("the judge transport failed"),
			forced: false,
		});
	});

	it("a transport that hangs is cut off inside the judge's own budget", async () => {
		const judge = createTgSecTwoAxisJudge({
			transport: { complete: () => new Promise<string>(() => {}) },
			timeoutMs: 5,
		});
		const decision = await guard("judge-auto", { judge }).decisionFor(NORMAL);
		expect(decision).toEqual({
			effect: "ask",
			reason: expect.stringContaining("did not answer within 5 ms"),
			forced: false,
		});
	});

	it("a rogue deny from the judge is off-protocol and asks: the judge keeps no deny power", async () => {
		const judge = createTgSecTwoAxisJudge({
			transport: transportReturning('{"decision":"deny","comment":"rogue"}'),
			timeoutMs: 1000,
		});
		const decision = await guard("judge-auto", { judge }).decisionFor(NORMAL);
		expect(decision).toEqual({
			effect: "ask",
			reason: expect.stringContaining("outside its two permitted values"),
			forced: false,
		});
	});
});
