import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceDir, evidenceIndexPath } from "../src/evidence/config.ts";
import {
	openTgSecEvidenceStore,
	type TgSecEvidenceRecordInput,
	type TgSecEvidenceStore,
} from "../src/evidence/store.ts";
import { cleanupTempDirs, tempDir } from "./support.ts";

const BODY = Buffer.from("thread-body");
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

let dataDir: string;
const openStores: TgSecEvidenceStore[] = [];

async function openIn(dir: string): Promise<TgSecEvidenceStore> {
	const store = await openTgSecEvidenceStore({ dir });
	openStores.push(store);
	return store;
}

beforeEach(async () => {
	dataDir = await tempDir("tg-sec-threads-");
});

afterEach(async () => {
	while (openStores.length > 0) await openStores.pop()?.close();
	await cleanupTempDirs();
});

describe("evidence index separation", () => {
	it("lives in its own SQLite file under the project's evidence directory", async () => {
		const dir = evidenceDir("campaign-one", dataDir);
		const store = await openIn(dir);
		await store.record(BODY, BODY, INPUT);
		expect(fs.existsSync(evidenceIndexPath(dir))).toBe(true);
		expect(evidenceIndexPath(dir)).toBe(`${dir}/evidence.sqlite`);
	});

	it("is scoped per project and never shares a file with another project", async () => {
		const one = evidenceDir("campaign-one", dataDir);
		const two = evidenceDir("campaign-two", dataDir);
		expect(one).not.toBe(two);
		const storeOne = await openIn(one);
		const storeTwo = await openIn(two);
		const snap = await storeOne.record(BODY, BODY, INPUT);
		await storeOne.bind("subject-A", null, [{ snapshotId: snap.id }]);
		const foreign = await storeTwo.list("subject-A");
		expect(foreign.bindings).toHaveLength(0);
		expect(foreign.version).toBe(0);
	});

	it("reports a healthy WAL connection for the evidence index", async () => {
		const store = await openIn(evidenceDir("campaign-one", dataDir));
		const health = await store.health();
		expect(health.ok).toBe(true);
		expect(health.integrity).toBe("ok");
		expect(health.journalMode).toBe("wal");
		expect(health.schemaVersion).toBe(0);
		expect(Number.isFinite(health.synchronous)).toBe(true);
		expect(Number.isFinite(health.busyTimeoutMs)).toBe(true);
	});

	it("does not create a session database anywhere in the evidence tree", async () => {
		const dir = evidenceDir("campaign-one", dataDir);
		const store = await openIn(dir);
		await store.record(BODY, BODY, INPUT);
		const walk = (at: string): string[] => {
			const out: string[] = [];
			for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
				const path = `${at}/${entry.name}`;
				if (entry.isDirectory()) out.push(...walk(path));
				else out.push(path);
			}
			return out;
		};
		expect(walk(dir).some((path) => path.endsWith("session.sqlite"))).toBe(false);
	});
});
