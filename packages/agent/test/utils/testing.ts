// Plain test conveniences over bun:test and standard JavaScript. This module
// replaces the former test-framework compatibility shim: every helper here is
// either a direct bun:test API or a few lines of ordinary async utility code.
//
// Matcher note: bun's toMatchObject does not support asymmetric markers
// (expect.any/objectContaining/...) nested inside plain object literals.
// Keep markers at the top level, or assert the nested value separately.

import { expect as bunExpect, jest } from "bun:test";

// Real time sources captured at module load, before any test can spy on them:
// polling utilities must never participate in a fake clock (and bun's mock
// clock misbehaves when real timers fire while fake timers are pending).
const realDateNow = Date.now.bind(Date);
const realSetTimeout = setTimeout.bind(globalThis);

const globals = new Map<PropertyKey, PropertyDescriptor | undefined>();

/** Replace a global value for the current test and restore it with unstubAllGlobals(). */
export function stubGlobal(name: PropertyKey, value: unknown): void {
	if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

/** Restore every global replaced by stubGlobal() since the last unstub. */
export function unstubAllGlobals(): void {
	for (const [name, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	globals.clear();
}

/** Polling matcher: re-evaluates the value until the chained matcher passes. */
export function poll(fn: () => unknown, options?: { interval?: number; timeout?: number }): any {
	const timeout = options?.timeout ?? 1_000;
	const interval = options?.interval ?? 20;
	return new Proxy({}, {
		get(_target, property) {
			return (...matcherArgs: unknown[]) => {
				const deadline = realDateNow() + timeout;
				async function run(): Promise<void> {
					for (;;) {
						try {
							((bunExpect(fn()) as unknown) as Record<PropertyKey, (...a: unknown[]) => void>)[property](
								...matcherArgs,
							);
							return;
						} catch (error) {
							if (realDateNow() > deadline) throw error;
							await new Promise((resolve) => realSetTimeout(resolve, interval));
						}
					}
				}
				return run();
			};
		},
	});
}

/** Poll fn() in real time until it stops throwing (or returns false). */
export async function waitFor(fn: () => unknown, options?: { interval?: number; timeout?: number }): Promise<void> {
	const timeout = options?.timeout ?? 1_000;
	const interval = options?.interval ?? 20;
	const deadline = realDateNow() + timeout;
	for (;;) {
		try {
			const value = fn();
			if (value !== false) return;
		} catch {}
		if (realDateNow() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => realSetTimeout(resolve, interval));
	}
}

/** Advance bun's mock clock one millisecond at a time, flushing microtasks so
 * timers scheduled during the window still fire. */
export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed++) {
		jest.advanceTimersByTime(1);
		if (elapsed % 16 === 0) for (let i = 0; i < 8; i++) await Promise.resolve();
	}
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Type assertions are checked by TypeScript; this keeps legacy test syntax
 * runtime-free while the tests move to direct type aliases. */
/** Chainable no-op type: expectTypeOf assertions carry no runtime behavior. */
export interface ExpectTypeOf<T> {
	toMatchTypeOf<U = unknown>(): ExpectTypeOf<T>;
	toEqualTypeOf<U = unknown>(): ExpectTypeOf<T>;
	toBeFunction(): ExpectTypeOf<T>;
	returns: ExpectTypeOf<T>;
	parameters: ExpectTypeOf<T>;
	not: ExpectTypeOf<T>;
	value: T;
}
export function expectTypeOf<T>(_value?: T): ExpectTypeOf<T> {
	// Proxy over a function so chained property lookups stay callable.
	return new Proxy((() => {}) as unknown as ExpectTypeOf<T> & (() => void), {
		get: () => expectTypeOf<T>(),
		apply: () => expectTypeOf<T>(),
	});
}
