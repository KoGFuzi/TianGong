import { describe, expect, it, mock } from "bun:test";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import type { ProviderRetryClock } from "../src/utils/provider-retry.ts";

class TestClock implements ProviderRetryClock {
	private currentTime = 0;
	private nextTimerId = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	get pendingCount(): number {
		return this.timers.size;
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
			for (let i = 0; i < 8; i++) await Promise.resolve();
		}
		this.currentTime = target;
		for (let i = 0; i < 8; i++) await Promise.resolve();
	}
}

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	it("retries retryable provider errors", async () => {
		const clock = new TestClock();
		let calls = 0;
		const request = mock(async () => {
			calls += 1;
			if (calls === 1) throw providerError(429, { "retry-after-ms": "1000" });
			return "ok";
		});

		const result = retryProviderRequest(request, { maxRetries: 1, clock });
		for (let i = 0; i < 8; i++) await Promise.resolve();
		await clock.advance(999);
		expect(request).toHaveBeenCalledTimes(1);
		await clock.advance(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = mock(async () => {
			throw error;
		});

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = mock(async () => {
			throw providerError(429, { "retry-after": "277403" });
		});

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		const clock = new TestClock();
		let calls = 0;
		const request = mock(async () => {
			calls += 1;
			if (calls === 1) throw providerError(429, { "retry-after": "2" });
			return "ok";
		});

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0, clock });
		for (let i = 0; i < 8; i++) await Promise.resolve();
		await clock.advance(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await clock.advance(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		const clock = new TestClock();
		const controller = new AbortController();
		const request = mock(async () => {
			throw providerError(429, { "retry-after": "277403" });
		});

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal, clock });
		for (let i = 0; i < 8; i++) await Promise.resolve();
		await clock.advance(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(clock.pendingCount).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(clock.pendingCount).toBe(0);
	});
});
