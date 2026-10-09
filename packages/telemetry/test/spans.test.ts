import { describe, expect, expectTypeOf, it } from "vitest";
import { createTypedSpanStarter, InMemoryTelemetryContext, TG_SPAN_SCHEMA } from "../src/index.ts";

const SPAN_NAME_PATTERN = /^tg\.span\.[a-z][a-z0-9.]*$/;

describe("TG_SPAN_SCHEMA", () => {
	it("names every span in the tg.span family", () => {
		const names = Object.keys(TG_SPAN_SCHEMA.spans);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) expect(name).toMatch(SPAN_NAME_PATTERN);
	});

	it("stays serializable and documents every span", () => {
		expect(() => JSON.stringify(TG_SPAN_SCHEMA)).not.toThrow();
		for (const [name, span] of Object.entries(TG_SPAN_SCHEMA.spans)) {
			expect(span.description.trim(), name).not.toBe("");
			expect(span.status.errorWhen.trim(), name).not.toBe("");
		}
	});

	it("rejects vocabulary violations at compile time", () => {
		const startSpan = createTypedSpanStarter(new InMemoryTelemetryContext(), [TG_SPAN_SCHEMA]);
		const valid = () =>
			startSpan("tg.span.provider.request", { provider: "p", api: "a", model: "m" }, (span) => {
				span.setAttributes({ stopReason: "toolUse", retried: true, "tokens.input": 1, "cost.total": 0.5 });
			});
		expectTypeOf(valid).toBeFunction();

		const compileTimeFailures = () => {
			// @ts-expect-error the vocabulary only admits declared span names
			void startSpan("tg.span.provider.unknown", {}, () => {});
			// @ts-expect-error provider, api, and model are required start attributes
			void startSpan("tg.span.provider.request", { api: "a", model: "m" }, () => {});
			void startSpan("tg.span.provider.request", { provider: "p", api: "a", model: "m" }, (span) => {
				// @ts-expect-error stopReason is a closed set
				span.setAttributes({ stopReason: "pending" });
			});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
