import { type FauxResponseStep, fauxAssistantMessage } from "@OnePanda-TgSec/tg-ai";
import { MemoryStorage, projectUsage, UsageDoc } from "@OnePanda-TgSec/tg-gibraltar";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat } from "./chat-support.ts";
import { context } from "./session-support.ts";

const directories: string[] = [];

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "tg-project-usage-"));
	directories.push(directory);
	return join(directory, "session.sqlite");
}

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/**
 * The faux provider replaces any scripted usage with its own token estimate and a zero cost
 * (`withUsageEstimate` in `providers/faux.ts`), so these tests assert the fold against the
 * conversation ledgers themselves rather than against invented token counts.
 */
function reply(text: string): FauxResponseStep {
	return fauxAssistantMessage(text);
}

describe("projectUsage", () => {
	it("folds one conversation's ledger into the project totals", async () => {
		const setup = chatSetup();
		const storage = new MemoryStorage();
		const { harness, root } = await openChat(storage, setup);
		setup.faux.setResponses([reply("ok")]);
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);

		const total = await projectUsage(storage, context);
		expect(total.conversations).toBe(1);
		expect(total.usage).toEqual(await harness.snapshot(UsageDoc, root.id, context));

		await harness.close(context);
	});

	it("adds every conversation's ledger in the storage's project", async () => {
		const setup = chatSetup();
		const storage = new MemoryStorage();
		const { harness, root } = await openChat(storage, setup);

		setup.faux.setResponses([reply("ok")]);
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);

		const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		child.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
		setup.faux.setResponses([reply("yes")]);
		await (await child.submit({ type: "input", content: "hello" }, context)).wait(context);

		const total = await projectUsage(storage, context);
		expect(total.conversations).toBe(2);

		const key = "faux/faux-1";
		const rootLedger = await harness.snapshot(UsageDoc, root.id, context);
		const childLedger = await harness.snapshot(UsageDoc, child.id, context);
		expect(rootLedger).toBeDefined();
		expect(childLedger).toBeDefined();
		const sum = (field: "input" | "output" | "totalTokens"): number =>
			Number(rootLedger?.models[key][field]) + Number(childLedger?.models[key][field]);
		expect(total.usage.models[key]).toMatchObject({
			input: sum("input"),
			output: sum("output"),
			totalTokens: sum("totalTokens"),
		});

		await harness.close(context);
	});

	it("counts a conversation that never spent as absent", async () => {
		const setup = chatSetup();
		const storage = new MemoryStorage();
		const { harness, root } = await openChat(storage, setup);
		setup.faux.setResponses([reply("ok")]);
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		await harness.createConversation({ ownership: { kind: "ownerless" } }, context);

		expect((await projectUsage(storage, context)).conversations).toBe(1);

		await harness.close(context);
	});

	it("returns zero totals for a storage with no conversations", async () => {
		expect(await projectUsage(new MemoryStorage(), context)).toEqual({
			conversations: 0,
			usage: { models: {}, tools: {} },
		});
	});

	it("scopes the fold to the storage's project", async () => {
		const path = await sqlitePath();

		const setup = chatSetup();
		const alpha = await openNodeSqliteStorage(path, { project: "alpha" });
		const { harness, root } = await openChat(alpha, setup);
		setup.faux.setResponses([reply("ok")]);
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);

		// Read before closing: `harness.close` closes the storage it was opened with.
		expect((await projectUsage(alpha, context)).conversations).toBe(1);
		await harness.close(context);

		// Same file, different project: the other project's spend is invisible.
		const beta = await openNodeSqliteStorage(path, { project: "beta" });
		expect(await projectUsage(beta, context)).toEqual({ conversations: 0, usage: { models: {}, tools: {} } });
		await beta.close(context);
	});

	it("agrees between the memory and sqlite backends for the same workload", async () => {
		const path = await sqlitePath();
		const memory = new MemoryStorage();
		const sqlite = await openNodeSqliteStorage(path);

		const folds = [];
		for (const storage of [memory, sqlite]) {
			const setup = chatSetup();
			const { harness, root } = await openChat(storage, setup);
			setup.faux.setResponses([reply("ok")]);
			await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
			// Read before closing: `harness.close` closes the storage it was opened with.
			folds.push(await projectUsage(storage, context));
			await harness.close(context);
		}

		expect(folds[1]).toEqual(folds[0]);
	});
});
