import { describe, expect, it, vi } from "vitest";
import { parseStreamingJson, parseStreamingJsonThrottled, parseToolCallArguments } from "../src/utils/json-parse.ts";

describe("parseStreamingJson", () => {
	// #10868
	it("keeps invalid \\u escapes as literal text without dropping fields", () => {
		expect(parseStreamingJson(String.raw`{"text":"\url{x}"}`)).toEqual({ text: "\\url{x}" });
		expect(parseStreamingJson(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`)).toEqual({
			path: "a.tex",
			content: "\\usepackage{x}",
			mode: "w",
		});
	});

	it("decodes valid \\u escapes", () => {
		expect(parseStreamingJson(String.raw`{"text":"caf\u00e9 \url"}`)).toEqual({ text: "café \\url" });
	});

	it("omits a \\u escape that is cut off mid-stream", () => {
		expect(parseStreamingJson(String.raw`{"text":"ab\u00`)).toEqual({ text: "ab" });
	});
});

describe("parseStreamingJsonThrottled", () => {
	it("reuses the last parse until the interval elapses", () => {
		vi.useFakeTimers();
		try {
			const owner = {};
			expect(parseStreamingJsonThrottled(owner, '{"a":')).toEqual({});
			expect(parseStreamingJsonThrottled(owner, '{"a":1')).toEqual({});
			vi.advanceTimersByTime(50);
			expect(parseStreamingJsonThrottled(owner, '{"a":1}')).toEqual({ a: 1 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("parses a buffer that shrank without waiting for the interval", () => {
		vi.useFakeTimers();
		try {
			const owner = {};
			expect(parseStreamingJsonThrottled(owner, '{"a":1}')).toEqual({ a: 1 });
			expect(parseStreamingJsonThrottled(owner, '{"a":')).toEqual({});
		} finally {
			vi.useRealTimers();
		}
	});
});

// #10897
describe("parseToolCallArguments", () => {
	it("parses complete JSON and repairs invalid escapes", () => {
		expect(parseToolCallArguments(String.raw`{"kind":"seek","note":"\url"}`)).toEqual({
			arguments: { kind: "seek", note: "\\url" },
		});
	});

	it("uses empty arguments for empty text", () => {
		expect(parseToolCallArguments("")).toEqual({ arguments: {} });
	});

	it("does not keep the valid prefix of malformed JSON", () => {
		const raw = '{"action":"apply","actions":[{"kind":"seek","time":.5}]}';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError).toMatch(/\n\nReceived arguments:\n/);
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	it("does not complete cut-off JSON", () => {
		const raw = '{"kind":"seek","clipId":"clip-fl';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	it("rejects JSON that is not an object", () => {
		expect(parseToolCallArguments("[1,2]")).toEqual({
			arguments: {},
			argumentsError: "Tool arguments must be a JSON object\n\nReceived arguments:\n[1,2]",
		});
	});
});
