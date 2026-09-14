import { afterEach, describe, expect, it, mock } from "bun:test";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import type { ProviderRetryClock } from "../src/utils/provider-retry.ts";

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
let clock: TestClock;

afterEach(() => {
	Date.now = realDateNow;
	globalThis.fetch = realFetch;
});

/** Freeze Date.now onto the test clock so expires timestamps stay deterministic. */
function useClock(now?: number): TestClock {
	clock = new TestClock(now);
	Date.now = () => clock.now();
	return clock;
}

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported request input: ${String(input)}`);
}

function requestForm(init: RequestInit | undefined): URLSearchParams {
	return new URLSearchParams(String(init?.body));
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		device_code: "device-code",
		user_code: "ABCD-1234",
		verification_uri: "https://accounts.x.ai/oauth2/device",
		expires_in: 900,
		interval: 5,
		...overrides,
	};
}

function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		access_token: "access-token",
		refresh_token: "refresh-token",
		expires_in: 21_600,
		token_type: "Bearer",
		...overrides,
	};
}

type DeviceCodeInfo = {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
};

function loginXaiForTest(options: {
	onDeviceCode: (info: DeviceCodeInfo) => void;
	signal?: AbortSignal;
	clock?: ProviderRetryClock;
}): Promise<OAuthCredential> {
	return xaiOAuth.login({
		signal: options.signal ?? neverAbortedSignal,
		prompt: () => {
			throw new Error("Unexpected prompt");
		},
		notify: (event) => {
			if (event.type === "device_code") {
				const { type: _, ...info } = event;
				options.onDeviceCode(info as unknown as DeviceCodeInfo);
			}
		},
	}, options.clock !== undefined ? { clock: options.clock } : undefined);
}

function refreshXaiForTest(refreshToken: string): Promise<OAuthCredential> {
	return xaiOAuth.refresh(
		{ type: "oauth", access: "old-access", refresh: refreshToken, expires: 0 },
		neverAbortedSignal,
	);
}

describe("xAI OAuth device flow", () => {
	it("uses the device grant, delays polling, and handles pending and slow_down", async () => {
		const startTime = new Date("2026-07-09T20:00:00Z").getTime();
		const testClock = useClock(startTime);
		const pollTimes: number[] = [];
		const tokenReplies = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ error: "slow_down", interval: 10 }, 400),
			jsonResponse(tokenResponse()),
		];

		globalThis.fetch = async (input: unknown, init?: RequestInit) => {
			const url = requestUrl(input);

			if (url === "https://auth.x.ai/oauth2/device/code") {
				const form = requestForm(init);
				expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(form.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access");
				expect(form.get("referrer")).toBe("pi");
				return jsonResponse(deviceCodeResponse());
			}

			if (url === "https://auth.x.ai/oauth2/token") {
				pollTimes.push(Date.now());
				const form = requestForm(init);
				expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(form.get("device_code")).toBe("device-code");
				const reply = tokenReplies.shift();
				if (!reply) throw new Error("Unexpected token poll");
				return reply;
			}

			throw new Error(`Unexpected request: ${url}`);
		};

		const deviceCodes: DeviceCodeInfo[] = [];
		const loginPromise = loginXaiForTest({ onDeviceCode: (info) => deviceCodes.push(info), clock: testClock });

		await flushMicrotasks();
		expect(deviceCodes).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://accounts.x.ai/oauth2/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(pollTimes).toEqual([]);

		await testClock.advance(5000);
		expect(pollTimes).toEqual([startTime + 5000]);

		// slow_down raised the interval to 10 seconds
		await testClock.advance(5000);
		expect(pollTimes).toEqual([startTime + 5000, startTime + 10_000]);

		await testClock.advance(10_000);
		const credentials = await loginPromise;
		expect(pollTimes).toEqual([
			startTime + 5000,
			startTime + 10_000,
			startTime + 20_000,
		]);
		expect(credentials).toEqual({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime + 20_000 + 21_600_000 - 300_000,
		});
	});

	it("falls back to the default poll interval when the response reports interval 0", async () => {
		const startTime = new Date("2026-07-09T20:00:00Z").getTime();
		const testClock = useClock(startTime);
		const pollTimes: number[] = [];
		globalThis.fetch = async (input: unknown) => {
			if (requestUrl(input) === "https://auth.x.ai/oauth2/device/code") {
				return jsonResponse(deviceCodeResponse({ interval: 0 }));
			}
			pollTimes.push(Date.now());
			return jsonResponse(tokenResponse());
		};

		const loginPromise = loginXaiForTest({ onDeviceCode: () => {}, clock: testClock });
		await flushMicrotasks();
		// RFC 8628 default interval is 5 seconds when the server does not require a wait.
		await testClock.advance(5000);
		await loginPromise;
		expect(pollTimes).toEqual([startTime + 5000]);
	});

	it("prefers verification_uri_complete when the server provides it", async () => {
		const testClock = useClock();
		globalThis.fetch = async (input: unknown) => {
			if (requestUrl(input) === "https://auth.x.ai/oauth2/device/code") {
				return jsonResponse(
					deviceCodeResponse({
						verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
					}),
				);
			}
			return jsonResponse(tokenResponse());
		};

		const deviceCodes: DeviceCodeInfo[] = [];
		const loginPromise = loginXaiForTest({ onDeviceCode: (info) => deviceCodes.push(info), clock: testClock });
		await flushMicrotasks();
		await testClock.advance(5000);
		await loginPromise;
		expect(deviceCodes).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
	});

	it("rejects a non-https verification_uri_complete", async () => {
		globalThis.fetch = async () =>
			jsonResponse(
				deviceCodeResponse({
					verification_uri_complete: "http://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
				}),
			);

		await expect(loginXaiForTest({ onDeviceCode: () => {} })).rejects.toThrow("Untrusted verification URI");
	});

	it.each(["http://accounts.x.ai/oauth2/device", "file:///etc/passwd", "not a url"])(
		"rejects a non-https verification URI: %s",
		async (verificationUri) => {
			globalThis.fetch = async () => jsonResponse(deviceCodeResponse({ verification_uri: verificationUri }));

			await expect(loginXaiForTest({ onDeviceCode: () => {} })).rejects.toThrow("Untrusted verification URI");
		},
	);

	it.each(["access_denied", "authorization_denied"])(
		"fails when device authorization is denied: %s",
		async (error) => {
			const testClock = useClock();
			let requestCount = 0;
			globalThis.fetch = async () => {
				requestCount += 1;
				return requestCount === 1
					? jsonResponse(deviceCodeResponse({ interval: 1 }))
					: jsonResponse({ error }, 400);
			};

			const loginPromise = loginXaiForTest({ onDeviceCode: () => {}, clock: testClock });
			await flushMicrotasks();
			await testClock.advance(1000);
			await expect(loginPromise).rejects.toThrow("xAI device authorization was denied");
		},
	);

	it("cancels while waiting for the first token poll", async () => {
		const controller = new AbortController();
		const fetchMock = mock(async () => jsonResponse(deviceCodeResponse()));
		globalThis.fetch = fetchMock;

		const loginPromise = loginXaiForTest({
			onDeviceCode: () => controller.abort(),
			signal: controller.signal,
		});

		await expect(loginPromise).rejects.toThrow("Login cancelled");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refreshes tokens and preserves an unrotated refresh token", async () => {
		let requestCount = 0;
		globalThis.fetch = async (input: unknown, init?: RequestInit) => {
			expect(requestUrl(input)).toBe("https://auth.x.ai/oauth2/token");
			const form = requestForm(init);
			expect(form.get("grant_type")).toBe("refresh_token");
			expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
			requestCount += 1;
			if (requestCount === 1) {
				expect(form.get("refresh_token")).toBe("old-refresh");
				return jsonResponse(tokenResponse({ access_token: "new-access", refresh_token: "new-refresh" }));
			}
			expect(form.get("refresh_token")).toBe("keep-refresh");
			return jsonResponse(tokenResponse({ access_token: "newer-access", refresh_token: undefined }));
		};

		const rotated = await refreshXaiForTest("old-refresh");
		const preserved = await refreshXaiForTest("keep-refresh");
		expect(rotated.type).toBe("oauth");
		expect(rotated.refresh).toBe("new-refresh");
		expect(rotated.access).toBe("new-access");
		expect(preserved.refresh).toBe("keep-refresh");
		expect(preserved.access).toBe("newer-access");
		expect(xaiOAuth.name).toBe("xAI (Grok/X subscription)");
		await expect(xaiOAuth.toAuth(preserved)).resolves.toEqual({ apiKey: "newer-access" });
	});

	it("assumes a one-hour lifetime when expires_in is missing", async () => {
		const startTime = new Date("2026-07-09T20:00:00Z").getTime();
		useClock(startTime);
		globalThis.fetch = async () => jsonResponse(tokenResponse({ expires_in: undefined }));

		const credentials = await refreshXaiForTest("old-refresh");
		expect(credentials.expires).toBe(startTime + 3_600_000 - 300_000);
	});

	it("rejects token responses with missing fields", async () => {
		globalThis.fetch = async () => jsonResponse(tokenResponse({ access_token: undefined }));

		await expect(refreshXaiForTest("old-refresh")).rejects.toThrow("Invalid xAI OAuth response field: access_token");
	});

	it("surfaces the upstream error code and description on refresh failure", async () => {
		globalThis.fetch = async () => jsonResponse({ error: "invalid_grant", error_description: "refresh token revoked" }, 400);

		await expect(refreshXaiForTest("old-refresh")).rejects.toThrow(
			"xAI OAuth token refresh failed (HTTP 400): invalid_grant: refresh token revoked",
		);
	});
});
