import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { blobPath, stagingDir } from "./config.ts";
import { isEvidenceHash, tgSecContentHash } from "./hashing.ts";

/** The result of a body write: where it landed (by content) and how large it is. */
export type TgSecBlobWrite = {
	readonly hash: string;
	readonly length: number;
};

/**
 * The content-addressed, immutable body store — a TypeScript rewrite of ARTEX `evidence/store.go`'s
 * behaviour, **not its source**. Bodies live under `<dir>/blobs/<hash[:2]>/<hash>.bin` and are keyed by
 * `sha256` of their raw bytes, so two identical payloads occupy one file and no path can be trusted
 * over its content.
 *
 * Durability is deliberately stricter than the rest of the house: a body is written to `.staging`,
 * `fsync`-ed, renamed into place, and the **parent directory is `fsync`-ed** so the rename itself
 * survives a crash. A blob that already exists is never rewritten — it is re-verified and its
 * modification time refreshed, the only in-place change an immutable blob ever accepts. Garbage
 * collection counts grace time from that mtime.
 */
export class EvidenceBlobStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/**
	 * Persist one body, returning its content hash. When `expectedLength` is given the byte count must
	 * match it, and when `expectedHash` is given it must equal the hash computed here — the same two
	 * gates ARTEX runs before committing. A body whose target already exists is verified and grace-
	 * refreshed instead of rewritten.
	 */
	async writeBody(
		bytes: Uint8Array,
		options: { readonly expectedLength?: number; readonly expectedHash?: string } = {},
	): Promise<TgSecBlobWrite> {
		const length = options.expectedLength ?? bytes.length;
		if (bytes.length !== length) {
			throw new Error(`evidence body incomplete: expected ${length} bytes, read ${bytes.length}`);
		}
		const hash = tgSecContentHash(bytes);
		if (options.expectedHash !== undefined && options.expectedHash !== hash) {
			throw new Error("evidence body hash mismatch: source traffic and captured bytes disagree");
		}
		const path = blobPath(this.dir, hash);
		if (await this.exists(path)) {
			await this.verifyFile(path, hash, length);
			const now = new Date();
			await fsp.utimes(path, now, now);
			return { hash, length };
		}
		await this.stageIntoPlace(bytes, path);
		return { hash, length };
	}

	/** Whether a body is already on disk at the location its content dictates. */
	async exists(path: string): Promise<boolean> {
		try {
			await fsp.access(path);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	/**
	 * Read a body back by its address, verifying on the way out that the bytes still hash to it. A
	 * mismatch means the blob was tampered with or corrupted — never surfaced as data.
	 */
	async readBody(hash: string): Promise<Buffer> {
		if (!isEvidenceHash(hash)) throw new Error("an evidence body is addressed by 64 lowercase hex");
		const bytes = await fsp.readFile(blobPath(this.dir, hash));
		if (tgSecContentHash(bytes) !== hash) {
			throw new Error(`evidence blob ${hash} does not hash to its own address`);
		}
		return bytes;
	}

	/**
	 * Re-hash a stored file and check it against the address it lives under. The length is checked
	 * first, then the content — a short read is the cheaper failure and the more common one after a
	 * crash.
	 */
	async verifyFile(path: string, hash: string, length: number): Promise<void> {
		const bytes = await fsp.readFile(path);
		if (bytes.length !== length) {
			throw new Error(`evidence blob length check failed for ${hash}: stored ${bytes.length}, expected ${length}`);
		}
		if (tgSecContentHash(bytes) !== hash) {
			throw new Error(`evidence blob content check failed for ${hash}`);
		}
	}

	private async stageIntoPlace(bytes: Uint8Array, path: string): Promise<void> {
		const staging = stagingDir(this.dir);
		await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
		const temp = join(staging, `body-${randomBytes(8).toString("hex")}`);
		try {
			const handle = await fsp.open(temp, "wx", 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			const bucket = dirname(path);
			await fsp.mkdir(bucket, { recursive: true, mode: 0o700 });
			await fsp.rename(temp, path);
			fsyncDirectory(bucket);
		} catch (error) {
			await fsp.rm(temp, { force: true });
			throw error;
		}
	}
}

/** Flush a directory entry so a rename into it is durable across a crash. */
function fsyncDirectory(path: string): void {
	const fd = fs.openSync(path, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}
