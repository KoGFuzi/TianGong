import { Context, Layer } from "effect";
import type { TelemetryContext } from "./index.ts";
/** Effect v4 Context key for a callback-compatible telemetry context. */
export declare const TelemetryContextTag: Context.Service<TelemetryContext, TelemetryContext>;
/** Shared telemetry context used when an application does not provide one. */
export declare const NOOP_TELEMETRY_CONTEXT: TelemetryContext;
/** Effect v4 Layer exposing the NOOP context. */
export declare const NoopTelemetryLayer: Layer.Layer<TelemetryContext, never, never>;
