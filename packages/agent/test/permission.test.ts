import type { AssistantMessage } from "@OnePanda-TgSec/tg-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import { evaluatePermission, type PermissionRule, toolResource } from "../src/permission.ts";
import type { AgentTool, AgentToolCall } from "../src/types.ts";

const echoSchema = Type.Object({ value: Type.String() });
const echo: AgentTool<typeof echoSchema> = {
	name: "echo",
	label: "Echo",
	description: "Echo tool",
	parameters: echoSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `echoed: ${params.value}` }],
			details: {},
			structuredContent: { value: params.value },
		};
	},
};

const shellSchema = Type.Object({ command: Type.String() });
const shell: AgentTool<typeof shellSchema> = {
	name: "shell",
	label: "Shell",
	description: "Runs a command",
	parameters: shellSchema,
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: `ran: ${params.command}` }], details: {} };
	},
};

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

const call = (id: string, name: string, args: AgentToolCall["arguments"]): AgentToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});

const baseOptions = {
	tools: [echo, shell],
	assistantMessage,
	context: { messages: [] },
};

describe("evaluatePermission", () => {
	it("allows when there are no rules", () => {
		expect(evaluatePermission([], "tool:shell")).toBe("allow");
	});

	it("allows when no rule matches (fail-open default)", () => {
		expect(evaluatePermission([{ action: "execute", resource: "tool:rm", effect: "deny" }], "tool:echo")).toBe(
			"allow",
		);
	});

	it("applies the first matching rule", () => {
		const rules = [
			{ action: "execute" as const, resource: "tool:echo", effect: "deny" as const },
			{ action: "execute" as const, resource: "tool:*", effect: "allow" as const },
		];
		expect(evaluatePermission(rules, "tool:echo")).toBe("deny");
		expect(evaluatePermission(rules, "tool:shell")).toBe("allow");
	});

	it("lets an exception written before the general rule win", () => {
		const rules = [
			{ action: "execute" as const, resource: "tool:safe_*", effect: "allow" as const },
			{ action: "execute" as const, resource: "tool:*", effect: "ask" as const },
		];
		expect(evaluatePermission(rules, "tool:safe_read")).toBe("allow");
		expect(evaluatePermission(rules, "tool:shell")).toBe("ask");
	});

	it("supports the bare wildcard", () => {
		expect(evaluatePermission([{ action: "execute", resource: "*", effect: "deny" }], "tool:anything")).toBe("deny");
	});

	it("matches full strings only, not substrings", () => {
		const rules = [{ action: "execute" as const, resource: "tool:hell*", effect: "deny" as const }];
		expect(evaluatePermission(rules, "tool:hello")).toBe("deny");
		expect(evaluatePermission(rules, "tool:hello_world")).toBe("deny");
		// "shell" contains "hell" but the pattern is anchored.
		expect(evaluatePermission(rules, "tool:shell")).toBe("allow");
	});

	it("matches case-sensitively", () => {
		const rules = [{ action: "execute" as const, resource: "tool:Echo", effect: "deny" as const }];
		expect(evaluatePermission(rules, "tool:Echo")).toBe("deny");
		expect(evaluatePermission(rules, "tool:echo")).toBe("allow");
	});

	it("treats regex-significant characters in tool names literally", () => {
		// A tool named like "a.b$c" must not let the dots act as regex wildcards.
		const rules = [{ action: "execute" as const, resource: "tool:a.b$c", effect: "deny" as const }];
		expect(evaluatePermission(rules, "tool:a.b$c")).toBe("deny");
		expect(evaluatePermission(rules, "tool:aXbYc")).toBe("allow");
	});

	it("derives resources with a tool: prefix", () => {
		expect(toolResource("shell")).toBe("tool:shell");
	});
});

describe("tool call permission policy", () => {
	it("blocks execution when a deny rule matches", async () => {
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "deny" }],
		});

		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([{ type: "text", text: expect.stringContaining("tool:shell") }]);
	});

	it("executes normally when no rule matches (fail-open)", async () => {
		const outcome = await runToolCall(call("a", "echo", { value: "hi" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "deny" }],
		});

		expect(outcome.isError).toBe(false);
		expect(outcome.result.content).toEqual([{ type: "text", text: "echoed: hi" }]);
	});

	it("executes normally with no rules configured at all", async () => {
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), baseOptions);
		expect(outcome.isError).toBe(false);
	});

	it("passes the request shape to onPermissionAsk and honors allow", async () => {
		const requests: unknown[] = [];
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "ask" }],
			onPermissionAsk: async (request) => {
				requests.push(request);
				return "allow";
			},
		});

		expect(outcome.isError).toBe(false);
		expect(requests).toEqual([
			{ action: "execute", resource: "tool:shell", toolName: "shell", args: { command: "ls" } },
		]);
	});

	it("blocks when the human declines an ask", async () => {
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "ask" }],
			onPermissionAsk: async () => "deny",
		});

		expect(outcome.isError).toBe(true);
		expect(outcome.result.content[0]).toMatchObject({ text: expect.stringContaining("declined") });
	});

	it("blocks when an ask has no handler configured (the one fail-closed point)", async () => {
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "ask" }],
		});

		expect(outcome.isError).toBe(true);
		expect(outcome.result.content[0]).toMatchObject({
			text: expect.stringContaining("no onPermissionAsk handler"),
		});
	});

	it("blocks when the ask callback throws", async () => {
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "ask" }],
			onPermissionAsk: async () => {
				throw new Error("prompt UI crashed");
			},
		});

		expect(outcome.isError).toBe(true);
		expect(outcome.result.content[0]).toMatchObject({ text: expect.stringContaining("prompt UI crashed") });
	});

	it("reports an abort that fires while waiting for approval", async () => {
		const controller = new AbortController();
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), {
			...baseOptions,
			signal: controller.signal,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "ask" }],
			onPermissionAsk: async (_request, signal) => {
				controller.abort();
				// The hook contract says to honor the signal; a real UI would reject promptly.
				// Return only after the abort so the loop's post-check observes it.
				await new Promise((resolve) => setTimeout(resolve, 5));
				return signal?.aborted ? Promise.reject(new Error("The operation was aborted")) : "allow";
			},
		});

		expect(outcome.isError).toBe(true);
	});

	it("lets a hook block win even when a rule would allow", async () => {
		const outcome = await runToolCall(call("a", "echo", { value: "hi" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "*", effect: "allow" }],
			beforeToolCall: async () => ({ block: true, reason: "hook says no" }),
		});

		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([{ type: "text", text: "hook says no" }]);
	});

	it("applies the policy when the hook abstains", async () => {
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "deny" }],
			beforeToolCall: async () => undefined,
		});

		expect(outcome.isError).toBe(true);
	});

	it("treats an explicit non-blocking hook result as abstaining", async () => {
		const outcome = await runToolCall(call("a", "shell", { command: "ls" }), {
			...baseOptions,
			permissionRules: [{ action: "execute", resource: "tool:shell", effect: "deny" }],
			beforeToolCall: async () => ({}),
		});

		expect(outcome.isError).toBe(true);
	});

	it("an always reply records a grant so later calls are not asked again", async () => {
		const grants = new Set<string>();
		const askRules: PermissionRule[] = [{ action: "execute", resource: "tool:shell", effect: "ask" }];
		const options = {
			...baseOptions,
			permissionGrants: grants,
			permissionRules: askRules,
			onPermissionAsk: async () => "always" as const,
		};

		const first = await runToolCall(call("a", "shell", { command: "ls" }), options);
		expect(first.isError).toBe(false);
		expect(grants.has("execute:tool:shell")).toBe(true);

		// The second call is admitted without consulting the ask callback again.
		let asked = 0;
		const second = await runToolCall(call("b", "shell", { command: "pwd" }), {
			...options,
			onPermissionAsk: async () => {
				asked++;
				return "allow";
			},
		});
		expect(second.isError).toBe(false);
		expect(asked).toBe(0);
	});

	it("an always grant is keyed to the exact tool, not the rule's wildcard", async () => {
		const grants = new Set<string>();
		const wildcardRules: PermissionRule[] = [{ action: "execute", resource: "tool:shell*", effect: "ask" }];
		const options = {
			...baseOptions,
			permissionGrants: grants,
			permissionRules: wildcardRules,
			onPermissionAsk: async () => "always" as const,
		};

		await runToolCall(call("a", "shell", { command: "ls" }), options);
		expect(grants.has("execute:tool:shell")).toBe(true);
		// A sibling matched by the same wildcard still asks.
		let asked = 0;
		const outcome = await runToolCall(call("b", "shell_history", { command: "x" }), {
			...options,
			tools: [
				...baseOptions.tools,
				{
					name: "shell_history",
					label: "Shell history",
					description: "History",
					parameters: shellSchema,
					async execute() {
						return { content: [{ type: "text", text: "ran" }], details: {} };
					},
				},
			],
			onPermissionAsk: async () => {
				asked++;
				return "allow";
			},
		});
		expect(outcome.isError).toBe(false);
		expect(asked).toBe(1);
	});

	it("an always grant outranks a later deny rule (human approval beats declared rules)", async () => {
		const grants = new Set<string>();
		const askRules: PermissionRule[] = [{ action: "execute", resource: "tool:shell", effect: "ask" }];
		const denyRules: PermissionRule[] = [{ action: "execute", resource: "tool:shell", effect: "deny" }];
		const options = {
			...baseOptions,
			permissionGrants: grants,
			permissionRules: askRules,
			onPermissionAsk: async () => "always" as const,
		};

		await runToolCall(call("a", "shell", { command: "ls" }), options);

		// Even with a deny rule now in force, the granted resource stays allowed.
		const outcome = await runToolCall(call("b", "shell", { command: "ls" }), {
			...options,
			permissionRules: denyRules,
		});
		expect(outcome.isError).toBe(false);
	});
});
