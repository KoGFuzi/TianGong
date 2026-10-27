import { createHash } from "node:crypto";

/**
 * The metadata that defines one evidence snapshot's identity. Two hashes meet here, in separate
 * domains: the **blob key** is `sha256` of a body's raw bytes (see {@link tgSecContentHash}), while the
 * **snapshot id** is `sha256` of the canonical byte encoding of this record (see
 * {@link snapshotMetadataId}). The record carries no id or creation time of its own — both are excluded
 * from the id preimage, exactly as the ARTEX contract requires, so the id is a pure function of the
 * captured facts.
 */
export type TgSecEvidenceSnapshotFields = {
	readonly sourceId: string;
	readonly capturedAt: number;
	readonly url: string;
	readonly method: string;
	readonly status: number;
	readonly contentType: string;
	readonly reqHead: string;
	readonly respHead: string;
	readonly reqHash: string;
	readonly respHash: string;
	readonly reqLen: number;
	readonly respLen: number;
	/**
	 * The Yakit http-flow id the bodies were fetched from; empty for every other capture. Absent
	 * normalizes to `""`, which keeps the id of pre-flow snapshots byte-identical.
	 */
	readonly flowId?: string;
};

const EVIDENCE_HASH = /^[0-9a-f]{64}$/;

/** A content hash as stored and located on disk: 64 lowercase hex. Uppercase is rejected, not folded. */
export function isEvidenceHash(value: string): boolean {
	return EVIDENCE_HASH.test(value);
}

/** `sha256` over raw body bytes, hex. The header is never hashed; only the bytes handed in. */
export function tgSecContentHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The evidence text normalizer, matching ARTEX `utf8Clean`'s contract: NUL bytes are dropped and any
 * ill-formed sequence collapses to U+FFFD. A JS string round-trips through UTF-8 so lone surrogates
 * become the replacement character, which is what `Buffer.from(text, "utf8")` writes to disk — the id,
 * the stored row, and every downstream reader then see the same bytes. Bodies are never normalized.
 */
export function normalizeEvidenceText(value: string): string {
	const decoded = Buffer.from(value, "utf8").toString("utf8");
	return decoded.split("\0").join("");
}

/** Every field in the id preimage, already normalized, so the id matches the bytes that land in storage. */
export function normalizeEvidenceFields(fields: TgSecEvidenceSnapshotFields): TgSecEvidenceSnapshotFields {
	assertHash("reqHash", fields.reqHash);
	assertHash("respHash", fields.respHash);
	assertUint32("status", fields.status);
	assertUint64("reqLen", fields.reqLen);
	assertUint64("respLen", fields.respLen);
	assertInt64("capturedAt", fields.capturedAt);
	return {
		sourceId: normalizeEvidenceText(fields.sourceId),
		capturedAt: fields.capturedAt,
		url: normalizeEvidenceText(fields.url),
		method: normalizeEvidenceText(fields.method),
		status: fields.status,
		contentType: normalizeEvidenceText(fields.contentType),
		reqHead: normalizeEvidenceText(fields.reqHead),
		respHead: normalizeEvidenceText(fields.respHead),
		reqHash: fields.reqHash,
		respHash: fields.respHash,
		reqLen: fields.reqLen,
		respLen: fields.respLen,
		flowId: normalizeEvidenceText(fields.flowId ?? ""),
	};
}

/**
 * The canonical preimage for a snapshot id — a fixed-order, length-delimited byte encoding, **not JSON**.
 * A domain tag binds every id to this schema, and every variable-length string carries a `uint32` byte
 * length so field content can never forge a boundary between two fields. Field order is part of the
 * encoding, so reordering changes the id; id and creation time are absent by construction.
 *
 * A flow-referenced capture (non-empty `flowId`) uses the `v2` tag and appends the flow id after the
 * body lengths. A capture without one uses `v1` and is byte-identical to a pre-flow snapshot, so
 * existing rows keep verifying: appending the empty field there would invalidate every stored id.
 */
export function encodeEvidenceSnapshotPreimage(fields: TgSecEvidenceSnapshotFields): Uint8Array {
	const flowId = fields.flowId ?? "";
	const chunks: Uint8Array[] = [flowId === "" ? TAG : FLOW_TAG];
	pushString(chunks, fields.sourceId);
	pushInt64(chunks, fields.capturedAt);
	pushString(chunks, fields.url);
	pushString(chunks, fields.method);
	pushUint32(chunks, fields.status);
	pushString(chunks, fields.contentType);
	pushString(chunks, fields.reqHead);
	pushString(chunks, fields.respHead);
	pushHash(chunks, fields.reqHash);
	pushHash(chunks, fields.respHash);
	pushUint64(chunks, fields.reqLen);
	pushUint64(chunks, fields.respLen);
	if (flowId !== "") pushString(chunks, flowId);
	return Buffer.concat(chunks);
}

/**
 * The snapshot id: `sha256` over {@link encodeEvidenceSnapshotPreimage}. The caller stores this id and
 * re-derives it to verify the row has not been tampered with, exactly as ARTEX checks at insert and
 * archive install. Input is normalized first so the id always describes the bytes that persist.
 */
export function snapshotMetadataId(fields: TgSecEvidenceSnapshotFields): string {
	return createHash("sha256")
		.update(encodeEvidenceSnapshotPreimage(normalizeEvidenceFields(fields)))
		.digest("hex");
}

const TAG = Buffer.from("tg.sec.evidence/v1\0", "utf8");
const FLOW_TAG = Buffer.from("tg.sec.evidence/v2\0", "utf8");

function pushString(chunks: Uint8Array[], value: string): void {
	const bytes = Buffer.from(value, "utf8");
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(bytes.length, 0);
	chunks.push(header, bytes);
}

function pushUint32(chunks: Uint8Array[], value: number): void {
	const buffer = Buffer.allocUnsafe(4);
	buffer.writeUInt32BE(value, 0);
	chunks.push(buffer);
}

function pushUint64(chunks: Uint8Array[], value: number): void {
	const buffer = Buffer.allocUnsafe(8);
	buffer.writeBigUInt64BE(BigInt(value), 0);
	chunks.push(buffer);
}

function pushInt64(chunks: Uint8Array[], value: number): void {
	const buffer = Buffer.allocUnsafe(8);
	buffer.writeBigInt64BE(BigInt(value), 0);
	chunks.push(buffer);
}

function pushHash(chunks: Uint8Array[], hash: string): void {
	chunks.push(Buffer.from(hash, "hex"));
}

function assertHash(field: string, value: string): void {
	if (!isEvidenceHash(value)) {
		throw new TypeError(`evidence ${field} must be 64 lowercase hex characters, got ${value.length} bytes`);
	}
}

function assertUint32(field: string, value: number): void {
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
		throw new TypeError(`evidence ${field} ${value} is not a uint32`);
	}
}

function assertUint64(field: string, value: number): void {
	if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
		throw new TypeError(`evidence ${field} ${value} is not a non-negative safe integer`);
	}
}

function assertInt64(field: string, value: number): void {
	if (!Number.isInteger(value) || value < -Number.MAX_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) {
		throw new TypeError(`evidence ${field} ${value} is not a safe integer`);
	}
}
