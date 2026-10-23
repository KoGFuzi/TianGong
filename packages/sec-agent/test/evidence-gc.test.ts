import fsp from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobPath, stagingDir } from "../src/evidence/config.ts";
import { TgSecEvidenceNotFoundError } from "../src/evidence/errors.ts";
import {
	EVIDENCE_GRACE_MS,
	openTgSecEvidenceStore,
	type TgSecEvidenceRecordInput,
	type TgSecEvidenceStore,
} from "../src/evidence/store.ts";
import { cleanupTempDirs, tempDir } from "./support.ts";

const BASE = 1_000_000_000_000;
const BODY = Buffer.from("gc-body");
const INPUT: TgSecEvidenceRecordInput = {
	sourceId: "s",
	capturedAt: BASE,
	url: "http://example.test",
	method: "GET",
	status: 200,
	contentType: "text/plain",
	reqHead: "",
	respHead: "",
};

let dir: string;
let store: TgSecEvidenceStore;

beforeEach(async () => {
	dir = await tempDir("tg-sec-gc-");
	store = await openTgSecEvidenceStore({ dir, now: () => BASE });
});

afterEach(async () => {
	await store.close();
	await cleanupTempDirs();
});

async function ageFile(path: string, at: number): Promise<void> {
	const when = new Date(at);
	await fsp.utimes(path, when, when);
}

async function exists(path: string): Promise<boolean> {
	try {
		await fsp.access(path);
		return true;
	} catch {
		return false;
	}
}

async function writeOrphan(root: string, name: string, mtime: number): Promise<string> {
	const path = `${root}/${name}`;
	await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await fsp.writeFile(path, BODY);
	await ageFile(path, mtime);
	return path;
}

describe("evidence garbage collection", () => {
	it("spares an unreferenced snapshot inside the grace window and reaps it after", async () => {
		const snap = await store.record(BODY, BODY, INPUT);
		await ageFile(blobPath(dir, snap.fields.reqHash), BASE);
		await ageFile(blobPath(dir, snap.fields.respHash), BASE);

		await store.collect(BASE);
		expect(Buffer.compare(await store.readBody(snap.id, "request"), BODY)).toBe(0);

		await store.collect(BASE + EVIDENCE_GRACE_MS + 1);
		await expect(store.readBody(snap.id, "request")).rejects.toBeInstanceOf(TgSecEvidenceNotFoundError);
		expect(await exists(blobPath(dir, snap.fields.reqHash))).toBe(false);
		expect(await exists(blobPath(dir, snap.fields.respHash))).toBe(false);
	});

	it("never reaps a blob a bound snapshot still references", async () => {
		const snap = await store.record(BODY, BODY, INPUT);
		await store.bind("subject-A", null, [{ snapshotId: snap.id }]);
		await ageFile(blobPath(dir, snap.fields.reqHash), BASE);
		await ageFile(blobPath(dir, snap.fields.respHash), BASE);
		await store.collect(BASE + EVIDENCE_GRACE_MS + 1);
		expect(Buffer.compare(await store.readBody(snap.id, "response"), BODY)).toBe(0);
		expect(await exists(blobPath(dir, snap.fields.reqHash))).toBe(true);
	});

	it("keeps a body shared with a surviving snapshot even after the other snapshot is reaped", async () => {
		const shared = Buffer.from("shared-request-body");
		const oldResponse = Buffer.from("old-unique-response");
		const newResponse = Buffer.from("new-unique-response");
		const old = await store.record(shared, oldResponse, INPUT);
		const kept = await store.record(shared, newResponse, { ...INPUT, url: "http://example.test/2" });
		await store.bind("subject-A", null, [{ snapshotId: kept.id }]);

		// Pass one marks the unbound snapshot; aging the files lets the next pass reap by mtime too.
		await store.collect(BASE);
		await ageFile(blobPath(dir, kept.fields.reqHash), BASE);
		await ageFile(blobPath(dir, old.fields.respHash), BASE);
		await ageFile(blobPath(dir, kept.fields.respHash), BASE);

		await store.collect(BASE + EVIDENCE_GRACE_MS + 1);
		await expect(store.readBody(old.id, "response")).rejects.toBeInstanceOf(TgSecEvidenceNotFoundError);
		expect(Buffer.compare(await store.readBody(kept.id, "request"), shared)).toBe(0);
		expect(Buffer.compare(await store.readBody(kept.id, "response"), newResponse)).toBe(0);
		expect(await exists(blobPath(dir, old.fields.respHash))).toBe(false);
		expect(await exists(blobPath(dir, kept.fields.reqHash))).toBe(true);
	});

	it("reaps a stale orphan blob and a stale staging file but spares fresh ones", async () => {
		const staleBlob = await writeOrphan(`${dir}/blobs/ff`, `${"f".repeat(64)}.bin`, BASE);
		const freshBlob = await writeOrphan(`${dir}/blobs/ee`, `${"e".repeat(64)}.bin`, BASE);
		const staleTemp = await writeOrphan(stagingDir(dir), "body-stale", BASE);
		const freshTemp = await writeOrphan(stagingDir(dir), "body-fresh", BASE);
		await ageFile(freshBlob, BASE + EVIDENCE_GRACE_MS);
		await ageFile(freshTemp, BASE + EVIDENCE_GRACE_MS);

		await store.collect(BASE + EVIDENCE_GRACE_MS);
		expect(await exists(staleBlob)).toBe(false);
		expect(await exists(staleTemp)).toBe(false);
		expect(await exists(freshBlob)).toBe(true);
		expect(await exists(freshTemp)).toBe(true);
	});
});
