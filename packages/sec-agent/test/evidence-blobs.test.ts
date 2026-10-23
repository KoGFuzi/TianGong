import fs from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceBlobStore } from "../src/evidence/blobs.ts";
import { blobPath } from "../src/evidence/config.ts";
import { tgSecContentHash } from "../src/evidence/hashing.ts";
import { cleanupTempDirs, tempDir } from "./support.ts";

const BODY = Buffer.from("request-body-bytes");
const HASH = tgSecContentHash(BODY);

let dir: string;
let store: EvidenceBlobStore;

beforeEach(async () => {
	dir = await tempDir("tg-sec-evidence-");
	store = new EvidenceBlobStore(dir);
});

afterEach(cleanupTempDirs);

describe("evidence blob write", () => {
	it("lands the body at its content address, blobs/<hash[:2]>/<hash>.bin", async () => {
		const write = await store.writeBody(BODY);
		expect(write).toEqual({ hash: HASH, length: BODY.length });
		const at = blobPath(dir, HASH);
		expect(at).toBe(join(dir, "blobs", HASH.slice(0, 2), `${HASH}.bin`));
		expect(fs.existsSync(at)).toBe(true);
	});

	it("gives a directory mode 0700 and a blob mode 0600", async () => {
		await store.writeBody(BODY);
		const at = blobPath(dir, HASH);
		expect((fs.statSync(at).mode & 0o777).toString(8)).toBe("600");
		expect((fs.statSync(join(dir, "blobs", HASH.slice(0, 2))).mode & 0o777).toString(8)).toBe("700");
	});

	it("does not rewrite an existing blob — it re-verifies and refreshes the grace window instead", async () => {
		await store.writeBody(BODY);
		const at = blobPath(dir, HASH);
		// Age the file a full hour, so a genuine touch moves mtime clearly forward.
		const past = new Date(Date.now() - 60 * 60 * 1000);
		await fsp.utimes(at, past, past);
		await store.writeBody(BODY);
		expect((await fsp.stat(at)).mtimeMs).toBeGreaterThan(past.getTime());
	});

	it("refuses a body whose length gate fails, leaving no blob behind", async () => {
		await expect(store.writeBody(BODY, { expectedLength: BODY.length + 1 })).rejects.toThrow(/incomplete/);
		expect(fs.existsSync(blobPath(dir, HASH))).toBe(false);
	});

	it("refuses a body whose optional hash gate disagrees with what was captured", async () => {
		await expect(store.writeBody(BODY, { expectedHash: tgSecContentHash(Buffer.from("other")) })).rejects.toThrow(
			/hash mismatch/,
		);
		expect(fs.existsSync(blobPath(dir, HASH))).toBe(false);
	});

	it("rejects a write over a tampered existing blob of the same length — verification runs before reuse", async () => {
		await store.writeBody(BODY);
		const at = blobPath(dir, HASH);
		await fsp.writeFile(at, Buffer.from("x".repeat(BODY.length)));
		await expect(store.writeBody(BODY)).rejects.toThrow(/content check failed/);
	});
});

describe("evidence blob read", () => {
	it("reads a body back by address and returns exactly what was written", async () => {
		await store.writeBody(BODY);
		const read = await store.readBody(HASH);
		expect(Buffer.compare(read, BODY)).toBe(0);
	});

	it("refuses to return bytes that no longer hash to their address", async () => {
		await store.writeBody(BODY);
		await fsp.writeFile(blobPath(dir, HASH), Buffer.from("corrupted, different length"));
		await expect(store.readBody(HASH)).rejects.toThrow(/does not hash to its own address/);
	});

	it("rejects a malformed address instead of touching the filesystem", async () => {
		await expect(store.readBody("not-a-hash")).rejects.toThrow(/64 lowercase hex/);
	});
});
