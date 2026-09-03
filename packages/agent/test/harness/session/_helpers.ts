import { Effect } from "effect";
import type { JsonlSessionMetadata, SessionMetadata, SessionRepo, SessionStorage } from "../../../src/harness/session/index.ts";

/** Wraps an Effect-based session repo to expose a Promise-based API. */
export function createPromiseRepo<T extends SessionMetadata>(repo: SessionRepo<T>): SessionRepo<T> {
	return new Proxy(repo as object, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const result = (value as (...a: unknown[]) => unknown).apply(target, args);
				if (Effect.isEffect(result)) {
					return Effect.runPromise(result as Effect.Effect<unknown, never, never>).then((resolved) => {
						if (prop === "create" || prop === "open" || prop === "fork") {
							return createPromiseSession(resolved);
						}
						return resolved;
					});
				}
				return result;
			};
		},
	}) as SessionRepo<T>;
}

/** Wraps an Effect-based session to expose a Promise-based API. */
export function createPromiseSession(session: unknown): unknown {
	return new Proxy(session as object, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const result = (value as (...a: unknown[]) => unknown).apply(target, args);
				if (Effect.isEffect(result)) {
					return Effect.runPromise(result as Effect.Effect<unknown, never, never>).then((resolved) => {
						if (prop === "view" && resolved && typeof resolved === "object") {
							return createPromiseSession(resolved);
						}
						return resolved;
					});
				}
				if (prop === "view" && result && typeof result === "object") {
					return createPromiseSession(result);
				}
				return result;
			};
		},
	});
}
