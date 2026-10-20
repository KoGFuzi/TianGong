import { describe, expect, it } from "vitest";
import { getTgUserAgent } from "../src/utils/tg-user-agent.ts";

describe("getTgUserAgent", () => {
	it("formats the user agent expected by the release feed", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getTgUserAgent("1.2.3");

		expect(userAgent).toBe(`tg/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^tg\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
