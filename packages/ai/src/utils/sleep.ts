import type { ProviderRetryClock } from "./provider-retry.ts";

const realClock: ProviderRetryClock = {
	now: () => Date.now(),
	setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
	clearTimeout: (timeout) => clearTimeout(timeout),
};

export function sleep(ms: number, signal: AbortSignal, clock: ProviderRetryClock = realClock): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const onAbort = () => {
			clock.clearTimeout(timeout);
			reject(signal.reason);
		};
		const timeout = clock.setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
