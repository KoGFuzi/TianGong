import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe as bunDescribe,
	expect,
	expectTypeOf,
	it as bunIt,
	mock,
	spyOn,
	jest,
} from "bun:test";

const globals = new Map<PropertyKey, unknown>();
const environment = new Map<string, string | undefined>();
const realDateNow = Date.now;
let fakeNow: number | undefined;

const advanceTimersByTimeAsync = async (ms: number): Promise<void> => {
	const advance = (jest as typeof jest & { advanceTimersByTimeAsync?: (ms: number) => Promise<void> })
		.advanceTimersByTimeAsync;
	if (advance) {
		if (fakeNow !== undefined) fakeNow += ms;
		await advance.call(jest, ms);
		return;
	}
	if (fakeNow !== undefined) fakeNow += ms;
	jest.advanceTimersByTime(ms);
	await Promise.resolve();
	await Promise.resolve();
};

const advanceTimersToNextTimerAsync = async (): Promise<void> => {
	const advance = (jest as typeof jest & { advanceTimersToNextTimerAsync?: () => Promise<void> })
		.advanceTimersToNextTimerAsync;
	if (advance) {
		await advance.call(jest);
		return;
	}
	jest.advanceTimersToNextTimer();
	await Promise.resolve();
	await Promise.resolve();
};

const useFakeTimers = (...args: Parameters<typeof jest.useFakeTimers>): ReturnType<typeof jest.useFakeTimers> => {
	fakeNow = realDateNow();
	Date.now = () => fakeNow ?? realDateNow();
	return jest.useFakeTimers(...args);
};

const useRealTimers = (): ReturnType<typeof jest.useRealTimers> => {
	fakeNow = undefined;
	Date.now = realDateNow;
	return jest.useRealTimers();
};

const setSystemTime = (time: Parameters<typeof jest.setSystemTime>[0]): void => {
	fakeNow = typeof time === "number" ? time : time.getTime();
	if (typeof jest.setSystemTime === "function") jest.setSystemTime(time);
};

const stubGlobal = (key: PropertyKey, value: unknown): void => {
	if (!globals.has(key)) globals.set(key, Reflect.get(globalThis, key));
	Reflect.set(globalThis, key, value);
};

const unstubAllGlobals = (): void => {
	for (const [key, value] of globals) Reflect.set(globalThis, key, value);
	globals.clear();
};

const stubEnv = (key: string, value: string | undefined): void => {
	if (!environment.has(key)) environment.set(key, Bun.env[key]);
	if (value === undefined) delete Bun.env[key];
	else Bun.env[key] = value;
};

const unstubAllEnvs = (): void => {
	for (const [key, value] of environment) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	environment.clear();
};

const hoisted = <T>(factory: () => T): T => factory();

const waitFor = async <T>(callback: () => T | Promise<T>, options?: { timeout?: number; interval?: number }): Promise<T> => {
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

export const vi = {
	...jest,
	useFakeTimers,
	useRealTimers,
	setSystemTime,
	fn: jest.fn,
	mock: mock.module,
	spyOn,
	hoisted,
	stubGlobal,
	unstubAllGlobals,
	stubEnv,
	unstubAllEnvs,
	advanceTimersByTimeAsync,
	advanceTimersToNextTimerAsync,
	waitFor,
};

export const describe: any = Object.assign(bunDescribe, {
	sequential: bunDescribe,
	skipIf: (condition: boolean) => (condition ? bunDescribe.skip : bunDescribe),
});

// Bun's declarations omit the Vitest-compatible options and table overloads used by this suite.
export const it: any = bunIt;

export { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, mock, spyOn };
