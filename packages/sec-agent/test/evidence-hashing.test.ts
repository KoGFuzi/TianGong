import { describe, expect, it } from "vitest";
import {
	encodeEvidenceSnapshotPreimage,
	isEvidenceHash,
	normalizeEvidenceFields,
	normalizeEvidenceText,
	snapshotMetadataId,
	type TgSecEvidenceSnapshotFields,
	tgSecContentHash,
} from "../src/evidence/hashing.ts";

const REQ_HASH = tgSecContentHash(Buffer.from("request-body"));
const RESP_HASH = tgSecContentHash(Buffer.from("response-body"));
const OTHER_HASH = tgSecContentHash(Buffer.from("other"));

function fields(overrides: Partial<TgSecEvidenceSnapshotFields> = {}): TgSecEvidenceSnapshotFields {
	return {
		sourceId: "traffic-1",
		capturedAt: 1730000000000,
		url: "http://target.example/path",
		method: "GET",
		status: 200,
		contentType: "text/plain",
		reqHead: "GET /path HTTP/1.1",
		respHead: "HTTP/1.1 200 OK",
		reqHash: REQ_HASH,
		respHash: RESP_HASH,
		reqLen: 12,
		respLen: 13,
		...overrides,
	};
}

describe("evidence content hash", () => {
	it("accepts only 64 lowercase hex; uppercase, short and non-hex are rejected", () => {
		expect(isEvidenceHash(REQ_HASH)).toBe(true);
		expect(isEvidenceHash(REQ_HASH.toUpperCase())).toBe(false);
		expect(isEvidenceHash(REQ_HASH.slice(0, 63))).toBe(false);
		expect(isEvidenceHash(`${REQ_HASH.slice(0, 63)}g`)).toBe(false);
	});

	it("hashes the raw bytes handed in, lowercase hex of fixed length", () => {
		const hash = tgSecContentHash(Buffer.from("abc"));
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).toBe(tgSecContentHash(Buffer.from("abc")));
		expect(hash).not.toBe(tgSecContentHash(Buffer.from("abd")));
	});
});

describe("evidence text normalization", () => {
	it("drops NUL bytes", () => {
		expect(normalizeEvidenceText("a\0b\0c")).toBe("abc");
	});

	it("collapses a lone surrogate to U+FFFD through the UTF-8 round trip", () => {
		expect(normalizeEvidenceText("\ud800")).toBe("\uFFFD");
		expect(normalizeEvidenceText("a\ud800b")).toBe("a\uFFFDb");
		expect(normalizeEvidenceText("\ud800").includes("\0")).toBe(false);
	});
});

describe("evidence snapshot id", () => {
	it("is deterministic and a 64 lowercase hex digest", () => {
		const id = snapshotMetadataId(fields());
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect(id).toBe(snapshotMetadataId(fields()));
	});

	it("changes when any single fact changes", () => {
		const base = snapshotMetadataId(fields());
		expect(snapshotMetadataId(fields({ capturedAt: 1730000000001 }))).not.toBe(base);
		expect(snapshotMetadataId(fields({ status: 500 }))).not.toBe(base);
		expect(snapshotMetadataId(fields({ reqHash: OTHER_HASH }))).not.toBe(base);
	});

	it("keeps the two hash domains distinct: the blob key feeds the id, but is not the id", () => {
		const id = snapshotMetadataId(fields());
		expect(id).not.toBe(REQ_HASH);
		expect(id).not.toBe(RESP_HASH);
	});

	it("resists boundary forgery — a length prefix makes the field split part of the encoding", () => {
		const first = fields({ url: "a", method: "bc" });
		const forged = fields({ url: "ab", method: "c" });
		expect(snapshotMetadataId(first)).not.toBe(snapshotMetadataId(forged));
	});

	it("starts the preimage with the domain tag and is byte-stable across calls", () => {
		const tag = "tg.sec.evidence/v1\0";
		const preimage = encodeEvidenceSnapshotPreimage(normalizeEvidenceFields(fields()));
		expect(Buffer.from(preimage).subarray(0, tag.length).toString("utf8")).toBe(tag);
		const again = encodeEvidenceSnapshotPreimage(normalizeEvidenceFields(fields()));
		expect(Buffer.compare(preimage, again)).toBe(0);
	});

	it("folds the id fields but carries no id or creation time of its own", () => {
		// capturedAt is in the preimage (changing it changes the id), while a caller-supplied id or
		// created-at is structurally absent from TgSecEvidenceSnapshotFields — the id cannot echo them.
		expect(Object.keys(normalizeEvidenceFields(fields())).sort()).toEqual([
			"capturedAt",
			"contentType",
			"method",
			"reqHash",
			"reqHead",
			"reqLen",
			"respHash",
			"respHead",
			"respLen",
			"sourceId",
			"status",
			"url",
		]);
	});
});

describe("evidence field validation is fail-closed", () => {
	it("rejects a content hash that is not 64 lowercase hex", () => {
		expect(() => snapshotMetadataId(fields({ reqHash: "Z".repeat(64) }))).toThrow(TypeError);
	});

	it("rejects a status outside uint32 and a non-integer", () => {
		expect(() => snapshotMetadataId(fields({ status: -1 }))).toThrow(TypeError);
		expect(() => snapshotMetadataId(fields({ status: 0x100000000 }))).toThrow(TypeError);
		expect(() => snapshotMetadataId(fields({ status: 200.5 }))).toThrow(TypeError);
	});

	it("rejects a negative or non-safe body length", () => {
		expect(() => snapshotMetadataId(fields({ reqLen: -1 }))).toThrow(TypeError);
		expect(() => snapshotMetadataId(fields({ respLen: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(TypeError);
	});

	it("rejects a non-integer captured time", () => {
		expect(() => snapshotMetadataId(fields({ capturedAt: 1.5 }))).toThrow(TypeError);
	});
});
