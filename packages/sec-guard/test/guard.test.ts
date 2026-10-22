import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import type { HookApi, JsonObject, ToolHookCall, Tx } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { describe, expect, it } from "vitest";
import {
	createInMemoryGrantStore,
	createTgSecGuard,
	TG_SEC_MODES,
	type TgSecAskChannel,
	type TgSecDangerEvaluator,
	type TgSecGuardOptions,
	type TgSecPermissionMode,
	type TgSecRequest,
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
