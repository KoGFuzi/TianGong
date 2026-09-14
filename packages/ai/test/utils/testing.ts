// Plain test conveniences over bun:test and standard JavaScript. This module
// replaces the former test-framework compatibility shim: every helper here is
// either a direct bun:test API or a few lines of ordinary async utility code.
//
// Timer note: useFakeTimers()/setSystemTime() freeze Date.now at activation
// (bun's jest.setSystemTime does not), which the OAuth and retry suites rely on.
// advanceTimersByTimeAsync() steps the mock clock millisecond by millisecond and
// flushes microtasks because bun only exposes synchronous advancement.

import {
	afterAll,
	expect as bunExpect,
	jest,
	mock,
} from "bun:test";
import { createRequire } from "node:module";

const globals = new Map<PropertyKey, unknown>();
const environment = new Map<string, string | undefined>();
const realDateNow = Date.now;
let fakeNow: number | undefined;

async function flushMicrotasks(): Promise<void> {
	// Bun 1.3 exposes only synchronous fake-timer advancement. Several OAuth
	// flows resume through more than two Promise continuations after a timer.
	for (let i = 0; i < 32; i++) await Promise.resolve();
}

export const advanceTimersByTimeAsync = async (ms: number): Promise<void> => {
	const advance = (
		jest as typeof jest & {
			advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
		}
	).advanceTimersByTimeAsync;
	if (advance) {
		if (fakeNow !== undefined) fakeNow += ms;
		await advance.call(jest, ms);
		return;
	}
	if (fakeNow !== undefined) fakeNow += ms;
	jest.advanceTimersByTime(ms);
	await flushMicrotasks();
};

export const useFakeTimers = (
	...args: Parameters<typeof jest.useFakeTimers>
): ReturnType<typeof jest.useFakeTimers> => {
	fakeNow = realDateNow();
	Date.now = () => fakeNow ?? realDateNow();
	return jest.useFakeTimers(...args);
};

export const useRealTimers = (): ReturnType<typeof jest.useRealTimers> => {
	fakeNow = undefined;
	Date.now = realDateNow;
	return jest.useRealTimers();
};

export const setSystemTime = (
	time: Parameters<typeof jest.setSystemTime>[0],
): void => {
	if (time === undefined)
		throw new TypeError("Fake timer system time must be provided");
	fakeNow = typeof time === "number" ? time : time.getTime();
	if (typeof jest.setSystemTime === "function") jest.setSystemTime(time);
};

export const stubGlobal = (key: PropertyKey, value: unknown): void => {
	if (!globals.has(key)) globals.set(key, Reflect.get(globalThis, key));
	Reflect.set(globalThis, key, value);
};

export const unstubAllGlobals = (): void => {
	for (const [key, value] of globals) Reflect.set(globalThis, key, value);
	globals.clear();
};

export const stubEnv = (key: string, value: string | undefined): void => {
	if (!environment.has(key)) environment.set(key, Bun.env[key]);
	if (value === undefined) delete Bun.env[key];
	else Bun.env[key] = value;
};

export const unstubAllEnvs = (): void => {
	for (const [key, value] of environment) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	environment.clear();
};

export const hoisted = <T>(factory: () => T): T => factory();

// Bun's module mocks are process-global: a `mock.module("openai", ...)` in one
// test file leaks into every subsequently loaded file that shares the same
// process (i.e. any run without `--isolate`), replacing the real SDK with the
// fake and breaking unrelated suites. Each mockModule() call registers an
// afterAll hook on the file that is currently loading; once that file finishes
// we re-mock the module with its genuine implementation (loaded through CJS
// `require`, which bypasses the ESM mock registry) to restore the real module
// for every later suite.
const nodeRequire = createRequire(import.meta.url);
let restoreHookRegistered = false;

const registerModuleMockRestore = (specifier: string): void => {
	restorableModuleMocks.add(specifier);
	if (restoreHookRegistered) return;
	restoreHookRegistered = true;
	afterAll(() => {
		for (const spec of restorableModuleMocks) {
			try {
				const real = nodeRequire(spec) as { default?: unknown };
				mock.module(spec, () => real);
			} catch {
				// The mocked specifier may not be resolvable via CJS (virtual or
				// ESM-only); leave the mock in place for those.
			}
		}
		restorableModuleMocks.clear();
		restoreHookRegistered = false;
	});
};

const restorableModuleMocks = new Set<string>();

export const mockModule = <T = unknown>(specifier: string, factory: () => T): void => {
	mock.module(specifier, factory);
	registerModuleMockRestore(specifier);
};

export const waitFor = async <T>(
	callback: () => T | Promise<T>,
	options?: { timeout?: number; interval?: number },
): Promise<T> => {
	const deadline = Date.now() + (options?.timeout ?? 1000);
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await callback();
		} catch (error) {
			lastError = error;
			await Bun.sleep(options?.interval ?? 10);
		}
	}
	throw lastError ?? new Error("waitFor timed out");
};

// Real time sources captured at module load, before any test can fake them:
// polling utilities must never participate in a fake clock.
const pollDateNow = Date.now.bind(Date);
const pollSetTimeout = setTimeout.bind(globalThis);

/** Polling matcher: re-evaluates the value until the chained matcher passes. */
export function poll(fn: () => unknown, options?: { interval?: number; timeout?: number }): any {
	const timeout = options?.timeout ?? 1_000;
	const interval = options?.interval ?? 20;
	return new Proxy({}, {
		get(_target, property) {
			return (...matcherArgs: unknown[]) => {
				const deadline = pollDateNow() + timeout;
				async function run(): Promise<void> {
					for (;;) {
						try {
							((bunExpect(fn()) as unknown) as Record<PropertyKey, (...a: unknown[]) => void>)[property](
								...matcherArgs,
							);
							return;
						} catch (error) {
							if (pollDateNow() > deadline) throw error;
							await new Promise((resolve) => pollSetTimeout(resolve, interval));
						}
					}
				}
				return run();
			};
		},
	});
}
