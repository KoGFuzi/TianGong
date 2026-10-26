import { fauxAssistantMessage, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import type { HookApi, ToolHookCall } from "@OnePanda-TgSec/tg-gibraltar";
import { createTgSecScopeRegistry, type TgSecRequest, toTgSecRequest } from "@OnePanda-TgSec/tg-sec-guard";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQueueAskChannel } from "../src/ask.ts";
import { openSecAgent, type SecAgent, type SecAgentLane } from "../src/bootstrap.ts";
import { createSecCoreExtension } from "../src/core-extension.ts";
import { openTgSecEvidenceStore } from "../src/evidence/store.ts";
import {
	buildSecGuard,
	type SecGuardWiring,
	secAttestForbiddenRead,
	secAttestRulesSample,
	secDeclaredTools,
} from "../src/guard-wiring.ts";
import type { TaskChildPolicy } from "../src/task-tool.ts";
import { createSecToolsExtension } from "../src/tools/extension.ts";
import type { RequestExecutor } from "../src/tools/transport.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, trackStore } from "./support.ts";

afterEach(cleanupTempDirs);

/** A transport that never touches the wire: probe 4 only needs the forensic tools registered, not exercised. */
const guardFauxExecutor: RequestExecutor = {
	async send() {
		return { status: 200, headers: {}, body: new Uint8Array(), contentType: "application/octet-stream" };
	},
};

/** A session port with no document: mode construction always passes an explicit mode here. */
const noDocument = {
	snapshot: async () => undefined,
	commit: async () => {
		throw new Error("unit wiring never writes the mode document");
	},
};

function bashRequest(command: string): TgSecRequest {
	return { toolName: "bash", resource: "tool:bash", arguments: { command } };
}

async function wiringFor(
	lane: SecAgentLane,
	over: Partial<Parameters<typeof buildSecGuard>[0]> = {},
): Promise<SecGuardWiring> {
	return buildSecGuard({
		session: noDocument,
		lane,
		context,
		mode: "auto",
		attestParts: { forbiddenRead: async () => undefined, registeredTools: () => [] },
		...over,
	});
}

describe("buildSecGuard", () => {
	it("refuses every connection target when no scope registry was given", async () => {
		const wiring = await wiringFor("redteam");
		const decision = await wiring.guard.decisionFor(bashRequest("curl -s https://example.com/api"));
		expect(decision.effect).toBe("ask");
		if (decision.effect === "ask") {
			expect(decision.forced).toBe(true);
			expect(decision.reason).toContain("not in the registered scope");
		}
	});

	it("admits exactly the hosts the registry allows", async () => {
		const registry = createTgSecScopeRegistry([
			{ kind: "exact-host", pattern: "target.example", effect: "allow", enabled: true },
		]);
		const wiring = await wiringFor("redteam", { scopeRegistry: registry });
		expect(await wiring.guard.decisionFor(bashRequest("curl -s https://target.example/api"))).toEqual({
			effect: "allow",
		});
		const outside = await wiring.guard.decisionFor(bashRequest("curl -s https://elsewhere.example/api"));
		expect(outside.effect).toBe("ask");
	});

	it("keys the danger evaluator to the lane: business rules arm redteam, CTF pacing rules arm ctf", async () => {
		const redteam = await wiringFor("redteam");
		const ctf = await wiringFor("ctf");
		const businessOnly = bashRequest("api POST /v2/user/1/password_reset {}");
		const red = await redteam.guard.decisionFor(businessOnly);
		expect(red.effect === "ask" && red.reason).toContain("password");
		expect(await ctf.guard.decisionFor(businessOnly)).toEqual({ effect: "allow" });
		const hashcat = bashRequest("hashcat -m 1000 hashes.txt wordlist.txt");
		expect(await ctf.guard.decisionFor(hashcat)).not.toEqual({ effect: "allow" });
		expect(await redteam.guard.decisionFor(hashcat)).toEqual({ effect: "allow" });
	});

	it("consults the two-axis judge in judge-auto and fails closed when the transport degrades", async () => {
		const allowTransport = { complete: async () => '{"decision":"allow","comment":"reversible probe"}' };
		const wiring = await wiringFor("redteam", { mode: "judge-auto", judgeTransport: allowTransport });
		expect(await wiring.guard.decisionFor(bashRequest("whoami"))).toEqual({ effect: "allow" });

		const broken = await wiringFor("redteam", {
			mode: "judge-auto",
			judgeTransport: {
				complete: () => {
					throw new Error("offline");
				},
			},
		});
		const decision = await broken.guard.decisionFor(bashRequest("whoami"));
		expect(decision.effect === "ask" && decision.reason).toContain("offline");
	});

	it("refuses to construct a judge-auto guard without a judge source", async () => {
		await expect(wiringFor("redteam", { mode: "judge-auto" })).rejects.toThrow(
			/judge-auto requires an injected judge/,
		);
	});

	it("drives the ask channel through beforeTool: strict asks on every call and a stored grant never exempts it", async () => {
		// The `{ snapshot }`-only view is the shape `beforeTool` actually consumes (the mode read);
		// same test stand-in as sec-guard's own attestation suite uses for this seam.
		const strictApi = { snapshot: async () => ({ mode: "strict" }) } as unknown as HookApi;
		const queue = createQueueAskChannel(["allow", "always"]);
		const wiring = await wiringFor("redteam", { mode: "strict", askChannel: queue.ask });
		const readCall: ToolHookCall = { ...secAttestRulesSample(), id: "strict-1" };
		expect(await wiring.guard.beforeTool(readCall, strictApi, context)).toBeUndefined();
		// An `always` reply stores a grant, but strict routes every call to the human regardless:
		// grants are consulted only in the auto/yolo dispatch, so the second call asks again.
		expect(await wiring.guard.beforeTool({ ...readCall, id: "strict-2" }, strictApi, context)).toBeUndefined();
		expect(queue.asked).toHaveLength(2);
		expect(queue.asked[0]?.request.toolName).toBe("read");
		expect(queue.asked[0]?.decision.forced).toBe(false);

		// A forced scope ask: `always` approves the one call and stores nothing.
		const forcedApi = { snapshot: async () => ({ mode: "auto" }) } as unknown as HookApi;
		const forcedQueue = createQueueAskChannel(["always", "always"]);
		const forcedWiring = await wiringFor("redteam", { askChannel: forcedQueue.ask });
		const curl = toTgSecRequest({
			type: "toolCall",
			id: "c",
			name: "bash",
			arguments: { command: "curl -s https://outside.example/x" },
		});
		expect(
			await forcedWiring.guard.beforeTool(
				{ type: "toolCall", id: "c", name: "bash", arguments: { command: "curl -s https://outside.example/x" } },
				forcedApi,
				context,
			),
		).toBeUndefined();
		expect(
			await forcedWiring.guard.beforeTool(
				{ type: "toolCall", id: "d", name: "bash", arguments: { command: "curl -s https://outside.example/x" } },
				forcedApi,
				context,
			),
		).toBeUndefined();
		expect(forcedQueue.asked).toHaveLength(2);
		expect(forcedQueue.asked[0]?.decision.forced).toBe(true);
		expect(await forcedWiring.guard.decisionFor(curl)).not.toEqual({ effect: "allow" });
	});

	it("blocks a denied reply and a hard-deny call without ever consulting the channel", async () => {
		const api = { snapshot: async () => ({ mode: "auto" }) } as unknown as HookApi;
		const queue = createQueueAskChannel([]);
		const wiring = await wiringFor("redteam", { askChannel: queue.ask });
		const result = await wiring.guard.beforeTool(
			{ type: "toolCall", id: "x", name: "bash", arguments: { command: "rm -rf /" } },
			api,
			context,
		);
		expect(result?.block).toContain("hard deny");
		expect(queue.asked).toHaveLength(0);
	});
});

describe("guard-wiring attestation end to end", () => {
	const policies: Record<SecAgentLane, TaskChildPolicy> = {
		redteam: { extensions: ["sec-core"] },
		ctf: { extensions: ["sec-core"] },
		src: { extensions: ["sec-core"] },
	};

	async function openGuardedAgent(
		project: string,
		mode: "auto" | "strict",
		replies: readonly ("allow" | "deny" | "always")[] = [],
	) {
		const dir = await tempDir();
		const { faux, models } = fauxSetup();
		const agent = await openSecAgent({
			context,
			project,
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
		});
		const queue = createQueueAskChannel(replies);
		const wiring = await buildSecGuard({
			session: agent.harness,
			lane: "redteam",
			context,
			mode,
			judgeModel: { models, model: fauxModel },
			askChannel: queue.ask,
			attestParts: {
				forbiddenRead: secAttestForbiddenRead(join(dir, "confine")),
				registeredTools: () =>
					agent.registry
						.snapshot()
						.tools()
						.map((entry) => entry.tool.name),
				declaredTools: secDeclaredTools("redteam"),
			},
		});
		agent.registry.install(createSecCoreExtension({ lane: "redteam", wiring, policies }));
		// The batch-5 forensic surface the declared set names: installing it keeps probe 4 aligned.
		const store = await openTgSecEvidenceStore({ dir: await tempDir("tg-sec-guard-ev-") });
		trackStore(store);
		agent.registry.install(createSecToolsExtension({ store, executor: guardFauxExecutor }));
		// beforeTool re-reads the live mode document on every call; persist it so the constructed
		// mode and the document agree instead of the harness default (`auto`) silently winning.
		await wiring.guard.switchMode(mode, "test", context);
		return { agent, faux, wiring, queue, dir, store };
	}

	async function toolResultText(agent: SecAgent): Promise<string> {
		const page = await agent.root.entries({}, 100, undefined, context);
		const results = page.items.filter((entry) => entry.kind === "tg.tool-result");
		const texts: string[] = [];
		for (const entry of results) {
			for (const message of entry.model ?? []) {
				if (message.role === "toolResult")
					texts.push(message.content.map((block) => (block.type === "text" ? block.text : "")).join(" "));
			}
		}
		return texts.join("\n");
	}

	it("runs the full probe set on the first beforeTool through the real hook api and lets the turn finish", async () => {
		const { agent, faux, dir } = await openGuardedAgent("attest-pass", "auto");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" }, { id: "a-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("attested and done"),
		]);
		const submission = await agent.root.submit({ type: "input", content: "pwd" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		// Attestation failing would have surfaced as an extension report or a blocked call; neither happened.
		expect(agent.reports).toEqual([]);
		expect(await toolResultText(agent)).toContain(basename(dir));
		await agent.close(context);
	}, 30_000);

	it("asks the channel for a strict-mode call and blocks it when the operator denies", async () => {
		const { agent, faux, queue } = await openGuardedAgent("attest-strict", "strict", ["deny"]);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" }, { id: "s-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked as expected"),
		]);
		const submission = await agent.root.submit({ type: "input", content: "pwd" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(queue.asked).toHaveLength(1);
		expect(queue.asked[0]?.decision.forced).toBe(false);
		expect(await toolResultText(agent)).toContain("strict mode");
		await agent.close(context);
	}, 30_000);

	it("hard-denies self-destruction inside the real chain without ever asking", async () => {
		const { agent, faux, queue } = await openGuardedAgent("attest-deny", "auto", []);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /" }, { id: "d-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("refused"),
		]);
		const submission = await agent.root.submit({ type: "input", content: "wipe root" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(queue.asked).toHaveLength(0);
		expect(await toolResultText(agent)).toContain("hard deny");
		await agent.close(context);
	}, 30_000);

	it("fails closed on a registry that drifted from the declared lane preset", async () => {
		const dir = await tempDir();
		const { faux, models } = fauxSetup();
		const agent = await openSecAgent({
			context,
			project: "attest-drift",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
		});
		const wiring = await buildSecGuard({
			session: agent.harness,
			lane: "redteam",
			context,
			mode: "auto",
			askChannel: createQueueAskChannel(["allow"]).ask,
			attestParts: {
				forbiddenRead: secAttestForbiddenRead(join(dir, "confine")),
				registeredTools: () =>
					agent.registry
						.snapshot()
						.tools()
						.map((entry) => entry.tool.name),
				// The drift: the preset forgot the tool the campaign actually carries.
				declaredTools: [...secDeclaredTools("redteam").filter((name) => name !== "task"), "ghost_tool"],
			},
		});
		agent.registry.install(createSecCoreExtension({ lane: "redteam", wiring, policies }));
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" }, { id: "g-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked by attestation"),
		]);
		const submission = await agent.root.submit({ type: "input", content: "pwd" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		const blocked = await toolResultText(agent);
		expect(blocked).toContain("attestation probe");
		expect(blocked).toContain("ghost_tool");
		await agent.close(context);
	}, 30_000);
});
