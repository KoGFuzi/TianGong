import { createModels, fauxAssistantMessage, type Message } from "@OnePanda-TgSec/tg-ai";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxDatabasePath } from "../src/config.ts";
import { openSecAgent } from "../src/index.ts";
import {
	FAUX_PROVIDER_ID,
	formatModelRef,
	hasFauxTurns,
	isFauxModelRef,
	isUnconfiguredModel,
	parseModelSpec,
	readOrCreateDeviceId,
	readTgSecModelConfig,
	resetFauxContext,
	resolveTgSecModel,
	tgSecModelConfigPath,
	tryResolveTgSecModel,
	UNCONFIGURED_MODEL,
	writeTgSecModelConfig,
} from "../src/tui/model.ts";
import { cleanupTempDirs, context, fauxModel, fauxSetup, tempDir } from "./support.ts";

afterEach(cleanupTempDirs);

describe("parseModelSpec", () => {
	it("splits at the first slash so vendor-prefixed model ids survive", () => {
		expect(parseModelSpec("openrouter/vendor/model")).toEqual({ provider: "openrouter", modelId: "vendor/model" });
	});

	it("rejects a spec with an empty side or no slash", () => {
		expect(parseModelSpec("/faux-1")).toBeUndefined();
		expect(parseModelSpec("faux/")).toBeUndefined();
		expect(parseModelSpec("faux-1")).toBeUndefined();
		expect(parseModelSpec("   ")).toBeUndefined();
	});

	it("formats a ref back into a spec", () => {
		expect(formatModelRef(fauxModel)).toBe("faux/faux-1");
	});
});

describe("remembered model", () => {
	it("round-trips through a data directory", async () => {
		const dir = await tempDir();
		await writeTgSecModelConfig(fauxModel, dir);
		expect(await readTgSecModelConfig(dir)).toEqual(fauxModel);
		expect(JSON.parse(await readFile(tgSecModelConfigPath(dir), "utf8"))).toEqual(fauxModel);
	});

	it("treats a corrupt preference as absent", async () => {
		const dir = await tempDir();
		await writeFile(tgSecModelConfigPath(dir), "{not json", "utf8");
		expect(await readTgSecModelConfig(dir)).toBeUndefined();
	});

	it("treats a missing preference file as absent", async () => {
		expect(await readTgSecModelConfig(await tempDir())).toBeUndefined();
	});
});

describe("resolveTgSecModel", () => {
	it("uses the explicit spec when the provider offers it", async () => {
		const { models } = fauxSetup();
		const resolved = await resolveTgSecModel(models, {
			explicit: "faux/faux-1",
			env: {},
			dataDir: await tempDir(),
		});
		expect(resolved.ref).toEqual(fauxModel);
		expect(resolved.source).toBe("argument");
	});

	it("prefers TG_SEC_MODEL over the remembered preference", async () => {
		const { models } = fauxSetup();
		const dir = await tempDir();
		await writeTgSecModelConfig({ provider: "missing", modelId: "gone" }, dir);
		const resolved = await resolveTgSecModel(models, { env: { TG_SEC_MODEL: "faux/faux-1" }, dataDir: dir });
		expect(resolved.ref).toEqual(fauxModel);
		expect(resolved.source).toBe("environment");
	});

	it("skips a remembered model that is no longer available and takes the first one", async () => {
		const { models } = fauxSetup();
		const dir = await tempDir();
		await writeTgSecModelConfig({ provider: "missing", modelId: "gone" }, dir);
		const resolved = await resolveTgSecModel(models, { env: {}, dataDir: dir });
		expect(resolved.ref).toEqual(fauxModel);
		expect(resolved.source).toBe("available");
	});

	it("fails an explicit unavailable spec instead of silently falling back", async () => {
		const { models } = fauxSetup();
		await expect(
			resolveTgSecModel(models, { explicit: "missing/gone", env: {}, dataDir: await tempDir() }),
		).rejects.toThrow("not available");
	});

	it("names both recovery paths when no provider is authenticated", async () => {
		await expect(resolveTgSecModel(createModels(), { env: {}, dataDir: await tempDir() })).rejects.toThrow("--faux");
	});
});

describe("tryResolveTgSecModel", () => {
	it("returns undefined when no provider is authenticated", async () => {
		await expect(
			tryResolveTgSecModel(createModels(), { env: {}, dataDir: await tempDir() }),
		).resolves.toBeUndefined();
	});

	it("still fails an explicit unavailable spec instead of opening without a model", async () => {
		const { models } = fauxSetup();
		await expect(
			tryResolveTgSecModel(models, { explicit: "missing/gone", env: {}, dataDir: await tempDir() }),
		).rejects.toThrow("not available");
	});

	it("keeps the throwing wrapper's message", async () => {
		await expect(resolveTgSecModel(createModels(), { env: {}, dataDir: await tempDir() })).rejects.toThrow(
			'no authenticated model found: run "tgsec login"',
		);
	});
});

describe("unconfigured model sentinel", () => {
	it("recognises only its own provider and id", () => {
		expect(isUnconfiguredModel(UNCONFIGURED_MODEL)).toBe(true);
		expect(isUnconfiguredModel(fauxModel)).toBe(false);
		expect(isUnconfiguredModel({ provider: "unconfigured", modelId: "other" })).toBe(false);
		expect(isUnconfiguredModel(undefined)).toBe(false);
	});
});

describe("faux context", () => {
	const realModel = { provider: "deepseek", modelId: "deepseek-flash" } as const;
	const fauxTurn = fauxAssistantMessage("hi");
	const realTurn = { ...fauxAssistantMessage("hi"), provider: "deepseek" } satisfies Message;
	const userTurn = { role: "user", content: "hi", timestamp: 0 } satisfies Message;

	function fakeConversation(messages: readonly Message[]) {
		const resets: Array<string | undefined> = [];
		const conversation: Parameters<typeof resetFauxContext>[0] = {
			context: async () => ({ head: undefined, entries: [], contributions: [], messages }),
			reset: async (handoff) => {
				resets.push(handoff);
			},
		};
		return { conversation, resets };
	}

	it("recognises the echo provider only", () => {
		expect(FAUX_PROVIDER_ID).toBe("faux");
		expect(isFauxModelRef(fauxModel)).toBe(true);
		expect(isFauxModelRef(realModel)).toBe(false);
		expect(isFauxModelRef(undefined)).toBe(false);
	});

	it("finds a faux assistant turn in the active context", () => {
		expect(hasFauxTurns([userTurn, fauxTurn])).toBe(true);
		expect(hasFauxTurns([userTurn, realTurn])).toBe(false);
		expect(hasFauxTurns([])).toBe(false);
	});

	it("clears a context that still carries faux turns when a real model is chosen", async () => {
		const { conversation, resets } = fakeConversation([userTurn, fauxTurn]);
		expect(await resetFauxContext(conversation, realModel, context)).toBe(true);
		expect(resets).toEqual([undefined]);
	});

	it("keeps a clean context and never resets for the echo model or with no model", async () => {
		const clean = fakeConversation([userTurn, realTurn]);
		expect(await resetFauxContext(clean.conversation, realModel, context)).toBe(false);
		expect(clean.resets).toEqual([]);

		const faux = fakeConversation([userTurn, fauxTurn]);
		expect(await resetFauxContext(faux.conversation, fauxModel, context)).toBe(false);
		expect(await resetFauxContext(faux.conversation, undefined, context)).toBe(false);
		expect(faux.resets).toEqual([]);
	});

	it("keeps faux runs out of the campaign database", () => {
		expect(fauxDatabasePath("campaign", "/data")).toBe(
			join("/data", "faux", "projects", "campaign", "session.sqlite"),
		);
	});

	it("removes faux turns from a real conversation context", async () => {
		const dir = await tempDir();
		const { faux, models } = fauxSetup();
		faux.setResponses([fauxAssistantMessage("local echo")]);
		const agent = await openSecAgent({
			context,
			project: "faux-reset",
			lane: "redteam",
			models,
			model: fauxModel,
			cwd: dir,
			path: join(dir, "session.sqlite"),
		});
		try {
			const submission = await agent.root.submit({ type: "input", content: "hi" }, context);
			expect((await submission.wait(context)).status).toBe("done");
			expect(hasFauxTurns((await agent.root.context(context)).messages)).toBe(true);

			expect(await resetFauxContext(agent.root, realModel, context)).toBe(true);
			expect(hasFauxTurns((await agent.root.context(context)).messages)).toBe(false);
		} finally {
			await agent.close(context);
		}
	}, 30_000);
});

describe("readOrCreateDeviceId", () => {
	it("creates one stable id per data directory", async () => {
		const dir = await tempDir();
		const first = await readOrCreateDeviceId(dir);
		const second = await readOrCreateDeviceId(dir);
		expect(first).toMatch(/^[0-9a-f-]{36}$/u);
		expect(second).toBe(first);
		expect((await readFile(`${dir}/device-id`, "utf8")).trim()).toBe(first);
	});
});
