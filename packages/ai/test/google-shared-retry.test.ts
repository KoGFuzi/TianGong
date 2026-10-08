import { afterEach, describe, expect, it, vi } from "vitest";
import { retryGoogleRequest } from "../src/api/google-shared.ts";

/** Shaped like @google/genai's ApiError: has `status`, but no `headers`. */
function googleApiError(status: number): Error {
	return Object.assign(new Error(`got status: ${status}`), { status });
}

describe("google request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a headers-less SDK error with a retryable status", async () => {
		vi.useFakeTimers();
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(googleApiError(429)).mockResolvedValue("ok");

		const result = retryGoogleRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(500);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("retries twice by default when maxRetries is unset", async () => {
		vi.useFakeTimers();
		// Reject each attempt with a distinct error and keep the final one, so the rejection the
		// test observes is the one the loop ends on rather than an unrelated early attempt.
		const errors = [googleApiError(429), googleApiError(429), googleApiError(429)];
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(errors[0])
			.mockRejectedValueOnce(errors[1])
			.mockRejectedValueOnce(errors[2]);

		const result = retryGoogleRequest(request).catch((error: unknown) => error);
		// The default budget is two retries, so three attempts in total.
		await vi.advanceTimersByTimeAsync(10_000);

		await expect(result).resolves.toBe(errors[2]);
		expect(request).toHaveBeenCalledTimes(3);
	});

	it("does not retry when maxRetries is 0", async () => {
		const error = googleApiError(429);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryGoogleRequest(request, { maxRetries: 0 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-retryable status", async () => {
		const error = googleApiError(400);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryGoogleRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
