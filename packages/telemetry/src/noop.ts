import { Context, Effect, Layer } from "effect";
import type { SpanOptions, TelemetryContext, TelemetrySpan } from "./index.ts";

/** Effect v4 Context key for a callback-compatible telemetry context. */
export const TelemetryContextTag = Context.Service<TelemetryContext>("telemetry/TelemetryContext");

function startNoopSpan<T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
	return Effect.runPromise(
		Effect.tryPromise<T, unknown>({
			try: async () => callback(noopTelemetrySpan),
			catch: (error) => error,
		}),
	);
}

const noopTelemetrySpan: TelemetrySpan = {
	startSpan: startNoopSpan,
	addEvent: () => {},
	setAttributes: () => {},
	setStatus: () => {},
};
Object.freeze(noopTelemetrySpan);

/** Shared telemetry context used when an application does not provide one. */
export const NOOP_TELEMETRY_CONTEXT: TelemetryContext = noopTelemetrySpan;

/** Effect v4 Layer exposing the NOOP context. */
export const NoopTelemetryLayer = Layer.succeed(TelemetryContextTag, NOOP_TELEMETRY_CONTEXT);
