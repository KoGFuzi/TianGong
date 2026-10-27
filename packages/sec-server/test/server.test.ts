import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@OnePanda-TgSec/tg-ai";
import { createModels } from "@OnePanda-TgSec/tg-ai/models";
import {
	type Conversation,
	createRegistry,
	Harness,
	MemoryStorage,
	type SubmissionDraft,
} from "@OnePanda-TgSec/tg-gibraltar";
import { request } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import {
	createSecApprovalQueue,
	type SecApprovalQueue,
	type SecAskPayload,
	type SecServerHandle,
	type SecServerHost,
	startSecServer,
} from "../src/index.ts";
import type { SecProjectionAction } from "../src/projection.ts";
import { TestWsClient } from "./websocket-client.ts";

const ENTRY = "entrypath1234";
const context = BACKGROUND_CONTEXT;

type Setup = {
	readonly server: SecServerHandle;
	readonly harness: Harness;
	readonly root: Conversation;
	readonly approvals: SecApprovalQueue;
	readonly callCount: () => number;
};

const setups: Setup[] = [];

afterEach(async () => {
	for (const setup of setups.splice(0)) {
		await setup.server.close();
		await setup.harness.close(context);
	}
});

async function setup(): Promise<Setup> {
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } }, meta: { title: "server", cwd: "", lane: "", createdAt: 1, updatedAt: 1 } });
	faux.setResponses([fauxAssistantMessage("noted"), fauxAssistantMessage("noted"), fauxAssistantMessage("noted")]);

	const approvals = createSecApprovalQueue();
	const actions: SecProjectionAction[] = [
		{
			conversationId: 2,
			parentConversationId: root.id,
			ownerTaskId: 7,
			at: 20,
			intent: "service: 8080/http nginx",
			openedAt: 20,
			status: "done",
			summaryRef: "nginx 1.25",
		},
	];
	const host: SecServerHost = {
		project: "demo",
		target: "https://demo.local",
		harness,
		conversationId: root.id,
		context,
		readProjection: async () => ({ actions, evidence: [] }),
		steer: async (content) => {
			const submission: SubmissionDraft = {
				type: "input",
				content,
				whenBusy: "steer",
				entry: { kind: "sec.steer" },
			};
			await (await root.submit(submission, context)).wait(context);
		},
		approvals,
	};
	const server = await startSecServer({
		host,
		entry: ENTRY,
		port: 0,
		refreshDelayMs: 5,
		heartbeatMs: 0,
	});
	const started: Setup = { server, harness, root, approvals, callCount: () => faux.state.callCount };
	setups.push(started);
	return started;
}

async function login(server: SecServerHandle): Promise<string> {
	const ticket = server.issueTicket();
	const response = await fetch(server.ticketUrl(ticket.ticket), { redirect: "manual" });
	expect(response.status).toBe(303);
	const cookie = response.headers.get("set-cookie");
	expect(cookie).toBeDefined();
	return cookie!.split(";")[0]!;
}

function httpUrl(server: SecServerHandle, path: string): string {
	return `http://127.0.0.1:${server.port}${path}`;
}

describe("startSecServer", () => {
	test("gates every route behind the one-time ticket and the scoped cookie", async () => {
		const { server } = await setup();
		expect(server.entry).toBe(ENTRY);
		expect(server.url).toBe(`http://127.0.0.1:${server.port}/${ENTRY}/`);

		const ticket = server.issueTicket();
		const loginResponse = await fetch(server.ticketUrl(ticket.ticket), { redirect: "manual" });
		expect(loginResponse.status).toBe(303);
		expect(loginResponse.headers.get("location")).toBe(`/${ENTRY}/`);
		const setCookie = loginResponse.headers.get("set-cookie")!;
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain(`Path=/${ENTRY}/`);
		const cookie = setCookie.split(";")[0]!;

		expect((await fetch(server.ticketUrl(ticket.ticket), { redirect: "manual" })).status).toBe(404);
		expect((await fetch(httpUrl(server, `/${ENTRY}/`))).status).toBe(404);
		expect((await fetch(httpUrl(server, `/${ENTRY}/nope`), { headers: { cookie } })).status).toBe(404);

		const document = await fetch(httpUrl(server, `/${ENTRY}/`), { headers: { cookie } });
		expect(document.status).toBe(200);
		expect(document.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(document.headers.get("cache-control")).toBe("no-store");
		expect(document.headers.get("content-security-policy")).toContain(
			`connect-src 'self' ws://127.0.0.1:${server.port}`,
		);
		expect(await document.text()).toContain("./app.js");

		const script = await fetch(httpUrl(server, `/${ENTRY}/app.js`), { headers: { cookie } });
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
	});

	test("rejects a request whose Host header is not allowlisted", async () => {
		const { server } = await setup();
		const cookie = await login(server);

		const status = await new Promise<number>((resolve, reject) => {
			const outgoing = request(
				{
					host: "127.0.0.1",
					port: server.port,
					path: `/${ENTRY}/`,
					headers: { Host: "attacker.test", cookie },
				},
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				},
			);
			outgoing.on("error", reject);
			outgoing.end();
		});
		expect(status).toBe(404);
	});

	test("serves the projected graph as a snapshot over HTTP", async () => {
		const { server } = await setup();
		const cookie = await login(server);

		const response = await fetch(httpUrl(server, `/${ENTRY}/api/graph`), { headers: { cookie } });
		expect(response.status).toBe(200);
		const frame = (await response.json()) as {
			type: string;
			running: boolean;
			queued: number;
			payload: { nodes: { key: string; type: string }[]; stats: { nodes: number } };
		};
		expect(frame.type).toBe("snapshot");
		expect(frame.running).toBe(false);
		expect(frame.queued).toBe(0);
		expect(frame.payload.nodes.map((node) => node.key)).toEqual(["target:demo", "service:action-2"]);
		expect(frame.payload.stats.nodes).toBe(2);
	});

	test("rejects steering without the origin proof, then submits a valid steer", async () => {
		const { server, callCount } = await setup();
		const cookie = await login(server);
		const body = JSON.stringify({ content: "try the left branch" });

		const missingProof = await fetch(httpUrl(server, `/${ENTRY}/api/steer`), {
			method: "POST",
			headers: { cookie, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" },
			body,
		});
		expect(missingProof.status).toBe(403);

		const wrongOrigin = await fetch(httpUrl(server, `/${ENTRY}/api/steer`), {
			method: "POST",
			headers: {
				cookie,
				origin: "http://attacker.test",
				"content-type": "application/json",
				"x-tg-sec-steer": "1",
			},
			body,
		});
		expect(wrongOrigin.status).toBe(403);

		const wrongType = await fetch(httpUrl(server, `/${ENTRY}/api/steer`), {
			method: "POST",
			headers: {
				cookie,
				origin: `http://127.0.0.1:${server.port}`,
				"content-type": "text/plain",
				"x-tg-sec-steer": "1",
			},
			body,
		});
		expect(wrongType.status).toBe(415);

		const accepted = await fetch(httpUrl(server, `/${ENTRY}/api/steer`), {
			method: "POST",
			headers: {
				cookie,
				origin: `http://127.0.0.1:${server.port}`,
				"content-type": "application/json",
				"x-tg-sec-steer": "1",
			},
			body,
		});
		expect(accepted.status).toBe(202);
		expect(await accepted.json()).toEqual({ ok: true, queued: false });
		expect(callCount()).toBe(1);
	});

	test("streams a snapshot, answers ping, and accepts steering over the WebSocket", async () => {
		const { server, callCount } = await setup();
		const cookie = await login(server);

		const client = await TestWsClient.connect(new URL(`ws://127.0.0.1:${server.port}/${ENTRY}/ws`), {
			Origin: `http://127.0.0.1:${server.port}`,
			Cookie: cookie,
		});

		const snapshot = await client.waitForJson<{ type: string; payload: { nodes: { key: string }[] } }>(
			(value) => (value as { type?: string }).type === "snapshot",
		);
		expect(snapshot.payload.nodes.map((node) => node.key)).toEqual(["target:demo", "service:action-2"]);

		client.sendText('{"type":"ping"}');
		await client.waitForJson((value) => (value as { type?: string }).type === "pong");

		client.sendText('{"type":"steer","content":"try the left branch"}');
		const thought = await client.waitForJson<{ type: string; payload: { text: string } }>(
			(value) => (value as { type?: string }).type === "thought",
			5000,
		);
		expect(thought.payload.text).toBe("noted");
		expect(callCount()).toBe(1);

		client.close();
		expect(await client.waitForClose()).toBe(1000);
	});

	test("rejects a WebSocket without the cookie or from another origin", async () => {
		const { server } = await setup();
		const cookie = await login(server);
		const url = new URL(`ws://127.0.0.1:${server.port}/${ENTRY}/ws`);

		await expect(TestWsClient.connect(url, { Origin: `http://127.0.0.1:${server.port}` })).rejects.toThrow(
			/404 Not Found/,
		);
		await expect(TestWsClient.connect(url, { Origin: "http://attacker.test", Cookie: cookie })).rejects.toThrow(
			/403 Forbidden/,
		);
		await expect(
			TestWsClient.connect(new URL(`ws://127.0.0.1:${server.port}/wrong/ws`), {
				Origin: `http://127.0.0.1:${server.port}`,
				Cookie: cookie,
			}),
		).rejects.toThrow(/404 Not Found/);
	});

	test("streams a guard ask, redacts its body, and resolves the operator reply", async () => {
		const { server, approvals } = await setup();
		const cookie = await login(server);
		const client = await TestWsClient.connect(new URL(`ws://127.0.0.1:${server.port}/${ENTRY}/ws`), {
			Origin: `http://127.0.0.1:${server.port}`,
			Cookie: cookie,
		});
		await client.waitForJson((value) => (value as { type?: string }).type === "snapshot");

		const answer = approvals.ask({
			toolName: "http_request",
			resource: "tool:http_request",
			reason: "the target is outside the registered scope",
			forced: true,
			args: { url: "https://outside.example/api", body: "QUJD" },
		});
		const ask = await client.waitForJson<{ type: string; payload: SecAskPayload }>(
			(value) => (value as { type?: string }).type === "ask",
		);
		expect(ask.payload).toEqual({
			id: "ask-1",
			toolName: "http_request",
			resource: "tool:http_request",
			reason: "the target is outside the registered scope",
			forced: true,
			args: { url: "https://outside.example/api", body: "[omitted 3 bytes]" },
		});

		client.sendText(JSON.stringify({ type: "ask_reply", id: ask.payload.id, reply: "always" }));
		await expect(answer).resolves.toBe("always");
		const settled = await client.waitForJson<{ type: string; payload: { message: string } }>(
			(value) =>
				(value as { type?: string }).type === "log" &&
				String((value as { payload?: { message?: string } }).payload?.message).includes("always"),
		);
		expect(settled.payload.message).toBe(`guard ask ${ask.payload.id}: always`);
		expect(approvals.pending()).toEqual([]);
		client.close();
	});

	test("replays pending asks to a late client and denies them on shutdown", async () => {
		const { server, approvals } = await setup();
		const cookie = await login(server);
		const url = new URL(`ws://127.0.0.1:${server.port}/${ENTRY}/ws`);
		const headers = { Origin: `http://127.0.0.1:${server.port}`, Cookie: cookie };
		const first = await TestWsClient.connect(url, headers);
		await first.waitForJson((value) => (value as { type?: string }).type === "snapshot");

		const answer = approvals.ask({
			toolName: "read",
			resource: "tool:read",
			reason: "strict mode puts every tool call in front of a human",
			forced: false,
			args: { path: "src/index.ts" },
		});
		const ask = await first.waitForJson<{ type: string; payload: SecAskPayload }>(
			(value) => (value as { type?: string }).type === "ask",
		);

		const second = await TestWsClient.connect(url, headers);
		await second.waitForJson((value) => (value as { type?: string }).type === "snapshot");
		const replay = await second.waitForJson<{ type: string; payload: SecAskPayload }>(
			(value) => (value as { type?: string }).type === "ask",
		);
		expect(replay.payload.id).toBe(ask.payload.id);

		second.sendText(JSON.stringify({ type: "ask_reply", id: "ask-999", reply: "deny" }));
		const warn = await second.waitForJson<{ type: string; payload: { level: string; message: string } }>(
			(value) =>
				(value as { type?: string }).type === "log" &&
				(value as { payload?: { level?: string } }).payload?.level === "warn",
		);
		expect(warn.payload.message).toContain("no longer pending");
		expect(approvals.pending()).toHaveLength(1);

		await server.close();
		await expect(answer).resolves.toBe("deny");
		first.close();
	});

	test("closes the listener and its clients with the handle", async () => {
		const { server } = await setup();
		const cookie = await login(server);
		const client = await TestWsClient.connect(new URL(`ws://127.0.0.1:${server.port}/${ENTRY}/ws`), {
			Origin: `http://127.0.0.1:${server.port}`,
			Cookie: cookie,
		});
		await client.waitForJson((value) => (value as { type?: string }).type === "snapshot");

		await server.close();
		expect(await client.waitForClose()).toBe(1001);
		await expect(fetch(httpUrl(server, `/${ENTRY}/`), { headers: { cookie } })).rejects.toThrow();
	});
});
