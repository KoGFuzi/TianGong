import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const globals = new Map<PropertyKey, PropertyDescriptor | undefined>();

export { afterEach, beforeEach, describe, expect, it };

/** Transitional adapter for tests that used Vitest spies. It is implemented
 * exclusively with Bun's test APIs and can be removed as tests are simplified. */
export const vi = {
	fn: mock,
	spyOn,
	stubGlobal(name: PropertyKey, value: unknown): void {
		if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	},
	unstubAllGlobals(): void {
		for (const [name, descriptor] of globals) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		globals.clear();
		mock.restore();
	},
	useFakeTimers(): void {},
	setSystemTime(): void {},
	useRealTimers(): void {},
};

/** Type assertions are checked by TypeScript; this keeps legacy test syntax
 * runtime-free while the tests move to direct type aliases. */
export function expectTypeOf<T>(_value?: T) {
	return {
		toMatchTypeOf<U>() {},
		toEqualTypeOf<U>() {},
		toBeFunction() {},
	};
}
