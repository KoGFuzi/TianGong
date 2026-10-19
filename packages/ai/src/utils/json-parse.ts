import { parse as partialParse } from "partial-json";
import type { ToolCall } from "../types.ts";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const UNICODE_ESCAPE_DIGITS_PATTERN = /^[0-9a-fA-F]{4}$/;

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	// Chunked, not `+=` per character: this runs over the whole accumulated tool-arguments buffer
	// on every streaming repair attempt, and string concatenation copies the prefix each time.
	const chunks: string[] = [];
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			chunks.push(char);
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			chunks.push(char);
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				chunks.push("\\\\");
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (UNICODE_ESCAPE_DIGITS_PATTERN.test(unicodeDigits)) {
					chunks.push(`\\u${unicodeDigits}`);
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				chunks.push(`\\${nextChar}`);
				index += 1;
				continue;
			}

			chunks.push("\\\\");
			continue;
		}

		chunks.push(isControlCharacter(char) ? escapeControlCharacter(char) : char);
	}

	return chunks.join("");
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Parses the model's complete arguments text of a finished tool call.
 *
 * Unlike {@link parseStreamingJson}, this never keeps a partially parsed prefix: once the call is
 * finished, text that is not a valid JSON object means the model sent malformed arguments. In that
 * case `arguments` is `{}` and `argumentsError` describes the problem, including the text the
 * model sent, so tool validation can report it back to the model.
 */
export function parseToolCallArguments(json: string | undefined): Pick<ToolCall, "arguments" | "argumentsError"> {
	if (!json?.trim()) return { arguments: {} };
	try {
		const parsed = parseJsonWithRepair<ToolCall["arguments"] | null>(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Tool arguments must be a JSON object");
		}
		return { arguments: parsed };
	} catch (error) {
		return {
			arguments: {},
			argumentsError: `${error instanceof Error ? error.message : String(error)}\n\nReceived arguments:\n${json}`,
		};
	}
}

/** Minimum interval between re-parses of one streaming tool call's accumulated JSON. */
const STREAMING_PARSE_INTERVAL_MS = 50;

interface StreamingParseState {
	at: number;
	length: number;
	value: unknown;
}

/** Parse progress per tool-call block; a weak key keeps the state alive exactly as long as the block. */
const streamingParseStates = new WeakMap<object, StreamingParseState>();

/**
 * Parses an accumulating tool-call arguments buffer for streaming previews, at most once per
 * {@link STREAMING_PARSE_INTERVAL_MS}. Every delta still reaches consumers; only the parsed object
 * updates at this cadence. The completed call is parsed in full by its adapter.
 *
 * `owner` is the block the buffer belongs to; its buffer only ever grows, so an unchanged length
 * means unchanged text.
 */
export function parseStreamingJsonThrottled<T = Record<string, unknown>>(owner: object, json: string): T {
	const state = streamingParseStates.get(owner);
	if (state !== undefined) {
		if (json.length === state.length) return state.value as T;
		if (json.length > state.length && Date.now() - state.at < STREAMING_PARSE_INTERVAL_MS) return state.value as T;
	}
	const value = parseStreamingJson<T>(json);
	streamingParseStates.set(owner, { at: Date.now(), length: json.length, value });
	return value;
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
