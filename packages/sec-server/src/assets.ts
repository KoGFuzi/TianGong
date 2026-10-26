import fsp from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** One file the WebUI needs, already read and typed for the response. */
export type SecWebAsset = {
	readonly body: Buffer;
	readonly contentType: string;
};

export type SecWebAssets = {
	readonly index: SecWebAsset;
	readonly script: SecWebAsset;
	readonly style: SecWebAsset;
};

/** `<package>/web/` from both `src/assets.ts` and `dist/assets.js`. */
export function defaultSecWebDir(): string {
	return fileURLToPath(new URL("../web/", import.meta.url));
}

/**
 * Load the three files the shell serves. The directory is read once at startup: the WebUI is part of
 * the installed package, not a live-reload surface, and a missing file is a packaging error that
 * should fail the server rather than produce a half-rendered page.
 */
export async function loadSecWebAssets(directory: string = defaultSecWebDir()): Promise<SecWebAssets> {
	const [index, script, style] = await Promise.all([
		readAsset(join(directory, "index.html"), "text/html; charset=utf-8"),
		readAsset(join(directory, "app.js"), "text/javascript; charset=utf-8"),
		readAsset(join(directory, "style.css"), "text/css; charset=utf-8"),
	]);
	return { index, script, style };
}

async function readAsset(path: string, contentType: string): Promise<SecWebAsset> {
	try {
		return { body: await fsp.readFile(path), contentType };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`tg-sec-server: cannot read web asset ${path}: ${reason}`);
	}
}
