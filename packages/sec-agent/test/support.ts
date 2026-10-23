import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxProvider,
	type Models,
} from "@OnePanda-TgSec/tg-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const context = BACKGROUND_CONTEXT;

const directories: string[] = [];

/** A temp directory whose SQLite files outlive the test body and die with the suite. */
export async function tempDir(prefix = "tg-sec-agent-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	directories.push(dir);
	return dir;
}

export async function cleanupTempDirs(): Promise<void> {
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
}

/** A faux provider bound to a fresh `Models`, like a host process's own objects. */
export function fauxSetup(): { readonly faux: FauxProviderHandle; readonly models: Models } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

export const fauxModel = { provider: "faux", modelId: "faux-1" } as const;

/**
 * A faux response that never answers; the run stays busy until its generation is cancelled.
 * `reached` resolves once the request was sent, after preparation and the request commit.
 */
export function unanswered(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	const step: FauxResponseStep = (_context, options) =>
		new Promise((_, reject) => {
			reach();
			const signal = options!.signal!;
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	return { step, reached };
}
