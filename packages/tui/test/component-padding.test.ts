import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";

describe("component padding", () => {
	it("changes text margins at runtime", () => {
		const text = new Text("hi", 1, 0);
		assert.deepStrictEqual(text.render(20), [" hi                 "]);
		text.setPaddingX(3);
		assert.deepStrictEqual(text.render(20), ["   hi               "]);
		// The render cache is dropped with the padding, so the narrower value lands too.
		text.setPaddingX(0);
		assert.deepStrictEqual(text.render(20), ["hi                  "]);
	});

	it("changes box padding at runtime", () => {
		const box = new Box(1, 0);
		box.addChild(new Text("x", 0, 0));
		assert.deepStrictEqual(box.render(20), [" x                  "]);
		box.setPaddingX(4);
		assert.deepStrictEqual(box.render(20), ["    x               "]);
		box.setPaddingX(2);
		assert.deepStrictEqual(box.render(20), ["  x                 "]);
	});
});
