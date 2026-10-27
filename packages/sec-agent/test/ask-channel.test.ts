import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { createModels, fauxProvider } from "@OnePanda-TgSec/tg-ai";
import { createRegistry, Harness, type HookApi, MemoryStorage, type ToolHookCall } from "@OnePanda-TgSec/tg-gibraltar";
import type { TgSecPermissionMode } from "@OnePanda-TgSec/tg-sec-guard";
import {
	createSecApprovalQueue,
	type SecApprovalQueue,
	type SecAskPayload,
	type SecServerHandle,
	startSecServer,
} from "@OnePanda-TgSec/tg-sec-server";
import { afterEach, describe, expect, it } from "vitest";
import { TestWsClient } from "../../sec-server/test/websocket-client.ts";
import { createApprovalAskChannel } from "../src/ask.ts";
import { buildSecGuard, type SecGuardWiring } from "../src/guard-wiring.ts";

const context = BACKGROUND_CONTEXT;
const ENTRY = "askentry1234";

type Stand = {
	readonly server: SecServerHandle;
	readonly harness: Harness;
	readonly approvals: SecApprovalQueue;
	readonly wiring: SecGuardWiring;
	readonly client: TestWsClient;
};

const stands: Stand[] = [];

afterEach(async () => {
	for (const stand of stands.splice(0)) {
		stand.approvals.close();
		await stand.server.close().catch(() => undefined);
		await stand.harness.close(context).catch(() => undefined);
	}
});

async function login(server: SecServerHandle): Promise<string> {
	const ticket = server.issueTicket();
	const response = await fetch(server.ticketUrl(ticket.ticket), { redirect: "manual" });
	expect(response.status).toBe(303);
	const cookie = response.headers.get("set-cookie");
	expect(cookie).toBeDefined();
	return cookie!.split(";")[0]!;
}

/** The one method `beforeTool` reads from the hook api: the live mode document. */
function api(mode: TgSecPermissionMode): HookApi {
	return { snapshot: async () => ({ mode }) } as unknown as HookApi;
}

async function setup(): Promise<Stand> {
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
		meta: { title: "ask", cwd: "", lane: "", createdAt: 1, updatedAt: 1 },
	});
	const approvals = createSecApprovalQueue();
	const wiring = await buildSecGuard({
		session: harness,
		lane: "redteam",
		context,
		mode: "auto",
		askChannel: createApprovalAskChannel(approvals),
		attestParts: { forbiddenRead: async () => undefined, registeredTools: () => [] },
	});
	const server = await startSecServer({
		host: {
			project: "ask-e2e",
			target: "ask-e2e",
			harness,
			conversationId: root.id,
			context,
			readProjection: async () => ({ actions: [], evidence: [] }),
			steer: async () => {},
			approvals,
		},
		entry: ENTRY,
		port: 0,
		refreshDelayMs: 5,
		heartbeatMs: 0,
	});
	const cookie = await login(server);
	const client = await TestWsClient.connect(new URL(`ws://127.0.0.1:${server.port}/${ENTRY}/ws`), {
		Origin: `http://127.0.0.1:${server.port}`,
		Cookie: cookie,
	});
	await client.waitForJson((value) => (value as { type?: string }).type === "snapshot");
	const stand: Stand = { server, harness, approvals, wiring, client };
	stands.push(stand);
	return stand;
}

function readCall(id: string): ToolHookCall {
	return { type: "toolCall", id, name: "read", arguments: { path: "src/index.ts" } };
}

function dangerCall(id: string): ToolHookCall {
	return {
		type: "toolCall",
		id,
		name: "bash",
		arguments: { command: "mysql -e 'DROP TABLE attestation_probe' attestation_db" },
	};
}

const PENDING = Symbol("still-pending");

describe("WebUI ask channel end to end", () => {
	it("parks a strict ask, banks the always grant, and lets the same resource through in auto", async () => {
		const { wiring, approvals, client } = await setup();

		const first = wiring.guard.beforeTool(readCall("strict-1"), api("strict"), context);
		const ask = await client.waitForJson<{ type: string; payload: SecAskPayload }>(
			(value) => (value as { type?: string }).type === "ask",
		);
		expect(ask.payload).toMatchObject({
			toolName: "read",
			resource: "tool:read",
			forced: false,
		});
		expect(ask.payload.reason).toContain("strict mode");
		client.sendText(JSON.stringify({ type: "ask_reply", id: ask.payload.id, reply: "always" }));
		await expect(first).resolves.toBeUndefined();

		const second = await Promise.race([
			wiring.guard.beforeTool(readCall("strict-2"), api("auto"), context),
			new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 500)),
		]);
		expect(second).toBeUndefined();
		expect(approvals.pending()).toEqual([]);
	}, 30_000);

	it("forces a danger ask past a grant: always approves one call, the repeat asks again, deny blocks", async () => {
		const { wiring, approvals, client } = await setup();

		const first = wiring.guard.beforeTool(dangerCall("danger-1"), api("auto"), context);
		const ask = await client.waitForJson<{ type: string; payload: SecAskPayload }>(
			(value) => (value as { type?: string }).type === "ask",
		);
		expect(ask.payload).toMatchObject({
			toolName: "bash",
			resource: "tool:bash",
			forced: true,
		});
		expect(ask.payload.reason).toContain("DROP TABLE");
		client.sendText(JSON.stringify({ type: "ask_reply", id: ask.payload.id, reply: "always" }));
		await expect(first).resolves.toBeUndefined();

		const second = wiring.guard.beforeTool(dangerCall("danger-2"), api("auto"), context);
		const repeat = await client.waitForJson<{ type: string; payload: SecAskPayload }>(
			(value) => (value as { type?: string }).type === "ask",
		);
		expect(repeat.payload.forced).toBe(true);
		expect(repeat.payload.id).not.toBe(ask.payload.id);
		client.sendText(JSON.stringify({ type: "ask_reply", id: repeat.payload.id, reply: "deny" }));
		const blocked = await second;
		expect(blocked?.block).toContain("DROP TABLE");
		expect(approvals.pending()).toEqual([]);
	}, 30_000);
});
