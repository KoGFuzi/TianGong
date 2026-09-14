import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@onepanda-tiangongsec/tg-telemetry";
import { describe, expect, it } from "bun:test";
import { expectTypeOf } from "../utils/testing.ts";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import { BACKGROUND_CONTEXT, withTelemetryContext } from "../../src/harness/context.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"tg.harness.run",
			"tg.harness.compaction",
			"tg.harness.navigation",
			"tg.harness.checkpoint",
			"tg.harness.turn",
			"tg.harness.step",
			"tg.harness.tool",
			"tg.harness.hook",
			"tg.harness.sleep",
			"tg.harness.event_handler",
			"tg.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"tg.harness.step",
			{
				"tg.lane.name": "main",
				"tg.operation.id": "operation",
				"tg.step.kind": "assistant",
				"tg.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "tg.step.outcome": "succeeded" });
				await startChildSpan(
					"tg.ai.request",
					{
						"tg.ai.operation": "stream",
						"tg.ai.provider": "provider",
						"tg.ai.model": "model",
						"tg.ai.api": "api",
						"tg.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "tg.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"tg.ai.request">;
		type End = AiSpanEndAttributes<"tg.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"tg.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"tg.ai.provider": string;
			"tg.ai.model": string;
			"tg.ai.api": string;
			"tg.ai.streaming": boolean;
			"tg.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["tg.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		const context = withTelemetryContext(telemetryContext, BACKGROUND_CONTEXT);
		await startAiSpan(
			"tg.ai.request",
			{
				"tg.ai.operation": "stream",
				"tg.ai.provider": "provider",
				"tg.ai.model": "model",
				"tg.ai.api": "api",
				"tg.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "tg.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error pi.ai.request declares no span events
				span.addEvent("chunk");
			},
			context,
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"tg.ai.operation": "stream",
				"tg.ai.provider": "provider",
				"tg.ai.model": "model",
				"tg.ai.api": "api",
				"tg.ai.streaming": true,
				"tg.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan("tg.ai.request", extraAttributes, () => {}, context);
			// @ts-expect-error missing required start attributes
			void startAiSpan("tg.ai.request", { "tg.ai.operation": "stream" }, () => {}, context);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"tg.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"tg.harness.run">;
		type WriteStart = HarnessSpanStartAttributes<"tg.session.write">;
		type WriteEnd = HarnessSpanEndAttributes<"tg.session.write">;
		expectTypeOf<RunStart["tg.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["tg.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();
		const writeStart = {
			"tg.session.id": "session",
			"tg.session.item_count": 2,
			"tg.session.item_kinds": ["entry", "value", "list"],
		} satisfies WriteStart;
		const writeEnd = {
			"tg.session.first_seq": 1,
			"tg.session.last_seq": 2,
		} satisfies WriteEnd;
		expectTypeOf(writeStart["tg.session.item_count"]).toEqualTypeOf<number>();
		expectTypeOf(writeEnd["tg.session.last_seq"]).toEqualTypeOf<number>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		const context = withTelemetryContext(telemetryContext, BACKGROUND_CONTEXT);
		await startHarnessSpan(
			"tg.harness.run",
			{
				"tg.session.id": "session",
				"tg.lane.name": "main",
				"tg.operation.id": "operation",
				"tg.operation.kind": "run",
				"tg.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "tg.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
			context,
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"tg.session.id": "session",
				"tg.lane.name": "main",
				"tg.operation.id": "operation",
				"tg.operation.kind": "run",
				"tg.operation.recovery": false,
				"tg.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan("tg.harness.run", extraRunAttributes, () => {}, context);
			void startHarnessSpan(
				"tg.harness.checkpoint",
				{
					"tg.lane.name": "main",
					"tg.operation.id": "operation",
					"tg.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "tg.unknown": true });
				},
				context,
			);
			void startHarnessSpan(
				"tg.harness.run",
				{
					"tg.session.id": "session",
					"tg.lane.name": "main",
					"tg.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"tg.operation.kind": "navigation",
					"tg.operation.recovery": false,
				},
				() => {},
				context,
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan("tg.harness.run", {}, () => {}, context);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
