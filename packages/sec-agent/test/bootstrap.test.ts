import { fauxAssistantMessage, fauxText, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSecAgent } from "../src/index.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir } from "./support.ts";

afterEach(cleanupTempDirs);

describe("openSecAgent durable day-one", () => {
	it("opens on real SQLite storage with health, checkpoint and backup wired", async () => {
		const dir = await tempDir();
		const path = join(dir, "session.sqlite");
		const { models } = fauxSetup();
		const agent = await openSecAgent({
			context,
			project: "alpha",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path,
		});

		expect(agent.storage.project).toBe("alpha");
		expect(Number(agent.root.id)).toBe(1);
		// The observed `health()` report shape for a file-backed database (probe, not inference).
		expect(await agent.storage.health()).toMatchObject({ ok: true, integrity: "ok", journalMode: "wal" });
		await agent.storage.checkpoint();
		const backupPath = join(dir, "backup.sqlite");
		await agent.storage.backup(backupPath, context);
		expect(await agent.storage.health()).toMatchObject({ ok: true });
		expect(agent.reports).toEqual([]);

		await agent.close(context);
	});

	it("runs tools through the env resolver, not bare in the orchestration process", async () => {
		const dir = await tempDir();
		const { faux, models } = fauxSetup();
		faux.setResponses([
			fauxAssistantMessage([fauxText("checking cwd"), fauxToolCall("bash", { command: "pwd" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const agent = await openSecAgent({
			context,
			project: "env-run",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
		});
		const submission = await agent.root.submit({ type: "input", content: "where are we" }, context);
		expect((await submission.wait(context)).status).toBe("done");

		const page = await agent.root.entries({}, 100, undefined, context);
		const results = page.items.filter((entry) => entry.kind === "tg.tool-result");
		expect(results).toHaveLength(1);
		const message = results[0]!.model![0] as { content: { type: string; text: string }[]; isError?: boolean };
		expect(message.content.map((block) => block.text).join("")).toContain(basename(dir));
		await agent.close(context);
	}, 30_000);

	it("keeps campaigns one-file-per-project because the reserved root ID is claimed globally", async () => {
		const dir = await tempDir();
		const path = join(dir, "shared.sqlite");
		const { models } = fauxSetup();
		const first = await openSecAgent({
			context,
			project: "alpha",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path,
		});
		await first.close(context);
		// A second project in the same file recreates the reserved root conversation (ID 1) and the
		// global record-ID claim rejects it. This pins the constraint behind the one-file-per-project default.
		await expect(
			openSecAgent({ context, project: "beta", lane: "ctf", models, model: fauxModel, cwd: dir, path }),
		).rejects.toThrow(/already belongs to conversation/);
	});

	it("isolates reads by project even when both projects hold their own file", async () => {
		const dir = await tempDir();
		const { models } = fauxSetup();
		const alpha = await openSecAgent({
			context,
			project: "alpha",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "alpha.sqlite"),
		});
		const entry = await alpha.root.commit(
			(tx) =>
				tx.appendEntry(alpha.root.id, {
					kind: "sec.note",
					model: [{ role: "user", content: "secret", timestamp: 1 }],
				}),
			context,
		);
		const beta = await openSecAgent({
			context,
			project: "beta",
			lane: "ctf",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "beta.sqlite"),
		});
		expect(await beta.harness.commit((tx) => tx.entry(entry.id), context)).toBeUndefined();
		const page = await beta.harness.commit((tx) => tx.scanConversations({}, 50), context);
		expect(page.items.map((c) => Number(c.id))).toEqual([1]);
		await alpha.close(context);
		await beta.close(context);
	});
});
