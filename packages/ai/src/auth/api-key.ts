import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credential lookup, keyed by the API key that was presented.
 *
 * Returning the provider id is what lets one authenticator serve several providers out of one key
 * space. Returning `undefined` means the key is unknown. Callers must not distinguish between
 * "unknown key" and "known key with a different shape" when reporting the failure.
 */
export type ApiKeyLookup = (key: string) => Promise<string | undefined> | string | undefined;

export type ApiKeyAuthErrorCode =
	/** No `Authorization` header, or one that is not a bearer token. */
	| "missing_credentials"
	/** The key is well-formed but does not match any stored credential. */
	| "invalid_key";

export type ApiKeyAuthResult =
	| { readonly ok: true; readonly providerId: string }
	| { readonly ok: false; readonly code: ApiKeyAuthErrorCode; readonly message: string };

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Extracts a bearer token from an `Authorization` header.
 *
 * The scheme name is matched case-insensitively, as RFC 7235 requires. Anything that is not a bearer
 * token is reported as missing rather than invalid: the request did not present a credential, so there
 * is nothing to compare.
 */
export function bearerToken(header: string | undefined): string | undefined {
	if (header === undefined) return undefined;
	const match = BEARER.exec(header.trim());
	return match?.[1];
}

/**
 * Hashes a key, so a caller can hold the result without holding the key itself.
 *
 * SHA-256 is deliberate. This is a keyed comparison helper, not a password hash: the presented key is
 * hashed exactly the way the stored credential was, then the two hashes are compared, so a database
 * leak does not leak usable keys.
 */
export function hashApiKey(key: string): string {
	return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Verifies a presented key against a stored credential in constant time.
 *
 * The presented key is hashed, then the two hashes are compared. Passing `stored` as a hash and
 * `presented` as the raw key is the expected call shape, which is what keeps a database leak from
 * leaking usable keys.
 */
export function verifyApiKey(presented: string, stored: string): boolean {
	return apiKeyMatches(hashApiKey(presented), stored);
}

/**
 * Compares two already-hashed values in constant time. Unequal lengths return false immediately,
 * because `timingSafeEqual` throws on unequal lengths and there is no timing channel worth protecting
 * in that case.
 */
export function apiKeyMatches(presented: string, stored: string): boolean {
	const left = Buffer.from(presented, "utf8");
	const right = Buffer.from(stored, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Generates a key with enough entropy to be unguessable. `prefix` is a human-readable label, not a
 * namespace: two keys with the same prefix are unrelated.
 */
export function generateApiKey(prefix = "tg"): string {
	return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

/** A request a handler can trust, plus the provider id it authenticated as. */
export type AuthenticatedRequest<TRequest> = { readonly request: TRequest; readonly providerId: string };

/**
 * Bearer-key authentication for a session service.
 *
 * `authenticate` receives a header record, so the same authenticator serves a fetch `Request`, a node
 * `IncomingMessage`, or a plain record of header names to values. Failure codes are deliberately
 * coarse: `missing_credentials` when no credential was presented, `invalid_key` otherwise, and
 * nothing in the result distinguishes one stored key from another.
 */
export class ApiKeyAuthenticator {
	private readonly lookup: ApiKeyLookup;

	constructor(lookup: ApiKeyLookup) {
		this.lookup = lookup;
	}

	/**
	 * Resolves the provider id a request's `Authorization` header authenticates as.
	 *
	 * Accepts a fetch `Request`, a node `IncomingMessage`, a `Headers` object, or a plain record of
	 * header names to values. Failure codes are deliberately coarse: `missing_credentials` when no
	 * credential was presented, `invalid_key` otherwise, and nothing in the result distinguishes one
	 * stored key from another.
	 */
	async authenticate(request: AuthenticatedHeaders): Promise<ApiKeyAuthResult> {
		const presented = bearerToken(readAuthorization(request));
		if (presented === undefined) {
			return {
				ok: false,
				code: "missing_credentials",
				message: "Missing bearer token in Authorization header",
			};
		}
		const providerId = await this.lookup(presented);
		if (providerId === undefined) {
			return { ok: false, code: "invalid_key", message: "Unknown API key" };
		}
		return { ok: true, providerId };
	}
}

/**
 * Anything a request's headers can be read from.
 *
 * Three shapes, all produced by real callers:
 *
 *  - `{ headers }` — a fetch `Request` (whose `headers` is a `Headers` with a case-insensitive `get()`)
 *    and a node `IncomingMessage` (whose `headers` is a plain record with lowercased keys and no
 *    `get()`). Mainstream Node frameworks hand you this, which is why the plain-record variant inside
 *    it is not optional.
 *  - a `Headers` object directly, matched through its own case-insensitive `get()`. It cannot be
 *    treated as a record: `Object.entries(new Headers())` is empty.
 *  - a plain record at the top level, for a service that has already normalised its headers.
 *
 * The record members are read through `Object.entries`, so a type without a string index signature —
 * node's own `IncomingMessage.headers` is one — still works: the lookup is by value, not by index.
 */
export type AuthenticatedHeaders =
	| { headers: { get(name: string): string | null | undefined } | object }
	| { get(name: string): string | null | undefined }
	| object;

/**
 * Reads `Authorization` from whatever shape the caller handed over.
 *
 * Header names are matched case-insensitively everywhere, because `Headers` is case-insensitive, node
 * lowercases them, and callers do not agree on the case they use.
 */
function readAuthorization(request: AuthenticatedHeaders): string | undefined {
	const withHeaders = request as {
		headers?: { get?(name: string): string | null | undefined } | object;
	};
	const headers = withHeaders.headers;
	if (headers !== undefined) {
		const withGet = headers as { get?(name: string): string | null | undefined };
		if (typeof withGet.get === "function") return toOptional(withGet.get("authorization"));
		return lookupHeader(headers, "authorization");
	}
	const withGet = request as { get?(name: string): string | null | undefined };
	if (typeof withGet.get === "function") return toOptional(withGet.get("authorization"));
	return lookupHeader(request, "authorization");
}

/** Reads one header name case-insensitively out of a plain record. */
function lookupHeader(record: object, name: string): string | undefined {
	for (const [key, value] of Object.entries(record)) {
		if (typeof value !== "string" && value !== undefined) continue;
		if (key.toLowerCase() === name) return toOptional(value);
	}
	return undefined;
}

function toOptional(value: string | null | undefined): string | undefined {
	return value === null || value === undefined ? undefined : value;
}
