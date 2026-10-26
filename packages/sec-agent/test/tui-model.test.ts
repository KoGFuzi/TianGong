import { createModels } from "@OnePanda-TgSec/tg-ai";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatModelRef,
	isUnconfiguredModel,
	parseModelSpec,
	readOrCreateDeviceId,
	readTgSecModelConfig,
	resolveTgSecModel,
	tgSecModelConfigPath,
	tryResolveTgSecModel,
	UNCONFIGURED_MODEL,
	writeTgSecModelConfig,
} from "../src/tui/model.ts";
import { cleanupTempDirs, fauxModel, fauxSetup, tempDir } from "./support.ts";

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
