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
		"tg.span.ai.request": {
			description:
				"One logical model request observed inside the ai adapter, including authentication and provider setup. Mirrors the ai package's own schema so house consumers can validate the same spans.",
			parents: { kind: "any" },
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
					description: 'API identifier, for example "anthropic-messages".',
				},
				model: {
					type: "string",
					required: true,
					cardinality: "low",
					description: "Requested catalog model id. Never free text.",
				},
				reasoning: {
					type: "string",
					required: false,
					cardinality: "low",
					description: "Scalar requested reasoning level, when one was set.",
				},
			},
			endAttributes: {
				stop: {
					type: "string",
					values: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"],
					cardinality: "low",
					description: "Normalized stop reason.",
				},
				"usage.input": { type: "number", cardinality: "low", description: "Uncached input tokens." },
				"usage.output": { type: "number", cardinality: "low", description: "Output tokens." },
				"usage.cache_read": { type: "number", cardinality: "low", description: "Cache-read tokens." },
				"usage.cache_write": { type: "number", cardinality: "low", description: "Cache-write tokens." },
				"cost.total": { type: "number", cardinality: "low", description: "Total request cost in USD." },
				"response.id": {
					type: "string",
					cardinality: "high",
					description: "Provider response identifier.",
				},
			},
			status: {
				default: "ok",
				errorWhen:
					"Stop reason is error: provider_error with at most 500 error-message characters. Aborted stays ok.",
			},
		},
		"tg.span.ai.poll": {
			description:
				"One deferred-response poll, not the deferred request's lifetime. Same shape as tg.span.ai.request.",
			parents: { kind: "any" },
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
					description: 'API identifier, for example "anthropic-messages".',
				},
				model: {
					type: "string",
					required: true,
					cardinality: "low",
					description: "Requested catalog model id. Never free text.",
				},
				reasoning: {
					type: "string",
					required: false,
					cardinality: "low",
					description: "Scalar requested reasoning level, when one was set.",
				},
			},
			endAttributes: {
				stop: {
					type: "string",
					values: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"],
					cardinality: "low",
					description: "Normalized stop reason.",
				},
				"usage.input": { type: "number", cardinality: "low", description: "Uncached input tokens." },
				"usage.output": { type: "number", cardinality: "low", description: "Output tokens." },
				"usage.cache_read": { type: "number", cardinality: "low", description: "Cache-read tokens." },
				"usage.cache_write": { type: "number", cardinality: "low", description: "Cache-write tokens." },
				"cost.total": { type: "number", cardinality: "low", description: "Total request cost in USD." },
				"response.id": {
					type: "string",
					cardinality: "high",
					description: "Provider response identifier.",
				},
			},
			status: {
				default: "ok",
				errorWhen:
					"Stop reason is error: provider_error with at most 500 error-message characters. Aborted stays ok.",
			},
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
					values: ["hard-deny", "rules", "self-protection", "scope", "danger", "grants", "mode"],
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
						"danger.sql.drop-table",
						"danger.sql.drop-database",
						"danger.sql.truncate",
						"danger.sql.delete-from",
						"danger.sql.alter-drop",
						"danger.sql.update-set",
						"danger.sql.insert-into",
						"danger.sql.replace-into",
						"danger.sql.load-data-infile",
						"danger.sql.into-outfile",
						"danger.sql.into-dumpfile",
						"danger.tool.sqlmap-os-shell",
						"danger.tool.sqlmap-os-cmd",
						"danger.tool.sqlmap-file-write",
						"danger.tool.sqlmap-sql-shell",
						"danger.web.action-destroy",
						"danger.redis.flushall",
						"danger.redis.flushdb",
						"danger.mongo.drop-database",
						"danger.persist.crontab",
						"danger.persist.add-user",
						"danger.persist.authorized-keys",
						"danger.persist.schtasks",
						"danger.persist.systemd-unit",
						"danger.rm.system-path",
						"danger.business.password-change",
						"danger.business.contact-rebind",
						"danger.business.payment-move",
						"danger.business.messaging-bomb",
						"danger.wordlist.huge",
						"danger.bruteforce.hashcat",
						"danger.bruteforce.john-wordlist",
					],
					cardinality: "low",
					description:
						"The built-in protection rule that matched. Present when the layer is hard-deny or self-protection, or when the danger evaluator names its rule on a danger-layer hit. Kept in lockstep with `TgSecDangerRuleId` in tg-sec-guard.",
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
		"tg.span.sec.fork": {
			description:
				"One foreground `task` delegation to a child conversation forked from the caller. Attributes carry the lane, the role and the outcome only — never the delegation intent or any child text.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				lane: {
					type: "string",
					values: ["redteam", "ctf", "src"],
					required: true,
					cardinality: "low",
					description: "The lane whose guard and sections condition the child.",
				},
				role: {
					type: "string",
					values: ["redteam", "binary", "reporting"],
					required: true,
					cardinality: "low",
					description: "The static role policy the child runs under.",
				},
			},
			endAttributes: {
				outcome: {
					type: "string",
					values: ["done", "failed", "aborted", "depth-rejected"],
					cardinality: "low",
					description:
						"How the delegation settled; `depth-rejected` is a nested call refused by the single-hop gate.",
				},
				depth: {
					type: "number",
					cardinality: "low",
					description:
						"The child depth below the root this call would have created. A root call creates depth 1; a nested call is rejected at depth 2.",
				},
			},
			status: { default: "ok", errorWhen: "The delegation fails, aborts, is rejected, or throws." },
		},
		"tg.span.sec.evidence": {
			description:
				"One evidence-store operation. Attributes carry the operation, an optional truncated one-way digest of the subject, and the outcome with counts; never a content hash, a snapshot id, or subject text.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				op: {
					type: "string",
					values: ["record", "bind", "list", "edit", "collect", "read"],
					required: true,
					cardinality: "low",
					description: "The evidence-store method this span covers.",
				},
				subjectDigest: {
					type: "string",
					required: false,
					cardinality: "low",
					sensitive: true,
					description:
						"Truncated one-way digest of the subject key, for correlating operations on one evidence set. Bounded; never reversible to the subject.",
				},
			},
			endAttributes: {
				outcome: {
					type: "string",
					values: ["ok", "conflict", "not-found", "error"],
					cardinality: "low",
					description:
						"How the operation ended: success, an optimistic-lock conflict, a missing reference, or an error.",
				},
				changed: {
					type: "boolean",
					cardinality: "low",
					description: "Whether the operation wrote durable state (a new binding, a bump, a reap).",
				},
				count: {
					type: "number",
					cardinality: "low",
					description:
						"The count most natural to the operation: bindings after, a snapshot, or files reclaimed by GC.",
				},
			},
			status: {
				default: "ok",
				errorWhen: "The operation errors, hits a conflict, references missing evidence, or throws.",
			},
		},
	},
});
