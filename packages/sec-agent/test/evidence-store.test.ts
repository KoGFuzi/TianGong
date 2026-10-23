import { type NodeSqliteDatabase, openNodeSqliteDatabase } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceIndexPath } from "../src/evidence/config.ts";
import { TgSecEvidenceConflictError, TgSecEvidenceNotFoundError } from "../src/evidence/errors.ts";
import { isEvidenceHash } from "../src/evidence/hashing.ts";
import {
	openTgSecEvidenceStore,
	type TgSecEvidenceRecordInput,
	type TgSecEvidenceStore,
} from "../src/evidence/store.ts";
import { cleanupTempDirs, tempDir } from "./support.ts";

const REQUEST = Buffer.from("hello-request");
const RESPONSE = Buffer.from("hello-response-payload");

const INPUT: TgSecEvidenceRecordInput = {
	sourceId: "src-1",
	capturedAt: 1_700_000_000_000,
	url: "http://example.test/api",
	method: "POST",
	status: 201,
	contentType: "application/json",
	reqHead: "Host: example.test",
	respHead: "HTTP/1.1 201 Created",
};

let dir: string;
let store: TgSecEvidenceStore;

beforeEach(async () => {
	dir = await tempDir("tg-sec-evidence-");
	store = await openTgSecEvidenceStore({ dir });
});

afterEach(async () => {
	await store.close();
	await cleanupTempDirs();
});

describe("evidence record", () => {
	it("freezes one exchange into a content-addressed snapshot id derived from its facts", async () => {
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		expect(isEvidenceHash(snap.id)).toBe(true);
		expect(snap.fields.reqLen).toBe(REQUEST.length);
		expect(snap.fields.respLen).toBe(RESPONSE.length);
		expect(isEvidenceHash(snap.fields.reqHash)).toBe(true);
		expect(isEvidenceHash(snap.fields.respHash)).toBe(true);
	});

	it("is idempotent — recording the same exchange twice neither forks a row nor throws", async () => {
		const first = await store.record(REQUEST, RESPONSE, INPUT);
		const second = await store.record(REQUEST, RESPONSE, INPUT);
		expect(second.id).toBe(first.id);
	});

	it("reads back the exact request and response bodies, one blob per side", async () => {
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		expect(Buffer.compare(await store.readBody(snap.id, "request"), REQUEST)).toBe(0);
		expect(Buffer.compare(await store.readBody(snap.id, "response"), RESPONSE)).toBe(0);
	});

	it("refuses to read a snapshot that was never recorded", async () => {
		await expect(store.readBody("0".repeat(64), "request")).rejects.toBeInstanceOf(TgSecEvidenceNotFoundError);
	});
});

describe("evidence bind", () => {
	it("appends bindings in order and opens the subject at version 1", async () => {
		const a = await store.record(REQUEST, RESPONSE, INPUT);
		const b = await store.record(RESPONSE, REQUEST, { ...INPUT, url: "http://example.test/other" });
		const set = await store.bind("subject-A", null, [
			{ snapshotId: a.id, role: "proof" },
			{ snapshotId: b.id, role: "baseline", note: "n" },
		]);
		expect(set.version).toBe(1);
		expect(set.bindings.map((binding) => binding.position)).toEqual([0, 1]);
		expect(set.bindings.map((binding) => binding.snapshotId)).toEqual([a.id, b.id]);
		expect(set.bindings[1]).toMatchObject({ role: "baseline", note: "n" });
	});

	it("never overwrites an existing binding's role or note on rebind", async () => {
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		await store.bind("subject-A", null, [{ snapshotId: snap.id, role: "proof", note: "keep" }]);
		const again = await store.bind("subject-A", 1, [{ snapshotId: snap.id, role: "baseline", note: "changed" }]);
		expect(again.bindings[0]).toMatchObject({ role: "proof", note: "keep" });
	});

	it("bumps the version only when something was actually added", async () => {
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		const first = await store.bind("subject-A", null, [{ snapshotId: snap.id }]);
		const second = await store.bind("subject-A", first.version, [{ snapshotId: snap.id }]);
		expect(second.version).toBe(first.version);
	});

	it("clears GC's unreferenced mark when a snapshot is re-bound", async () => {
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		const reader = await openNodeSqliteDatabase(evidenceIndexPath(dir));
		try {
			await reader.run("UPDATE tg_sec_evidence_snapshots SET unreferenced_at = ? WHERE id = ?", 123, snap.id);
			expect(await unreferencedOf(reader, snap.id)).toBe(123);
			await store.bind("subject-A", null, [{ snapshotId: snap.id }]);
			expect(await unreferencedOf(reader, snap.id)).toBeNull();
		} finally {
			await reader.close();
		}
	});

	it("rejects binding a snapshot that does not exist", async () => {
		await expect(store.bind("subject-A", null, [{ snapshotId: "f".repeat(64) }])).rejects.toBeInstanceOf(
			TgSecEvidenceNotFoundError,
		);
	});
});

describe("evidence list and edit", () => {
	it("lists a subject's set in display order", async () => {
		const a = await store.record(REQUEST, RESPONSE, INPUT);
		const b = await store.record(RESPONSE, REQUEST, { ...INPUT, url: "http://example.test/other" });
		const set = await store.bind("subject-A", null, [{ snapshotId: a.id }, { snapshotId: b.id }]);
		const listed = await store.list("subject-A");
		expect(listed).toEqual(set);
	});

	it("reorders the whole set under a matching version and bumps it", async () => {
		const a = await store.record(REQUEST, RESPONSE, INPUT);
		const b = await store.record(RESPONSE, REQUEST, { ...INPUT, url: "http://example.test/other" });
		const set = await store.bind("subject-A", null, [{ snapshotId: a.id }, { snapshotId: b.id }]);
		const [first, second] = set.bindings;
		const reordered = await store.edit("subject-A", set.version, { reorder: [second.bindingId, first.bindingId] });
		expect(reordered.version).toBe(set.version + 1);
		expect(reordered.bindings.map((binding) => binding.snapshotId)).toEqual([b.id, a.id]);
	});

	it("removes a binding, leaving the snapshot itself readable", async () => {
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		const set = await store.bind("subject-A", null, [{ snapshotId: snap.id }]);
		const edited = await store.edit("subject-A", set.version, { bindingId: set.bindings[0].bindingId, remove: true });
		expect(edited.bindings).toHaveLength(0);
		expect(Buffer.compare(await store.readBody(snap.id, "request"), REQUEST)).toBe(0);
	});

	it("refuses a reorder that does not cover exactly the current bindings", async () => {
		const a = await store.record(REQUEST, RESPONSE, INPUT);
		const b = await store.record(RESPONSE, REQUEST, { ...INPUT, url: "http://example.test/other" });
		const set = await store.bind("subject-A", null, [{ snapshotId: a.id }, { snapshotId: b.id }]);
		await expect(
			store.edit("subject-A", set.version, { reorder: [set.bindings[0].bindingId] }),
		).rejects.toBeInstanceOf(TgSecEvidenceConflictError);
	});

	it("rejects an edit against a stale version", async () => {
		const snap = await store.record(REQUEST, RESPONSE, INPUT);
		await store.bind("subject-A", null, [{ snapshotId: snap.id }]);
		await expect(store.edit("subject-A", 99, { bindingId: 1, note: "x" })).rejects.toBeInstanceOf(
			TgSecEvidenceConflictError,
		);
	});
});

async function unreferencedOf(reader: NodeSqliteDatabase, id: string): Promise<number | null> {
	const row = await reader.get<{ u: number | null }>(
		"SELECT unreferenced_at AS u FROM tg_sec_evidence_snapshots WHERE id = ?",
		id,
	);
	return row?.u ?? null;
}
