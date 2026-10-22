import { describe, expect, it } from "vitest";
import {
	createInMemoryScopeRegistry,
	createTgSecScopeResolver,
	type TgSecRequest,
	type TgSecScopeRegistry,
} from "../src/index.ts";

function shell(command: string): TgSecRequest {
	return { toolName: "shell", resource: "tool:shell", arguments: { command } };
}

describe("createTgSecScopeResolver", () => {
	it("keeps a request with no connection targets in scope, deliberately", () => {
		// Deliberate (see the comment in scope.ts): without this, every read/write/edit — any call
		// without a network target — would force an ask and hollow out the guard.
		const resolver = createTgSecScopeResolver(createInMemoryScopeRegistry([]));
		expect(resolver(shell("cat report.md"))).toEqual({ inScope: true });
		expect(resolver({ toolName: "read", resource: "tool:read", arguments: { path: "src/index.ts" } })).toEqual({
			inScope: true,
		});
	});

	it("asks for an unregistered authority", () => {
		const registry = createInMemoryScopeRegistry(["target.com"]);
		const verdict = createTgSecScopeResolver(registry)(shell("curl http://evil.com/"));
		expect(verdict.inScope).toBe(false);
		expect(verdict.reason).toContain("evil.com");
	});

	it("accepts a registered authority, case-insensitively", () => {
		const resolver = createTgSecScopeResolver(createInMemoryScopeRegistry(["Target.COM"]));
		expect(resolver(shell("curl http://target.com/x")).inScope).toBe(true);
	});

	it("fails the request when any one of several targets is unregistered", () => {
		const resolver = createTgSecScopeResolver(createInMemoryScopeRegistry(["1.2.3.4"]));
		expect(resolver(shell("curl http://1.2.3.4/ && wget http://5.6.7.8/")).inScope).toBe(false);
	});

	it("grants localhost no implicit membership: it is in scope only if registered", () => {
		expect(createTgSecScopeResolver(createInMemoryScopeRegistry([]))(shell("nc 127.0.0.1 80")).inScope).toBe(false);
		const registered = createTgSecScopeResolver(createInMemoryScopeRegistry(["127.0.0.1"]));
		expect(registered(shell("nc 127.0.0.1 80")).inScope).toBe(true);
	});

	it("never consults the registry for data values", () => {
		const resolver = createTgSecScopeResolver(createInMemoryScopeRegistry(["target"]));
		expect(resolver(shell(`curl -d '{"u":"http://localhost/admin"}' http://target/`)).inScope).toBe(true);
	});

	it("reaches into subcommands through the shared extraction", () => {
		const registry: TgSecScopeRegistry = { contains: () => false };
		const verdict = createTgSecScopeResolver(registry)(shell('sh -c "curl http://10.9.8.7/"'));
		expect(verdict.inScope).toBe(false);
		expect(verdict.reason).toContain("10.9.8.7");
	});
});

describe("createInMemoryScopeRegistry", () => {
	it("is the exact-host set it claims to be: no suffix or wildcard matching", () => {
		const registry = createInMemoryScopeRegistry(["target.com"]);
		expect(registry.contains("target.com")).toBe(true);
		expect(registry.contains("sub.target.com")).toBe(false);
		expect(registry.contains("target")).toBe(false);
	});
});
