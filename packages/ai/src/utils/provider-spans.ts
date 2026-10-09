import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	type TelemetrySchemaSpanEndAttributes,
	type TelemetrySchemaSpanStartAttributes,
	TG_SPAN_SCHEMA,
} from "@OnePanda-TgSec/tg-telemetry";
import type { AssistantMessage } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

/** Provider-facing model fields recorded when a request span starts. */
export interface ProviderSpanTarget {
	readonly provider: string;
	readonly api: string;
	readonly id: string;
}

/** Telemetry plumbing shared by every provider call. */
interface TelemetryOptions {
	readonly telemetryContext?: TelemetryContext;
	readonly onRetry?: () => void;
}

/** Token usage shape shared by chat messages, image responses, and classifier results. */
interface ProviderUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: { readonly total: number };
}

/** Result fields shared by image generation and classification responses. */
interface ProviderResult {
	readonly usage?: ProviderUsage;
	readonly stopReason: string;
	readonly errorMessage?: string;
}

type RequestStartAttributes = TelemetrySchemaSpanStartAttributes<typeof TG_SPAN_SCHEMA, "tg.span.provider.request">;
type RequestEndAttributes = TelemetrySchemaSpanEndAttributes<typeof TG_SPAN_SCHEMA, "tg.span.provider.request">;

const REQUEST_SPAN = "tg.span.provider.request";

function isTelemetryActive(context: TelemetryContext | undefined): context is TelemetryContext {
	return context !== undefined && context !== NOOP_TELEMETRY_CONTEXT;
}

function startAttributes(target: ProviderSpanTarget): RequestStartAttributes {
	return { provider: target.provider, api: target.api, model: target.id };
}

function toStopReason(value: string): RequestEndAttributes["stopReason"] {
	switch (value) {
		case "stop":
		case "length":
		case "toolUse":
		case "error":
		case "aborted":
		case "deferred":
			return value;
		default:
			return undefined;
	}
}

function usageAttributes(usage: ProviderUsage | undefined): RequestEndAttributes {
	if (usage === undefined) return {};
	return {
		"tokens.input": usage.input,
		"tokens.output": usage.output,
		"tokens.cacheRead": usage.cacheRead,
		"tokens.cacheWrite": usage.cacheWrite,
		"cost.total": usage.cost.total,
	};
}

function requestEndAttributes(message: AssistantMessage, retries: number): RequestEndAttributes {
	const errorName = diagnosticErrorName(message);
	const stopReason = toStopReason(message.stopReason);
	return {
		retried: retries > 0,
		...usageAttributes(message.usage),
		...(stopReason !== undefined ? { stopReason } : {}),
		...(errorName !== undefined ? { errorName } : {}),
	};
}

function resultEndAttributes(result: ProviderResult, retries: number): RequestEndAttributes {
	const stopReason = toStopReason(result.stopReason);
	return {
		retried: retries > 0,
		...usageAttributes(result.usage),
		...(stopReason !== undefined ? { stopReason } : {}),
	};
}

function diagnosticErrorName(message: AssistantMessage): string | undefined {
	for (const diagnostic of message.diagnostics ?? []) {
		const name = diagnostic.error?.name;
		if (name !== undefined && name !== "") return name;
	}
	return undefined;
}

function retryCounter(): { readonly onRetry: () => void; count: () => number } {
	let retries = 0;
	return {
		onRetry: () => {
			retries += 1;
		},
		count: () => retries,
	};
}

async function forwardRemaining(inner: AssistantMessageEventStream, outer: AssistantMessageEventStream): Promise<void> {
	for await (const event of inner) outer.push(event);
	outer.end(await inner.result());
}

/**
 * Wraps a streaming provider call in a `tg.span.provider.request` span.
 *
 * The adapter stream opens synchronously, so a thrown setup error still propagates
 * synchronously; the span covers the stream lifetime and receives its end attributes
 * when the stream settles. Without an active telemetry context the call is untouched.
 */
export function providerRequestStream<TModel extends ProviderSpanTarget, TOptions extends TelemetryOptions>(
	model: TModel,
	options: TOptions | undefined,
	open: (options: TOptions | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const telemetryContext = options?.telemetryContext;
	if (!isTelemetryActive(telemetryContext)) return open(options);
	const startSpan = createTypedSpanStarter(telemetryContext, [TG_SPAN_SCHEMA]);
	const counter = retryCounter();
	let inner: AssistantMessageEventStream;
	try {
		inner = open(options === undefined ? undefined : { ...options, onRetry: counter.onRetry });
	} catch (error) {
		// A setup throw stays synchronous; the failed attempt is still recorded.
		const errorName = error instanceof Error ? error.name : "ThrownValue";
		const errorMessage = error instanceof Error ? error.message : String(error);
		void startSpan(REQUEST_SPAN, startAttributes(model), (span) => {
			span.setStatus({ status: "error", error: { name: errorName, message: errorMessage } });
		});
		throw error;
	}
	const outer = new AssistantMessageEventStream();
	void startSpan(REQUEST_SPAN, startAttributes(model), async (span) => {
		for await (const event of inner) outer.push(event);
		const message = await inner.result();
		const errorName = diagnosticErrorName(message);
		span.setAttributes(requestEndAttributes(message, counter.count()));
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			span.setStatus({
				status: "error",
				error: { name: errorName ?? "Error", message: message.errorMessage ?? "" },
			});
		}
		outer.end(message);
	}).catch(() => {
		// A non-conforming telemetry backend must not break the request: forward the rest
		// of the stream untouched and close the outer stream.
		void forwardRemaining(inner, outer);
	});
	return outer;
}

/**
 * Wraps an awaited provider call (image generation, classification) in a
 * `tg.span.provider.request` span. Without an active telemetry context the call is untouched.
 */
export async function providerRequestResult<TResult extends ProviderResult, TOptions extends TelemetryOptions>(
	model: ProviderSpanTarget,
	options: TOptions | undefined,
	run: (options: TOptions | undefined) => Promise<TResult>,
): Promise<TResult> {
	const telemetryContext = options?.telemetryContext;
	if (!isTelemetryActive(telemetryContext)) return await run(options);
	const counter = retryCounter();
	const startSpan = createTypedSpanStarter(telemetryContext, [TG_SPAN_SCHEMA]);
	return await startSpan(REQUEST_SPAN, startAttributes(model), async (span) => {
		const result = await run(options === undefined ? undefined : { ...options, onRetry: counter.onRetry });
		span.setAttributes(resultEndAttributes(result, counter.count()));
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			span.setStatus({ status: "error", error: { name: "Error", message: result.errorMessage ?? "" } });
		}
		return result;
	});
}
