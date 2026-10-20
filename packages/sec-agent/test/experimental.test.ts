import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalTgExperimental = process.env.TG_EXPERIMENTAL;

	afterEach(() => {
		if (originalTgExperimental === undefined) {
			delete process.env.TG_EXPERIMENTAL;
		} else {
			process.env.TG_EXPERIMENTAL = originalTgExperimental;
		}
	});

	it("returns false when TG_EXPERIMENTAL is unset", () => {
		delete process.env.TG_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when TG_EXPERIMENTAL is empty", () => {
		process.env.TG_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when TG_EXPERIMENTAL is set to 1", () => {
		process.env.TG_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when TG_EXPERIMENTAL is set to 0", () => {
		process.env.TG_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when TG_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.TG_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
