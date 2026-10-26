import type { Context } from "@OnePanda-TgSec/chord";
import type { Api, Message, Model, Models, MutableModels } from "@OnePanda-TgSec/tg-ai";
import { FileCredentialStore } from "@OnePanda-TgSec/tg-ai/auth/node";
import { builtinModels } from "@OnePanda-TgSec/tg-ai/providers/all";
import type { Conversation, ModelRef } from "@OnePanda-TgSec/tg-gibraltar";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tgSecDataDir } from "../config.ts";

/**
 * The ref the harness carries while no model is chosen. It is never persisted and never sent to a
 * provider: a shell that opens without credentials must exist before a model does.
 */
export const UNCONFIGURED_MODEL: ModelRef = { provider: "unconfigured", modelId: "unconfigured" };

export function isUnconfiguredModel(ref: ModelRef | undefined): boolean {
	return (
		ref !== undefined && ref.provider === UNCONFIGURED_MODEL.provider && ref.modelId === UNCONFIGURED_MODEL.modelId
	);
}

/** The local echo provider. Its turns are test data and must never steer a real model. */
export const FAUX_PROVIDER_ID = "faux";

export function isFauxModelRef(ref: ModelRef | undefined): boolean {
	return ref?.provider === FAUX_PROVIDER_ID;
}

/** True when the active model context still carries an assistant turn produced by faux. */
export function hasFauxTurns(messages: readonly Message[]): boolean {
	return messages.some((message) => message.role === "assistant" && message.provider === FAUX_PROVIDER_ID);
}

/**
 * Start a clean context when a real model is chosen over a conversation that still carries faux
 * test turns. A real model continues the persona it finds in the transcript, so leaving those
 * turns in context makes a correctly configured provider look like it is still the local echo.
 * Returns true when a reset was written.
 */
export async function resetFauxContext(
	conversation: Pick<Conversation, "context" | "reset">,
	next: ModelRef | undefined,
	context: Context,
): Promise<boolean> {
	if (next === undefined || isFauxModelRef(next)) return false;
	const { messages } = await conversation.context(context);
	if (!hasFauxTurns(messages)) return false;
	await conversation.reset(undefined, context);
	return true;
}

/** A stable machine identity for provider logins; the auth flows may key tokens to it. */
export async function readOrCreateDeviceId(dataDir: string = tgSecDataDir()): Promise<string> {
	const path = join(dataDir, "device-id");
	await mkdir(dataDir, { recursive: true });
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const id = randomUUID();
	try {
		await writeFile(path, `${id}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return id;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return (await readFile(path, "utf8")).trim();
	}
}

/** The real provider catalog, backed by the on-disk credential store `tgsec login` writes. */
export function createTgSecModels(): MutableModels {
	return builtinModels({ credentials: new FileCredentialStore() });
}

/**
 * Parse a `provider/modelId` spec at the first slash: model ids may carry slashes themselves
 * (`openrouter/vendor/model`), provider ids never do. An empty side is not a spec.
 */
export function parseModelSpec(spec: string): ModelRef | undefined {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export function formatModelRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.modelId}`;
}

/** The remembered model for the interactive shell, under the same machine-state root as the sessions. */
export function tgSecModelConfigPath(dataDir: string = tgSecDataDir()): string {
	return join(dataDir, "tui-model.json");
}

export async function readTgSecModelConfig(dataDir: string = tgSecDataDir()): Promise<ModelRef | undefined> {
	let text: string;
	try {
		text = await readFile(tgSecModelConfigPath(dataDir), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	const provider = record.provider;
	const modelId = record.modelId;
	if (typeof provider !== "string" || provider === "") return undefined;
	if (typeof modelId !== "string" || modelId === "") return undefined;
	return { provider, modelId };
}

/** Crash-safe write: the shell's remembered model is a preference, never state a half-write may corrupt. */
export async function writeTgSecModelConfig(ref: ModelRef, dataDir: string = tgSecDataDir()): Promise<void> {
	const path = tgSecModelConfigPath(dataDir);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify({ provider: ref.provider, modelId: ref.modelId }, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

/** One authenticated chat model with the spec that addresses it. */
export type TgSecResolvedModel = {
	readonly ref: ModelRef;
	readonly model: Model<Api>;
	readonly source: "argument" | "environment" | "saved" | "available";
};

/** The authenticated chat model a spec names, or undefined when the provider is not configured or lacks it. */
export async function findAvailableModel(models: Models, ref: ModelRef): Promise<Model<Api> | undefined> {
	const available = await models.getAvailable(ref.provider);
	return available.find((model) => model.id === ref.modelId);
}

/**
 * Resolve the model the shell runs on: explicit argument, then `TG_SEC_MODEL`, then the remembered
 * choice, then the first authenticated chat model. Every candidate is checked against
 * `getAvailable`, so a stale preference or an unauthenticated spec fails here with a login hint
 * instead of failing inside the first generation. `undefined` means the shell should open without a
 * model and let `/connect` and `/models` fill the gap.
 */
export async function tryResolveTgSecModel(
	models: Models,
	options: { explicit?: string; env?: NodeJS.ProcessEnv; dataDir?: string } = {},
): Promise<TgSecResolvedModel | undefined> {
	const env = options.env ?? process.env;
	const candidates: { readonly spec: string; readonly source: TgSecResolvedModel["source"] }[] = [];
	if (options.explicit !== undefined && options.explicit.trim() !== "") {
		candidates.push({ spec: options.explicit, source: "argument" });
	}
	const fromEnv = env.TG_SEC_MODEL;
	if (fromEnv !== undefined && fromEnv.trim() !== "") candidates.push({ spec: fromEnv, source: "environment" });
	const saved = await readTgSecModelConfig(options.dataDir);
	if (saved !== undefined) candidates.push({ spec: formatModelRef(saved), source: "saved" });

	for (const candidate of candidates) {
		const ref = parseModelSpec(candidate.spec);
		if (ref === undefined) {
			if (candidate.source === "saved") continue;
			throw new TypeError(`model spec ${JSON.stringify(candidate.spec)} must be provider/modelId`);
		}
		const model = await findAvailableModel(models, ref);
		if (model !== undefined) return { ref, model, source: candidate.source };
		if (candidate.source === "argument" || candidate.source === "environment") {
			throw new Error(
				`model ${formatModelRef(ref)} is not available: provider ${JSON.stringify(ref.provider)} is not authenticated or does not offer it (run "tgsec login")`,
			);
		}
	}

	const available = await models.getAvailable();
	const first = available[0];
	if (first === undefined) return undefined;
	return { ref: { provider: first.provider, modelId: first.id }, model: first, source: "available" };
}

/**
 * The throwing form for callers that cannot open without a model (the `tg-sec` smoke path). The
 * shell uses `tryResolveTgSecModel` so it can open first and configure later.
 */
export async function resolveTgSecModel(
	models: Models,
	options: { explicit?: string; env?: NodeJS.ProcessEnv; dataDir?: string } = {},
): Promise<TgSecResolvedModel> {
	const resolved = await tryResolveTgSecModel(models, options);
	if (resolved !== undefined) return resolved;
	throw new Error('no authenticated model found: run "tgsec login" to sign in to a provider, or pass --faux');
}
