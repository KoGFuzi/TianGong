import { Effect } from "effect";
import { AbortedError } from "./retry.ts";
/**
 * Create an operation-local signal for public APIs whose signal is optional.
 * Works with both Effect and Promise-based APIs.
 */
export declare function operationSignal(signal?: AbortSignal): AbortSignal;
/**
 * Effect version: Race an Effect with an AbortSignal.
 * The operation will be interrupted if the signal aborts.
 */
export declare function raceWithAbortSignal<T, E>(operation: Effect.Effect<T, E>, signal: AbortSignal): Effect.Effect<T, E | AbortedError>;
