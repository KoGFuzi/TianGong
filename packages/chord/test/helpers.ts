import { mock } from "bun:test";

export { createLoopbackServiceTransport } from "../src/services/loopback.ts";

export async function waitFor(
	predicate: () => void | Promise<void>,
	options: { readonly timeout?: number; readonly interval?: number } = {},
): Promise<void> {
	const { timeout = 1000, interval = 10 } = options;
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await predicate();
			return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
	throw lastError ?? new Error("waitFor timed out");
}

export function fn<TArgs extends unknown[], TReturn>(
	impl: (...args: TArgs) => TReturn,
): ReturnType<typeof mock<(...args: TArgs) => TReturn>> {
	return mock(impl);
}
