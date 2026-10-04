import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { ApiKeyAuthenticator, bearerToken, generateApiKey, hashApiKey, verifyApiKey } from "../src/auth/api-key.ts";

/** A header record that is not a fetch `Request` or `Headers`, to prove the record path works. */
function headers(record: Record<string, string>): Record<string, string> {
	return record;
}

describe("bearer token", () => {
	it("reads a bearer token and ignores other schemes", () => {
		expect(bearerToken("Bearer tg_abc")).toBe("tg_abc");
		expect(bearerToken("bearer tg_abc")).toBe("tg_abc");
		expect(bearerToken("Basic dXNlcjpwYXNz")).toBeUndefined();
		expect(bearerToken(undefined)).toBeUndefined();
		expect(bearerToken("")).toBeUndefined();
	});

	it("tolerates surrounding whitespace but not an empty credential", () => {
		expect(bearerToken("  Bearer   tg_abc  ")).toBe("tg_abc");
		expect(bearerToken("Bearer ")).toBeUndefined();
	});
});

describe("api key hashing", () => {
	it("verifies a presented key against its stored hash", () => {
		const key = generateApiKey();
		const stored = hashApiKey(key);
		expect(verifyApiKey(key, stored)).toBe(true);
		expect(verifyApiKey(generateApiKey(), stored)).toBe(false);
	});

	it("generates keys of a stable shape with the requested prefix", () => {
		const key = generateApiKey();
		expect(key).toMatch(/^tg_[A-Za-z0-9_-]{32}$/);
		expect(key).not.toBe(generateApiKey());
		expect(generateApiKey("custom")).toMatch(/^custom_/);
	});

	it("compares unequal-length inputs without throwing", () => {
		expect(verifyApiKey("short", hashApiKey("a much longer key"))).toBe(false);
	});
});

describe("ApiKeyAuthenticator", () => {
	it("authenticates a known key and reports the provider it belongs to", async () => {
		const key = generateApiKey();
		const authenticator = new ApiKeyAuthenticator((presented) =>
			verifyApiKey(presented, hashApiKey(key)) ? "openai" : undefined,
		);
		expect(await authenticator.authenticate(headers({ authorization: `Bearer ${key}` }))).toEqual({
			ok: true,
			providerId: "openai",
		});
	});

	it("rejects a missing credential and an unknown key with distinct codes", async () => {
		const key = generateApiKey();
		const authenticator = new ApiKeyAuthenticator(() => undefined);
		expect(await authenticator.authenticate(headers({}))).toMatchObject({
			ok: false,
			code: "missing_credentials",
		});
		expect(await authenticator.authenticate(headers({ authorization: "Basic x" }))).toMatchObject({
			ok: false,
			code: "missing_credentials",
		});
		expect(await authenticator.authenticate(headers({ authorization: `Bearer ${key}` }))).toMatchObject({
			ok: false,
			code: "invalid_key",
		});
	});

	it("works against a fetch Request", async () => {
		const key = generateApiKey();
		const authenticator = new ApiKeyAuthenticator((presented) =>
			verifyApiKey(presented, hashApiKey(key)) ? "anthropic" : undefined,
		);
		const request = new Request("https://example.invalid/session", { headers: { authorization: `Bearer ${key}` } });
		expect(await authenticator.authenticate(request)).toEqual({ ok: true, providerId: "anthropic" });
	});

	it("reads a node IncomingMessage, whose headers are a plain record with lowercased names", async () => {
		const key = generateApiKey();
		const authenticator = new ApiKeyAuthenticator((presented) =>
			verifyApiKey(presented, hashApiKey(key)) ? "groq" : undefined,
		);
		const message = { headers: { authorization: `Bearer ${key}` } };
		expect(await authenticator.authenticate(message)).toEqual({ ok: true, providerId: "groq" });
	});

	it("reads an Express/Fastify header record whose names are mixed case", async () => {
		// node:http lowercases header names, but a caller that has already copied them into its own
		// record does not have to. `Headers.get()` is case-insensitive, so the record path must be too.
		const key = generateApiKey();
		const authenticator = new ApiKeyAuthenticator((presented) =>
			verifyApiKey(presented, hashApiKey(key)) ? "groq" : undefined,
		);
		expect(await authenticator.authenticate({ headers: { Authorization: `Bearer ${key}` } })).toEqual({
			ok: true,
			providerId: "groq",
		});
	});

	it("reads a top-level header record, for a service that has already normalised its headers", async () => {
		const key = generateApiKey();
		const authenticator = new ApiKeyAuthenticator((presented) =>
			verifyApiKey(presented, hashApiKey(key)) ? "groq" : undefined,
		);
		expect(await authenticator.authenticate({ authorization: `Bearer ${key}` })).toEqual({
			ok: true,
			providerId: "groq",
		});
	});

	it("reads a Headers object built through its own constructor", async () => {
		const key = generateApiKey();
		const authenticator = new ApiKeyAuthenticator((presented) =>
			verifyApiKey(presented, hashApiKey(key)) ? "groq" : undefined,
		);
		expect(await authenticator.authenticate(new Headers({ authorization: `Bearer ${key}` }))).toEqual({
			ok: true,
			providerId: "groq",
		});
	});

	it("authenticates a request that arrived through node:http createServer", async () => {
		// End to end, against the shape `http.createServer` actually delivers. `IncomingMessage.headers`
		// is a plain record with lowercased names and no `get()`, and it is what Express, Fastify, and
		// every plain node service hand to a handler, so the record branch is load-bearing.
		const key = generateApiKey();
		const authenticator = new ApiKeyAuthenticator((presented) =>
			verifyApiKey(presented, hashApiKey(key)) ? "groq" : undefined,
		);

		const server = createServer((request, response) => {
			void authenticator.authenticate(request).then((result) => {
				response.writeHead(result.ok ? 200 : 401, { "content-type": "application/json" });
				response.end(JSON.stringify(result));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
		const url = `http://127.0.0.1:${address.port}`;

		try {
			const accepted = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
			expect(accepted.status).toBe(200);
			expect(await accepted.json()).toEqual({ ok: true, providerId: "groq" });

			const rejected = await fetch(url, { headers: { authorization: `Bearer ${generateApiKey()}` } });
			expect(rejected.status).toBe(401);
			expect(await rejected.json()).toMatchObject({ ok: false, code: "invalid_key" });
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("supports an async lookup without changing the failure surface", async () => {
		const key = generateApiKey();
		const stored = hashApiKey(key);
		const authenticator = new ApiKeyAuthenticator(async (presented) => {
			await Promise.resolve();
			return verifyApiKey(presented, stored) ? "groq" : undefined;
		});
		expect(
			await authenticator.authenticate(new Request("https://x", { headers: { authorization: `Bearer ${key}` } })),
		).toEqual({
			ok: true,
			providerId: "groq",
		});
	});
});

describe("background context", () => {
	it("is available for handlers that need it", () => {
		expect(BACKGROUND_CONTEXT).toBeDefined();
	});
});
