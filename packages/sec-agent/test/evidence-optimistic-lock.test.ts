import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TgSecEvidenceConflictError } from "../src/evidence/errors.ts";
import {
	openTgSecEvidenceStore,
	type TgSecEvidenceRecordInput,
	type TgSecEvidenceStore,
} from "../src/evidence/store.ts";
import { cleanupTempDirs, tempDir } from "./support.ts";

const BODY = Buffer.from("body");

const INPUT: TgSecEvidenceRecordInput = {
	sourceId: "s",
	capturedAt: 1_700_000_000_000,
	url: "http://example.test",
	method: "GET",
	status: 200,
	contentType: "text/plain",
	reqHead: "",
	respHead: "",
};

let dir: string;
let store: TgSecEvidenceStore;
let a: string;
let b: string;

beforeEach(async () => {
	dir = await tempDir("tg-sec-lock-");
	store = await openTgSecEvidenceStore({ dir });
	a = (await store.record(BODY, BODY, INPUT)).id;
	b = (await store.record(Buffer.from("other"), BODY, { ...INPUT, url: "http://example.test/2" })).id;
});

afterEach(async () => {
	await store.close();
	await cleanupTempDirs();
});

describe("evidence optimistic lock", () => {
	it("rejects a bind that supplies a version older than the subject's current one", async () => {
		await store.bind("subject-A", null, [{ snapshotId: a }]);
		await expect(store.bind("subject-A", 0, [{ snapshotId: b }])).rejects.toBeInstanceOf(TgSecEvidenceConflictError);
	});

	it("accepts a bind whose expected version matches, then the bumped version rejects the stale caller", async () => {
		const first = await store.bind("subject-A", null, [{ snapshotId: a }]);
		expect(first.version).toBe(1);
		const second = await store.bind("subject-A", 1, [{ snapshotId: b }]);
		expect(second.version).toBe(2);
		await expect(store.bind("subject-A", 1, [{ snapshotId: a }])).rejects.toBeInstanceOf(TgSecEvidenceConflictError);
	});

	it("treats a null expected version as an unconditional append", async () => {
		await store.bind("subject-A", null, [{ snapshotId: a }]);
		await store.bind("subject-A", null, [{ snapshotId: b }]);
		const set = await store.list("subject-A");
		expect(set.version).toBe(2);
		expect(set.bindings).toHaveLength(2);
	});

	it("serializes concurrent binds on one subject — no lost update, no unique collision", async () => {
		const sets = await Promise.all([
			store.bind("subject-A", null, [{ snapshotId: a }]),
			store.bind("subject-A", null, [{ snapshotId: b }]),
		]);
		const final = await store.list("subject-A");
		expect(final.bindings).toHaveLength(2);
		expect(final.version).toBe(2);
		expect(new Set(final.bindings.map((binding) => binding.position))).toEqual(new Set([0, 1]));
		expect(sets.every((set) => set.subjectId === "subject-A")).toBe(true);
	});

	it("isolates versions per subject", async () => {
		const setA = await store.bind("subject-A", null, [{ snapshotId: a }]);
		const setB = await store.bind("subject-B", null, [{ snapshotId: a }, { snapshotId: b }]);
		expect(setA.version).toBe(1);
		expect(setB.version).toBe(1);
		expect(setB.bindings).toHaveLength(2);
		await store.bind("subject-A", 1, [{ snapshotId: b }]);
		const afterA = await store.list("subject-A");
		const afterB = await store.list("subject-B");
		expect(afterA.version).toBe(2);
		expect(afterB.version).toBe(1);
	});
});
