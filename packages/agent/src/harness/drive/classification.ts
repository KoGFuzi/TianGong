import type { AssistantMessage } from "@onepanda-tiangongsec/tg-ai";
import type { Control } from "../state/control.ts";

export type GenerationSettlement =
	| { readonly kind: "aborted"; readonly message: AssistantMessage }
	| { readonly kind: "overflow"; readonly message: AssistantMessage; readonly reason: "adapter" | "message" | "short_length" }
	| { readonly kind: "deferred"; readonly message: AssistantMessage; readonly handle: unknown }
	| { readonly kind: "tool_use"; readonly message: AssistantMessage }
	| { readonly kind: "completed"; readonly message: AssistantMessage }
	| { readonly kind: "retry"; readonly message: AssistantMessage; readonly errorMessage: string; readonly nextAttempt: number }
	| { readonly kind: "failed"; readonly message: AssistantMessage; readonly errorMessage: string };

export interface ClassificationInput {
	readonly control: Control;
	readonly message: AssistantMessage;
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly intendedOutputLimit: number;
	readonly contextWindow: number;
}

const CONTEXT_LIMIT_PATTERNS = [
	/context\s*(window|length)/i,
	/token\s*(limit|budget)/i,
	/maximum\s+context/i,
	/too\s+many\s+tokens/i,
];

export function classifyGeneration(input: ClassificationInput): GenerationSettlement {
	const { control, message } = input;
	if (control.status === "cancel_requested") return { kind: "aborted", message: normalize(message, "aborted") };

	const errorMessage = message.errorMessage ?? "";
	const usageInput = message.usage.input + message.usage.cacheRead;
	const adapterOverflow = message.stopReason === "error" && usageInput > input.contextWindow && message.usage.output === 0;
	const messageOverflow = message.stopReason === "error" && CONTEXT_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
	const shortLength = message.stopReason === "length" && message.usage.output < input.intendedOutputLimit;
	if (adapterOverflow || messageOverflow || shortLength) {
		return { kind: "overflow", message: normalize(message, "error"), reason: adapterOverflow ? "adapter" : messageOverflow ? "message" : "short_length" };
	}

	if (message.stopReason === "deferred" && message.deferred) return { kind: "deferred", message, handle: message.deferred };
	if (message.stopReason === "toolUse" || message.content.some((block) => block.type === "toolCall")) {
		return { kind: "tool_use", message };
	}
	if (message.stopReason === "error") {
		if (input.attempt < input.maxAttempts) {
			return { kind: "retry", message, errorMessage: errorMessage || "Provider request failed", nextAttempt: input.attempt + 1 };
		}
		return { kind: "failed", message, errorMessage: errorMessage || "Provider request failed" };
	}
	return { kind: "completed", message };
}

function normalize(message: AssistantMessage, stopReason: "error" | "aborted"): AssistantMessage {
	return { ...message, stopReason, ...(stopReason === "error" ? { errorMessage: message.errorMessage ?? "Context limit exceeded" } : {}) };
}
