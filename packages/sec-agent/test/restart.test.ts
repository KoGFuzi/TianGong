import { type FauxResponseStep, fauxAssistantMessage } from "@OnePanda-TgSec/tg-ai";
import { AssistantEntry, createRegistry, Harness } from "@OnePanda-TgSec/tg-gibraltar";
import { openNodeSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSecAgent } from "../src/index.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir, unanswered } from "./support.ts";

afterEach(cleanupTempDirs);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(message: unknown): string {
	const content = (message as { content?: { type: string; text?: string }[] } | undefined)?.content;
	return content?.map((block) => block.text ?? "").join("") ?? "";
}

describe("restart recovery", () => {
	it("does not dispatch the interrupted run before resume() and converges after it", async () => {
		const dir = await tempDir();
		const path = join(dir, "session.sqlite");
		const project = "restart";

		// The interruption gibraltar's own recovery suites pin: a request dispatched, the Harness
		// ended before any partial arrived, the checkpoint durable in the file.
		const { faux: faux1, models: models1 } = fauxSetup();
		const hang = unanswered();
		faux1.setResponses([hang.step]);
		const crashed = await openSecAgent({
			context,
			project,
			lane: "redteam",
			models: models1,
			model: fauxModel,
			cwd: dir,
			path,
		});
		const submission = await crashed.root.submit({ type: "input", content: "start" }, context);
		await hang.reached;
		await crashed.close(context);

		const calls: number[] = [];
		const { faux: faux2, models: models2 } = fauxSetup();
		const recovered = fauxAssistantMessage("recovered");
		const counted: FauxResponseStep = () => {
			calls.push(1);
			return recovered;
		};
		faux2.setResponses([counted]);

		const storage2 = await openNodeSqliteStorage(path, { project });
		const reopened = await Harness.open(storage2, { models: models2, registry: createRegistry() }, context);
		const root = await reopened.root(context, { agent: { model: fauxModel, cwd: dir } });
		await delay(100);
		// Criterion 2: opening reads the durable records; scheduling stays off until resume().
		expect(calls).toHaveLength(0);

		reopened.resume();
		const settled = await (await reopened.submission(submission.id, context))!.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
		expect(calls.length).toBeGreaterThan(0);

		const answerEntry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		expect(textOf(answerEntry?.model?.[0])).toBe("recovered");

		await reopened.close(context);
	}, 30_000);
});
