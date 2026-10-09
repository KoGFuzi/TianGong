import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	TG_SPAN_SCHEMA,
	type TypedSpanStarter,
} from "@OnePanda-TgSec/tg-telemetry";

/** One explicit parent context bound to the agent span vocabulary. */
export type AgentSpanStarter = TypedSpanStarter<readonly [typeof TG_SPAN_SCHEMA]>;

const TURN_STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted", "deferred"] as const;

/**
 * Map an assistant message's stop reason onto the closed set the turn span admits. `pending` is the
 * only value that does not survive: a turn span ends with the message that produced it.
 */
export function turnStopReason(value: string): (typeof TURN_STOP_REASONS)[number] | undefined {
	return TURN_STOP_REASONS.find((candidate) => candidate === value);
}

/**
 * Bind the agent vocabulary to `context`. Without a context the starter is bound to
 * {@link NOOP_TELEMETRY_CONTEXT}, so call sites never branch and nothing is recorded.
 */
export function agentSpanStarter(context: TelemetryContext | undefined): AgentSpanStarter {
	return createTypedSpanStarter(context ?? NOOP_TELEMETRY_CONTEXT, [TG_SPAN_SCHEMA]);
}

/**
 * Record one tool call as `tg.span.agent.tool`.
 *
 * The span opens before `run` and settles with it; `isError` classifies the outcome and drives the
 * span status. A thrown error settles the span as failed on its own.
 */
export async function traceToolCall<T>(
	starter: AgentSpanStarter,
	toolName: string,
	run: () => Promise<T>,
	isError: (outcome: T) => boolean,
): Promise<T> {
	return await starter("tg.span.agent.tool", { toolName }, async (span) => {
		const outcome = await run();
		const failed = isError(outcome);
		span.setAttributes({ isError: failed });
		if (failed) span.setStatus({ status: "error" });
		return outcome;
	});
}
