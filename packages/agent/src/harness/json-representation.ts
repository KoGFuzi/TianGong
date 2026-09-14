/**
 * TG-local substitute for the upstream chord `JsonRepresentation` marker
 * (chord types.ts). It maps an application data type onto its strict-JSON
 * representation; discriminant properties survive the mapping, which the
 * runtime reducer relies on.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Strict-JSON representation of an application data type. Unknown payloads become JsonValue. */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: T extends null | boolean | number | string
			? T
			: T extends readonly (infer TItem)[]
				? JsonRepresentation<TItem>[]
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<T[TKey]> }
					: never;
