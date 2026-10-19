// Display-only writes appended at once (#10407), the three cases the house port had not yet carried.
// The upstream harness-input-entries.test.ts holds 11 cases; 8 already live in harness-inbox.test.ts
// (display-only writes in describe("inbox") at :544 and :580, and the describe("input entries") block
// at :992-1205). This file carries the remaining three, from the upstream :333, :361 and :418.
// The house term "display-only" is upstream's "data-only".
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage, fauxText } from "@OnePanda-TgSec/tg-ai";
import {
	type Conversation,
	type EntryRecord,
	type Harness,
	InboxDoc,
	type InputEntry,
	LiveDoc,
	MemoryStorage,
} from "@OnePanda-TgSec/tg-gibraltar";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat, textOf } from "./chat-support.ts";
import { addSection } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

function answer(text: string): AssistantMessage {
	return fauxAssistantMessage([fauxText(text)]);
}

/** A faux response held until `release` or cancellation; `reached` resolves when the request is sent. */
function gated(message: AssistantMessage): { step: FauxResponseStep; reached: Promise<void>; release: () => void } {
	const reached = deferred();
	const gate = deferred();
	const step: FauxResponseStep = async (_request, options) => {
		reached.resolve();
		await Promise.race([gate.promise, aborted(options!.signal!)]);
		return message;
	};
	return { step, reached: reached.promise, release: () => gate.resolve() };
}

/** Role and text of each request message, as the provider receives them. */
function requestLog(requests: string[][], reply: AssistantMessage): FauxResponseStep {
	return (request) => {
		requests.push(request.messages.map((message) => `${message.role}:${textOf(message) ?? ""}`));
		return reply;
	};
}

/** Kind, application data, and model text of each entry, skipping system entries. */
function entryFacts(entries: readonly EntryRecord[]): unknown[][] {
	return entries
		.filter((entry) => entry.kind !== "tg.system")
		.map((entry) => {
			const message = entry.model?.[0];
			const text = message === undefined || message.role === "toolResult" ? undefined : textOf(message);
			const data = entry.data === undefined || entry.kind.startsWith("tg.") ? [] : [entry.data];
			return [entry.kind, ...data, ...(text === undefined ? [] : [text])];
		});
}

async function queuedItems(harness: Harness, root: Conversation) {
	return (await harness.snapshot(InboxDoc, root.id, context))!.items;
}

const mention = (text: string): InputEntry => ({ kind: "chat.mention", data: { author: "ann", text } });

describe("display-only writes", () => {
	it("leaves the request unchanged by a display-only write that lands while the generation prepares", async () => {
		const setup = chatSetup();
		const rendering = deferred();
		const render = deferred();
		let renders = 0;
		addSection(setup.registry, "slow", async () => {
			if (renders++ === 1) {
				rendering.resolve();
				await render.promise;
			}
			return "SLOW";
		});
		const requests: string[][] = [];
		setup.faux.setResponses([requestLog(requests, answer("one")), requestLog(requests, answer("two"))]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "a" }, context)).wait(context);
		const second = await root.submit({ type: "input", content: "b" }, context);
		await rendering.promise;
		await root.submit({ type: "write", entry: { kind: "chat.message", data: "hi" } }, context);
		render.resolve();
		await second.wait(context);
		expect(requests[1]).toEqual(["system:", "user:a", "assistant:one", "user:b"]);
		const kinds = (await allEntries(root)).map((entry) => entry.kind);
		// The unchanged prompt adds no second tg.system entry.
		expect(kinds).toEqual(["tg.user", "tg.system", "tg.assistant", "tg.user", "chat.message", "tg.assistant"]);
		await harness.close(context);
	});

	it("appends a display-only write while idle after a failed run without placing the queued items", async () => {
		const setup = chatSetup();
		const failing = gated(fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" }));
		setup.faux.setResponses([failing.step, answer("for f")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await failing.reached;
		const f = await root.submit({ type: "input", content: "f", entry: mention("f") }, context);
		failing.release();
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		await harness.waitForIdle(context);
		const note = await root.submit({ type: "write", entry: { kind: "note", data: "n" } }, context);
		expect((await note.status(context)).status).toBe("done");
		await harness.waitForIdle(context);
		expect((await f.status(context)).status).toBe("queued");
		expect((await queuedItems(harness, root)).map((item) => item.id)).toEqual([f.id]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		expect(setup.faux.state.callCount).toBe(1);
		// The next input places the waiting mention first.
		const g = await root.submit({ type: "input", content: "g" }, context);
		await g.wait(context);
		expect((await entryFacts(await allEntries(root))).filter(([kind]) => kind !== "tg.assistant")).toEqual([
			["tg.user", "a"],
			["note", "n"],
			["chat.mention", { author: "ann", text: "f" }, "f"],
			["tg.user", "g"],
		]);
		await harness.close(context);
	});

	it("appends a display-only write at once behind a non-empty inbox, and still queues writes with model or edits", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("second")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const followUp = await root.submit({ type: "input", content: "f" }, context);
		const model = await root.submit(
			{ type: "write", entry: { kind: "note", model: [{ role: "user", content: "m", timestamp: 0 }] } },
			context,
		);
		const target = (await allEntries(root)).find((entry) => entry.kind === "tg.user")!;
		const edit = await root.submit(
			{ type: "write", entry: { kind: "redact", edits: [{ target: target.id, action: "omit" }] } },
			context,
		);
		const note = await root.submit({ type: "write", entry: { kind: "note", data: "n" } }, context);
		expect((await note.status(context)).status).toBe("done");
		expect((await queuedItems(harness, root)).map((item) => [item.id, item.mode])).toEqual([
			[followUp.id, "followUp"],
			[model.id, "write"],
			[edit.id, "write"],
		]);
		first.release();
		await followUp.wait(context);
		expect(await entryFacts(await allEntries(root))).toEqual([
			["tg.user", "a"],
			["note", "n"],
			["tg.assistant", "first"],
			["note", "m"],
			["redact"],
			["tg.user", "f"],
			["tg.assistant", "second"],
		]);
		expect(await input.status(context)).toMatchObject({ status: "done" });
		await harness.close(context);
	});
});
