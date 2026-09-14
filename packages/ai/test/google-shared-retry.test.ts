import { describe, expect, mock, test as it } from "bun:test";
import { retryGoogleRequest } from "../src/api/google-shared.ts";
import type { ProviderRetryClock } from "../src/utils/provider-retry.ts";

class TestClock implements ProviderRetryClock {
	private currentTime = 0;
	private nextTimerId = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

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
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort(([, left], [, right]) => left.at - right.at)[0];
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

/** Shaped like @google/genai's ApiError: has `status`, but no `headers`. */
function googleApiError(status: number): Error {
	return Object.assign(new Error(`got status: ${status}`), { status });
}

describe("google request retries", () => {
	it("retries a headers-less SDK error with a retryable status", async () => {
		const clock = new TestClock();
		let calls = 0;
		const request = mock(async () => {
			calls++;
			if (calls === 1) throw googleApiError(429);
			return "ok";
		});

		const result = retryGoogleRequest(request, { maxRetries: 1, clock });
		for (let i = 0; i < 8; i++) await Promise.resolve();
		await clock.advance(500);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry when maxRetries is unset", async () => {
		const error = googleApiError(429);
		const request = mock(async () => {
			throw error;
		});

		await expect(retryGoogleRequest(request)).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-retryable status", async () => {
		const error = googleApiError(400);
		const request = mock(async () => {
			throw error;
		});

		await expect(retryGoogleRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
