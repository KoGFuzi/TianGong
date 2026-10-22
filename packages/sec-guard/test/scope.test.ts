import { describe, expect, it } from "vitest";
import {
	createTgSecScopeRegistry,
	createTgSecScopeResolver,
	type TgSecRequest,
	type TgSecScopeRule,
} from "../src/index.ts";

function shell(command: string): TgSecRequest {
	return { toolName: "shell", resource: "tool:shell", arguments: { command } };
}

/** One named argument, the shape a non-shell tool call arrives in. */
function args(toolName: string, arguments_: Record<string, unknown>): TgSecRequest {
	return { toolName, resource: `tool:${toolName}`, arguments: arguments_ };
}

/**
 * A local exact-host allow list, the resolver-test analogue of batch 1b's `createInMemoryScopeRegistry`
 * helper. The helper itself is gone — the engine supersedes it — and the shape is deliberately test-side
 * only: nothing in `src/` ships a shorthand that could quietly become the way operators register scope.
 */
function allowHosts(hosts: readonly string[]): readonly TgSecScopeRule[] {
	return hosts.map((pattern) => ({ kind: "exact-host", pattern, effect: "allow", enabled: true }) as const);
}

function registryOf(rules: readonly TgSecScopeRule[]) {
	return createTgSecScopeResolver(createTgSecScopeRegistry(rules));
}

describe("createTgSecScopeResolver", () => {
	it("keeps a request with no connection targets in scope, deliberately", () => {
		// Deliberate (see the comment in scope.ts): without this, every read/write/edit — any call
		// without a network target — would force an ask and hollow out the guard.
		const resolver = registryOf([]);
		expect(resolver(shell("cat report.md"))).toEqual({ inScope: true });
		expect(resolver({ toolName: "read", resource: "tool:read", arguments: { path: "src/index.ts" } })).toEqual({
			inScope: true,
		});
	});

	it("asks for an unregistered authority and names the evidence tier in the reason", () => {
		const resolver = registryOf(allowHosts(["target.com"]));
		const verdict = resolver(shell("curl http://evil.com/"));
		expect(verdict.inScope).toBe(false);
		expect(verdict.reason).toContain("evil.com");
		// The tier rides along so a human reading the ask can weigh it (batch 1c).
		expect(verdict.reason).toContain("strong evidence");
		expect(resolver(shell("nmap -p 80 203.0.113.9")).reason).toContain("weak evidence");
	});

	it("distinguishes unlisted from denied in the reason", () => {
		// 定调 1 and 2 land as two readable refusals: "no allow entry covers it" versus the deny entry
		// that fired. An operator who registered a deny must see their own rule named, not a generic miss.
		const resolver = registryOf([
			{ kind: "cidr4", pattern: "192.168.0.0/24", effect: "allow", enabled: true },
			{ kind: "cidr4", pattern: "192.168.0.1/32", effect: "deny", enabled: true },
		]);
		const denied = resolver(shell("curl http://192.168.0.1/"));
		expect(denied.inScope).toBe(false);
		expect(denied.reason).toContain('refused by the scope deny entry "192.168.0.1/32"');
		expect(denied.reason).toContain("cidr4");
		expect(denied.reason).toContain("strong evidence");
		const unlisted = resolver(shell("curl http://10.0.0.1/"));
		expect(unlisted.reason).toContain("not in the registered scope: no allow entry covers it");
	});

	it("compares weak candidates too: the tier does not relax scope", () => {
		// The point of the tier is what a self-protection rule may do with the host, not whether the
		// registry still has to recognize it.
		const resolver = registryOf([]);
		expect(resolver(shell("grep 127.0.0.1 access.log")).inScope).toBe(false);
		expect(resolver(args("write", { content: "grep 127.0.0.1 access.log" })).inScope).toBe(true);
	});

	it("accepts a registered authority, case-insensitively", () => {
		const resolver = registryOf(allowHosts(["Target.COM"]));
		expect(resolver(shell("curl http://target.com/x")).inScope).toBe(true);
	});

	it("fails the request when any one of several targets is unregistered", () => {
		const resolver = registryOf(allowHosts(["1.2.3.4"]));
		expect(resolver(shell("curl http://1.2.3.4/ && wget http://5.6.7.8/")).inScope).toBe(false);
	});

	it("grants localhost no implicit membership: it is in scope only if registered", () => {
		expect(registryOf([])(shell("nc 127.0.0.1 80")).inScope).toBe(false);
		const registered = registryOf(allowHosts(["127.0.0.1"]));
		expect(registered(shell("nc 127.0.0.1 80")).inScope).toBe(true);
		// Registration settles the scope question at this layer only. A registered loopback mention
		// still trips the weak-evidence self-protection ask ahead of it in the chain (guard.test.ts):
		// the registry permits a host, it does not overrule the platform's own addresses.
	});

	it("never consults the registry for data values", () => {
		const resolver = registryOf(allowHosts(["target"]));
		expect(resolver(shell(`curl -d '{"u":"http://localhost/admin"}' http://target/`)).inScope).toBe(true);
	});

	it("reaches into subcommands through the shared extraction", () => {
		// An empty registry is the honest "nothing is registered" shape now: the old literal
		// `{ contains: () => false }` could not answer `outcome`, and faking a refusal is no longer
		// needed to write this test.
		const verdict = registryOf([])(shell('sh -c "curl http://10.9.8.7/"'));
		expect(verdict.inScope).toBe(false);
		expect(verdict.reason).toContain("10.9.8.7");
	});
});
