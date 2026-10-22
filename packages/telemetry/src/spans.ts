import { defineTelemetrySchema } from "./index.ts";

/**
 * First-batch span vocabulary. Names follow the `tg.span.*` family (AGENTS.md naming
 * table); attributes carry counts and closed enumerations only — never prompt text,
 * tool arguments, or paths.
 */
export const TG_SPAN_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"tg.span.provider.acquire": {
			description: "Concurrency-gate admission for one provider request: queue wait and rejection.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				provider: {
					type: "string",
					required: true,
					cardinality: "low",
					description: 'Provider catalog id, for example "anthropic".',
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "The gate rejects the request or the wait aborts." },
		},
		"tg.span.provider.request": {
			description: "One logical provider call: adapter retries and the full stream or response lifetime.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				provider: {
					type: "string",
					required: true,
					cardinality: "low",
					description: 'Provider catalog id, for example "anthropic".',
				},
				api: {
					type: "string",
					required: true,
					cardinality: "low",
					description: 'Provider API id, for example "anthropic-messages".',
				},
				model: {
					type: "string",
					required: true,
					cardinality: "low",
					description: 'Catalog model id, for example "claude-sonnet-5-5". Never free text.',
				},
			},
			endAttributes: {
				stopReason: {
					type: "string",
					values: ["stop", "length", "toolUse", "error", "aborted", "deferred"],
					cardinality: "low",
					description: "Terminal reason reported for the call. Completed messages never report pending.",
				},
				retried: {
					type: "boolean",
					cardinality: "low",
					description: "Whether the adapter retry loop scheduled at least one retry.",
				},
				"tokens.input": {
					type: "number",
					cardinality: "low",
					description: "Prompt tokens reported for the call.",
				},
				"tokens.output": {
					type: "number",
					cardinality: "low",
					description: "Completion tokens reported for the call.",
				},
				"tokens.cacheRead": { type: "number", cardinality: "low", description: "Cached prompt tokens read." },
				"tokens.cacheWrite": { type: "number", cardinality: "low", description: "Prompt tokens written to cache." },
				"cost.total": { type: "number", cardinality: "low", description: "Total cost at the catalog price." },
				errorName: {
					type: "string",
					cardinality: "low",
					description: 'Error class name, for example "ModelsError".',
				},
			},
			status: { default: "ok", errorWhen: "The call ends with an error or aborted stop reason, or throws." },
		},
		"tg.span.agent.turn": {
			description: "One agent turn: one provider response plus the tool calls it issued.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				provider: {
					type: "string",
					required: true,
					cardinality: "low",
					description: 'Provider catalog id, for example "anthropic".',
				},
				model: {
					type: "string",
					required: true,
					cardinality: "low",
					description: 'Catalog model id, for example "claude-sonnet-5-5". Never free text.',
				},
			},
			endAttributes: {
				stopReason: {
					type: "string",
					values: ["stop", "length", "toolUse", "error", "aborted", "deferred"],
					cardinality: "low",
					description: "Terminal reason of the turn's assistant message.",
				},
				toolCallCount: {
					type: "number",
					cardinality: "low",
					description: "Tool calls the turn issued.",
				},
			},
			status: { default: "ok", errorWhen: "The turn ends with an error or aborted stop reason." },
		},
		"tg.span.agent.tool": {
			description: "One tool call: preparation, execution, and finalization.",
			parents: { kind: "spans", spans: ["tg.span.agent.turn", "tg.span.agent.tool"] },
			startAttributes: {
				toolName: {
					type: "string",
					required: true,
					cardinality: "low",
					description: "Tool name as declared in the agent tool loadout.",
				},
			},
			endAttributes: {
				isError: {
					type: "boolean",
					cardinality: "low",
					description: "Whether the call failed, was denied, or threw.",
				},
			},
			status: { default: "ok", errorWhen: "The tool call fails, is denied, or throws." },
		},
		"tg.span.sec.guard": {
			description:
				"One tg-sec-guard decision. Every tool call records exactly one, allow included. Attributes carry the mode, a truncated digest of the arguments, and the decision; never the command text or any argument value.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				mode: {
					type: "string",
					values: ["strict", "judge-auto", "auto", "yolo"],
					required: true,
					cardinality: "low",
					description: "The permission mode in effect for the call.",
				},
				argsDigest: {
					type: "string",
					required: true,
					cardinality: "low",
					sensitive: true,
					description:
						"Truncated one-way digest of the call arguments, for correlating identical calls. Bounded; never reversible to argument text.",
				},
			},
			endAttributes: {
				layer: {
					type: "string",
					values: ["hard-deny", "scope", "danger", "grants", "mode"],
					cardinality: "low",
					description: "The evaluation layer that produced the decision.",
				},
				effect: {
					type: "string",
					values: ["allow", "deny", "ask"],
					cardinality: "low",
					description: "The decision effect.",
				},
				forced: {
					type: "boolean",
					cardinality: "low",
					description: "Whether an ask was forced and therefore immune to grants and mode exemptions.",
				},
				rule: {
					type: "string",
					values: [
						"self-protection.loopback-hostname",
						"self-protection.loopback-v4",
						"self-protection.loopback-v6",
						"self-protection.local-interface",
						"self-destruction.rm-root",
						"self-destruction.rm-home",
						"self-destruction.mkfs",
						"self-destruction.dd-device",
						"self-destruction.fork-bomb",
						"self-destruction.power",
					],
					cardinality: "low",
					description: "The built-in hard-deny rule that matched. Present only when layer is hard-deny.",
				},
			},
			status: { default: "ok", errorWhen: "The guard evaluation throws." },
		},
		"tg.span.sec.mode": {
			description: "One hot switch of the session permission mode, recorded when the switch is committed.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				from: {
					type: "string",
					values: ["strict", "judge-auto", "auto", "yolo"],
					required: true,
					cardinality: "low",
					description: "The mode being replaced.",
				},
				to: {
					type: "string",
					values: ["strict", "judge-auto", "auto", "yolo"],
					required: true,
					cardinality: "low",
					description: "The mode being adopted.",
				},
				actor: {
					type: "string",
					required: true,
					cardinality: "low",
					description: "Who performed the switch, as an opaque operator identifier. Never free text.",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "The switch commit throws." },
		},
	},
});
