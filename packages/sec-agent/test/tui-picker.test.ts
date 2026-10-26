import { describe, expect, it } from "vitest";
import { filterPickerItems, movePickerIndex } from "../src/tui/picker.ts";

const specs = ["openai/gpt-5", "anthropic/claude", "faux/faux-1", "openrouter/vendor/model", "groq/llama"];
const items = specs.map((spec) => ({ spec }));
const text = (item: { spec: string }) => item.spec;

describe("filterPickerItems", () => {
	it("keeps the original order for an empty query", () => {
		expect(filterPickerItems(items, "", text).map(text)).toEqual(specs);
	});

	it("fuzzy-matches and orders the best matches first", () => {
		expect(filterPickerItems(items, "op", text).map(text)).toEqual([
			"openai/gpt-5",
			"openrouter/vendor/model",
			"anthropic/claude",
		]);
	});

	it("returns nothing when the query cannot match", () => {
		expect(filterPickerItems(items, "zzz", text)).toEqual([]);
	});
});

describe("movePickerIndex", () => {
	it("moves within the list", () => {
		expect(movePickerIndex(0, 3, 1)).toBe(1);
		expect(movePickerIndex(2, 3, -1)).toBe(1);
	});

	it("wraps in both directions", () => {
		expect(movePickerIndex(2, 3, 1)).toBe(0);
		expect(movePickerIndex(0, 3, -1)).toBe(2);
	});

	it("stays at zero for an empty list", () => {
		expect(movePickerIndex(0, 0, 1)).toBe(0);
		expect(movePickerIndex(5, 0, -1)).toBe(0);
	});
});
