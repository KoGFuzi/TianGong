import { afterEach, describe, expect, it } from "bun:test";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";
import type { ProviderRetryClock } from "../src/utils/provider-retry.ts";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_HOST = "https://auth.kimi.com";

/** Deterministic clock: timers fire only when the test advances them. */
class TestClock implements ProviderRetryClock {
	private currentTime: number;
	private nextTimerId = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	constructor(now = 0) {
		this.currentTime = now;
	}

	now(): number {
		return this.currentTime;
	}

	setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
		const id = this.nextTimerId++;
		this.timers.set(id, { at: this.currentTime + milliseconds, callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimeout(timeout: ReturnType<typeof setTimeout>): void {
		this.timers.delete(timeout as unknown as number);
	}

	async advance(milliseconds: number): Promise<void> {
		const target = this.currentTime + milliseconds;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort(([, left], [, right]) => left.at - right.at)[0];
			if (!due) break;
			this.currentTime = due[1].at;
			this.timers.delete(due[0]);
			due[1].callback();
			await flushMicrotasks();
		}
		this.currentTime = target;
		await flushMicrotasks();
	}
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 32; i++) await Promise.resolve();
}

const realDateNow = Date.now;
const realFetch = globalThis.fetch;
const realOauthHostEnv = process.env.KIMI_CODE_OAUTH_HOST;
let clock: TestClock;

afterEach(() => {
	Date.now = realDateNow;
	globalThis.fetch = realFetch;
	if (realOauthHostEnv === undefined) delete process.env.KIMI_CODE_OAUTH_HOST;
	else process.env.KIMI_CODE_OAUTH_HOST = realOauthHostEnv;
});

/** Freeze Date.now onto the test clock so expires timestamps stay deterministic. */
function useClock(now?: number): TestClock {
	clock = new TestClock(now);
	Date.now = () => clock.now();
	return clock;
}

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function deviceAuthorizationResponse(overrides?: Record<string, unknown>): Response {
	return jsonResponse({
		user_code: "ABCD-1234",
		device_code: "device-code-123",
		verification_uri: "https://www.kimi.com/code",
		verification_uri_complete: "https://www.kimi.com/code?user_code=ABCD-1234",
		interval: 5,
		expires_in: 600,
		...overrides,
	});
}

function createInteraction(events: Array<Record<string, unknown>>): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		prompt: async () => {
			throw new Error("Kimi Code login should not prompt");
		},
		notify: (event) => events.push(event as unknown as Record<string, unknown>),
	};
}

describe("Kimi Code OAuth", () => {
	it("logs in with the device authorization flow", async () => {
		const startTime = new Date("2026-07-20T00:00:00Z").getTime();
		const testClock = useClock(startTime);

		const events: Array<Record<string, unknown>> = [];
		const pollResponses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
		];
		const pollTimes: number[] = [];

		globalThis.fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === `${OAUTH_HOST}/api/oauth/device_authorization`) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				});
				expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe(CLIENT_ID);
				return deviceAuthorizationResponse();
			}
			if (url === `${OAUTH_HOST}/api/oauth/token`) {
				pollTimes.push(Date.now());
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(params.get("client_id")).toBe(CLIENT_ID);
				expect(params.get("device_code")).toBe("device-code-123");
				const response = pollResponses.shift();
				if (!response) throw new Error("Unexpected extra token poll");
				return response;
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		};

		const credentialPromise = kimiCodingOAuth.login(createInteraction(events), { clock: testClock });
		await flushMicrotasks();
		expect(events).toEqual([
			{
				type: "device_code",
				userCode: "ABCD-1234",
				verificationUri: "https://www.kimi.com/code?user_code=ABCD-1234",
				intervalSeconds: 5,
				expiresInSeconds: 600,
			},
		]);

		// waitBeforeFirstPoll: first poll happens after the 5s interval.
		await testClock.advance(4999);
		expect(pollTimes).toEqual([]);
		await testClock.advance(1);
		expect(pollTimes).toEqual([startTime + 5000]);

		await testClock.advance(5000);
		await expect(credentialPromise).resolves.toEqual({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime + 10000 + 3600 * 1000,
		});
		expect(pollTimes).toEqual([startTime + 5000, startTime + 10000]);
	});

	it("fails when the device code expires", async () => {
		const testClock = useClock();
		globalThis.fetch = async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === `${OAUTH_HOST}/api/oauth/device_authorization`) {
				return deviceAuthorizationResponse();
			}
			if (url === `${OAUTH_HOST}/api/oauth/token`) {
				return jsonResponse({ error: "expired_token" }, 400);
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		};

		const credentialPromise = kimiCodingOAuth.login(createInteraction([]), { clock: testClock });
		await flushMicrotasks();
		await testClock.advance(5000);
		await expect(credentialPromise).rejects.toThrow("expired");
	});

	it("fails when the user denies the login", async () => {
		const testClock = useClock();
		globalThis.fetch = async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === `${OAUTH_HOST}/api/oauth/device_authorization`) {
				return deviceAuthorizationResponse();
			}
			if (url === `${OAUTH_HOST}/api/oauth/token`) {
				return jsonResponse({ error: "access_denied" }, 400);
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		};

		const credentialPromise = kimiCodingOAuth.login(createInteraction([]), { clock: testClock });
		await flushMicrotasks();
		await testClock.advance(5000);
		await expect(credentialPromise).rejects.toThrow("denied");
	});

	it("honors the KIMI_CODE_OAUTH_HOST override", async () => {
		process.env.KIMI_CODE_OAUTH_HOST = "https://auth.example.com/";
		const testClock = useClock();

		const urls: string[] = [];
		globalThis.fetch = async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			urls.push(url);
			if (url === "https://auth.example.com/api/oauth/device_authorization") {
				return deviceAuthorizationResponse({ interval: 1 });
			}
			if (url === "https://auth.example.com/api/oauth/token") {
				return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 60 });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		};

		const credentialPromise = kimiCodingOAuth.login(createInteraction([]), { clock: testClock });
		await flushMicrotasks();
		await testClock.advance(1000);
		await expect(credentialPromise).resolves.toMatchObject({ access: "a", refresh: "r" });
		expect(urls).toEqual([
			"https://auth.example.com/api/oauth/device_authorization",
			"https://auth.example.com/api/oauth/token",
		]);
	});

	it("refreshes tokens and returns a Bearer header for requests", async () => {
		globalThis.fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			expect(url).toBe(`${OAUTH_HOST}/api/oauth/token`);
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("old-refresh");
			expect(params.get("client_id")).toBe(CLIENT_ID);
			return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
		};

		const before = Date.now();
		const credential = await kimiCodingOAuth.refresh(
			{
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: before,
			},
			new AbortController().signal,
		);
		expect(credential).toEqual({
			type: "oauth",
			access: "new-access",
			refresh: "new-refresh",
			expires: expect.any(Number),
		});
		expect(credential.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);

		await expect(kimiCodingOAuth.toAuth(credential)).resolves.toEqual({
			headers: { Authorization: "Bearer new-access" },
		});
	});

	it("retries refresh on 429 and fails unauthorized on invalid_grant", async () => {
		const testClock = useClock();

		// 429 once, then success.
		let calls = 0;
		globalThis.fetch = async (): Promise<Response> => {
			calls += 1;
			if (calls === 1) return jsonResponse({ error: "temporarily_unavailable" }, 429);
			return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 60 });
		};

		const refreshPromise = kimiCodingOAuth.refresh(
			{
				type: "oauth",
				access: "old",
				refresh: "old",
				expires: 0,
			},
			new AbortController().signal,
			{ clock: testClock },
		);
		await flushMicrotasks();
		await testClock.advance(1000);
		await expect(refreshPromise).resolves.toMatchObject({ access: "a" });
		expect(calls).toBe(2);

		// invalid_grant is not retried.
		globalThis.fetch = async (): Promise<Response> => jsonResponse({ error: "invalid_grant" }, 400);
		await expect(
			kimiCodingOAuth.refresh(
				{ type: "oauth", access: "old", refresh: "old", expires: 0 },
				new AbortController().signal,
				{ clock: testClock },
			),
		).rejects.toThrow("unauthorized");
		expect(calls).toBe(2);
	});
});
