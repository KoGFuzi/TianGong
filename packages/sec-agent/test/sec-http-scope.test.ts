import type { ToolHookCall } from "@OnePanda-TgSec/tg-gibraltar";
import { createTgSecScopeRegistry, toTgSecRequest } from "@OnePanda-TgSec/tg-sec-guard";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { describe, expect, it } from "vitest";
import { buildSecGuard, secDeclaredTools } from "../src/guard-wiring.ts";
import { context } from "./support.ts";

/** A session port that never holds a document: the test always passes an explicit mode. */
const noDocument = {
	snapshot: async () => undefined,
	commit: async () => {
		throw new Error("scope test never writes the mode document");
	},
};

/** The reserved RFC 2606 hosts: `.invalid` is never resolvable, so nothing here could reach a wire. */
const IN_SCOPE = "in-scope.invalid";

function httpRequest(url: string, id: string): ToolHookCall {
	return { type: "toolCall", id, name: "http_request", arguments: { url } };
}

async function wiringWith(telemetry: InMemoryTelemetryContext) {
	const registry = createTgSecScopeRegistry([
		{ kind: "exact-host", pattern: IN_SCOPE, effect: "allow", enabled: true },
	]);
	return buildSecGuard({
		session: noDocument,
		lane: "redteam",
		context,
		mode: "auto",
		scopeRegistry: registry,
		telemetry,
		attestParts: { forbiddenRead: async () => undefined, registeredTools: () => secDeclaredTools("redteam") },
	});
}

describe("http_request scope enforcement", () => {
	it("admits an in-scope host and forces a scope ask on an out-of-scope host, with no sec-guard change", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const wiring = await wiringWith(telemetry);

		// The exact call shape the tool's `url` parameter produces: the scope layer sees it for free.
		const inside = await wiring.guard.decisionFor(toTgSecRequest(httpRequest(`https://${IN_SCOPE}/probe`, "in-1")));
		expect(inside).toEqual({ effect: "allow" });

		const outside = await wiring.guard.decisionFor(
			toTgSecRequest(httpRequest("https://elsewhere.invalid/x", "out-1")),
		);
		expect(outside.effect).toBe("ask");
		if (outside.effect === "ask") {
			expect(outside.forced).toBe(true);
			expect(outside.reason).toContain("scope");
		}

		// The out-of-scope decision was attributed to the scope layer on its guard span; the in-scope one was not.
		const guardSpans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.guard");
		const scoped = guardSpans.filter((span) => span.attributes.layer === "scope");
		expect(scoped).toHaveLength(1);
		expect(guardSpans.find((span) => span.attributes.layer === "mode")).toBeDefined();
	});
});
