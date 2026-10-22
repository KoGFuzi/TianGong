import { describe, expect, it } from "vitest";
// The surface primitives are module-internal by batch 1d: this suite tests them at their home module,
// which is the only place outside hard-deny.ts that may reach them. `test/boundary.test.ts` asserts
// that the package entry does not hand them out.
import { extractCommandSurface, extractConnectionTargets, scanTextSurface, tokenize } from "../src/command-text.ts";
import type { TgSecRequest } from "../src/types.ts";

function shell(command: string): TgSecRequest {
	return { toolName: "shell", resource: "tool:shell", arguments: { command } };
}

/** One named argument, the shape a non-shell tool call arrives in. */
function args(toolName: string, arguments_: Record<string, unknown>): TgSecRequest {
	return { toolName, resource: `tool:${toolName}`, arguments: arguments_ };
}

/**
 * The candidates as `host/evidence` strings, so a single assertion pins down both the extracted host
 * and the tier it was extracted on — the tier is the whole point of the batch 1c rule.
 */
function targets(request: TgSecRequest): string[] {
	return extractConnectionTargets(request).map((target) => `${target.host}/${target.evidence}`);
}

function heads(request: TgSecRequest): string[] {
	const out: string[] = [];
	for (const stream of extractCommandSurface(request).streams) {
		for (const token of stream) if (token.commandPosition) out.push(token.text);
	}
	return out;
}

describe("tokenize", () => {
	it("marks command positions at segment starts and after separators", () => {
		const tokens = tokenize("echo a && rm -rf / ; ls | wc -l");
		expect(tokens.filter((token) => token.commandPosition).map((token) => token.text)).toEqual([
			"echo",
			"rm",
			"ls",
			"wc",
		]);
		expect(tokens.find((token) => token.text === "-rf")?.commandPosition).toBe(false);
	});

	it("keeps quoted content in one token and quotes are not separators", () => {
		const tokens = tokenize('sh -c "rm -rf /"');
		expect(tokens.map((token) => token.text)).toEqual(["sh", "-c", "rm -rf /"]);
		expect(tokens[2]?.commandPosition).toBe(false);
	});

	it("marks the inner command of a $() substitution at a command position", () => {
		// The closing `)` is not a separator: batch 1a does not track substitution nesting.
		const tokens = tokenize("echo $( whoami )");
		expect(tokens.find((token) => token.text === "whoami")?.commandPosition).toBe(true);
	});
});

describe("extractCommandSurface", () => {
	it("collects every string value recursively, unserialized", () => {
		const surface = extractCommandSurface({
			toolName: "x",
			resource: "tool:x",
			arguments: { a: { b: ["grep shutdown file", "second"] }, c: 5, d: null },
		});
		expect(surface.values).toEqual(["grep shutdown file", "second"]);
	});

	it("keeps the self-destruction face unfiltered while the target face is filtered", () => {
		// `streams`/`values` are what the machine self-destruction rules match on and take every
		// string value; only `targetStreams`, which self-protection and scope read, is filtered by
		// parameter name. `rm -rf /` in a body therefore still reaches the rm-root rule.
		const surface = extractCommandSurface(args("write", { content: "rm -rf /" }));
		expect(surface.values).toEqual(["rm -rf /"]);
		expect(surface.streams.length).toBe(1);
		expect(surface.targetStreams).toEqual([]);
		expect(extractCommandSurface(shell("rm -rf /")).targetStreams.length).toBe(1);
	});

	it("marks a host-named parameter as a declared target and a command-named one as text", () => {
		const host = extractCommandSurface(args("connect", { host: "localhost" }));
		expect(host.targetStreams.map((stream) => stream.declaredTarget)).toEqual([true]);
		const command = extractCommandSurface(shell("ping localhost"));
		expect(command.targetStreams.map((stream) => stream.declaredTarget)).toEqual([false]);
	});

	it("skips wrapper prefixes, leading assignments, and timeout <duration>", () => {
		expect(heads(shell("sudo rm -rf /"))).toContain("rm");
		expect(heads(shell("proxychains4 nmap -p 80 target"))).toContain("nmap");
		expect(heads(shell("FOO=1 rm -rf /"))).toContain("rm");
		expect(heads(shell("env FOO=1 timeout 5 rm -rf /"))).toContain("rm");
		// The assignment value never becomes a command head by itself.
		expect(heads(shell("echo FOO=1"))).toEqual(["echo"]);
	});

	it("extracts sh -c subcommands up to the depth limit and no deeper", () => {
		const depth2 = extractCommandSurface(shell("sh -c \"sh -c 'rm -rf /'\""));
		expect(depth2.streams.length).toBe(3);
		expect(heads(shell("sh -c \"sh -c 'rm -rf /'\""))).toContain("rm");
		const depth3 = extractCommandSurface(shell(String.raw`sh -c "sh -c 'sh -c \"rm -rf /\"'"`));
		expect(depth3.streams.length).toBe(3);
		expect(heads(shell(String.raw`sh -c "sh -c 'sh -c \"rm -rf /\"'"`))).not.toContain("rm");
	});

	it("treats interpreter -c/-e/-r values as script bodies, not subcommands", () => {
		const surface = extractCommandSurface(shell('python -c "import os; rm = 1"'));
		expect(surface.streams.length).toBe(1);
		expect(heads(shell('python -c "import os; rm = 1"'))).toEqual(["python"]);
		expect(surface.values[0]).toContain("import os");
	});
});

describe("extractConnectionTargets: strong evidence", () => {
	it("takes only the authority of a URL, dropping path and query", () => {
		expect(targets(shell("curl http://localhost:8080/admin"))).toEqual(["localhost/strong"]);
		// The redirect target inside the query is payload, so it is not a candidate at any tier.
		expect(targets(shell("curl http://target/redirect?to=http://127.0.0.1/admin"))).toEqual(["target/strong"]);
	});

	it("keeps an IPv6 authority with brackets and port stripped", () => {
		expect(targets(shell("curl 'http://[::1]:8080/x'"))).toEqual(["::1/strong"]);
	});

	it("strips userinfo and port from an authority", () => {
		expect(targets(shell("curl https://user:pass@auth.example.com/x"))).toEqual(["auth.example.com/strong"]);
	});

	it("reads the authority of a real-world scheme URL", () => {
		expect(targets(shell("git clone https://github.com/foo/bar.git"))).toEqual(["github.com/strong"]);
	});

	it("reads -u values as targets (ffuf style) and leaves -w alone", () => {
		// `-w` is neither a data flag nor a target flag in the batch list: it is an unknown flag, so
		// it consumes nothing and its wordlist value is judged as an ordinary bare token — `list.txt`
		// is rejected by the file-suffix rule. The ffuf target still comes out.
		expect(targets(shell("ffuf -u http://target/FUZZ -w list.txt"))).toEqual(["target/strong"]);
	});

	it("takes a bare address after a target flag as strong evidence", () => {
		// The flag is what settles it: `-u` names the connection target, so the value's shape no
		// longer has to carry a scheme for the evidence to be strong.
		expect(targets(shell("curl -u http://127.0.0.1/x"))).toEqual(["127.0.0.1/strong"]);
		expect(targets(shell("ffuf --host 127.0.0.1"))).toEqual(["127.0.0.1/strong"]);
	});

	it("reads the attached --url=value form as a target and keeps only its authority", () => {
		expect(targets(shell("curl --url=http://example.org/a?next=http://localhost"))).toEqual(["example.org/strong"]);
	});

	it("takes the whole value of a host-named parameter as strong evidence", () => {
		// The non-shell analogue of `--host`: the parameter name declares the value to be the target,
		// so a bare `localhost` under `host` is a target, not a mention.
		expect(targets(args("connect", { host: "localhost" }))).toEqual(["localhost/strong"]);
		expect(targets(args("netfetch", { url: "http://localhost:8080/x" }))).toEqual(["localhost/strong"]);
	});
});

describe("extractConnectionTargets: weak evidence", () => {
	it("matches a bare IPv4 token", () => {
		expect(targets(shell("ping 127.0.0.1"))).toEqual(["127.0.0.1/weak"]);
	});

	it("matches a bare IPv6 token, bracketed or plain", () => {
		expect(targets(shell("ping ::1"))).toEqual(["::1/weak"]);
		expect(targets(shell("nc [::1] 4444"))).toEqual(["::1/weak"]);
		expect(targets(shell("curl [::1]:8080/x"))).toEqual(["::1/weak"]);
		expect(targets(shell("ping 2001:db8::1"))).toEqual(["2001:db8::1/weak"]);
	});

	it("does not mistake a time or a key:value pair for an IPv6 token", () => {
		expect(targets(shell("at 12:30 job"))).toEqual([]);
	});

	it("matches a bare domain with a real TLD", () => {
		expect(targets(shell("nmap -p 80 scanme.example.net"))).toEqual(["scanme.example.net/weak"]);
	});

	it("treats a bare localhost argument as a mention of the reserved name, not a connection", () => {
		expect(targets(shell("ping localhost"))).toEqual(["localhost/weak"]);
	});

	it("records the stronger tier when a host is seen both ways", () => {
		// Weak and strong mentions of the same host in one call must not produce two candidates, and
		// the pair must not lose the strength one of them carries.
		expect(targets(shell("grep 127.0.0.1 log; curl http://127.0.0.1/x"))).toEqual(["127.0.0.1/strong"]);
	});

	it("keeps the command-position token in the scan, on the tier its shape earns", () => {
		// A non-shell tool's single-token `url` argument sits at a command position; skipping the
		// position would hide HTTP-request tools' targets. Shell command names match no shape.
		expect(targets(shell("curl -L http://example.com/"))).toEqual(["example.com/strong"]);
		expect(targets(shell("localhost_probe"))).toEqual([]);
	});
});

describe("extractConnectionTargets: data flags never contribute", () => {
	it("drops the -d payload: localhost inside a data value is never a candidate", () => {
		expect(targets(shell(`curl -d '{"u":"http://localhost/admin"}' http://target/`))).toEqual(["target/strong"]);
	});

	it("drops header payloads: -H is data, not a connection target", () => {
		expect(targets(shell("curl -H 'X-Forwarded-For: localhost' http://target/"))).toEqual(["target/strong"]);
	});

	it("drops --data-urlencode, --cookie and --proxy values", () => {
		expect(
			targets(
				shell(
					"curl --data-urlencode 'q=http://localhost/x' --cookie 's=localhost' --proxy 'http://127.0.0.1:8080' example.org",
				),
			),
		).toEqual(["example.org/weak"]);
	});

	it("drops the -F form body but keeps the URL", () => {
		expect(targets(shell("curl -F 'file=@/etc/passwd;type=text/plain' http://target/upload"))).toEqual([
			"target/strong",
		]);
	});

	it("consumes -o's file argument but leaves the following URL visible", () => {
		expect(targets(shell("curl -o out.html http://localhost/x"))).toEqual(["localhost/strong"]);
	});

	it("treats -L as a boolean switch: it must not eat the following target", () => {
		// `curl -L` has no value. Consuming the next token would hide `http://localhost/` from every
		// host rule — a hard-deny bypass, the one direction the data/target split may not cut.
		expect(targets(shell("curl -L http://example.com/"))).toEqual(["example.com/strong"]);
	});

	it("does not mistake curl's -u user:pass credential for a host", () => {
		expect(targets(shell("curl -u user:pass http://target/"))).toEqual(["target/strong"]);
	});
});

describe("extractConnectionTargets: recursion, wrappers, interpreter bodies", () => {
	it("extracts targets inside an sh -c subcommand", () => {
		expect(targets(shell('sh -c "curl http://localhost:8080/"'))).toEqual(["localhost/strong"]);
	});

	it("takes a loopback URL inside a subcommand on strong evidence", () => {
		expect(targets(shell('sh -c "wget http://[::1]/"'))).toEqual(["::1/strong"]);
	});

	it("recurses through the shells added in batch 1b", () => {
		expect(targets(shell("bash -c \"zsh -c 'curl http://10.0.0.1/'\""))).toContain("10.0.0.1/strong");
		expect(targets(shell("ksh -c \"dash -c 'wget http://10.0.0.2/'\""))).toContain("10.0.0.2/strong");
	});

	it("honors the batch 1a depth limit for subcommands", () => {
		expect(targets(shell(String.raw`sh -c "sh -c 'sh -c \"curl http://1.1.1.1/\"'"`))).toEqual([]);
	});

	it("finds the target of a wrapper-wrapped call", () => {
		expect(targets(shell("proxychains4 curl http://1.2.3.4/"))).toEqual(["1.2.3.4/strong"]);
	});

	it("does not parse interpreter -c bodies as command text", () => {
		expect(targets(shell(`python -c "s = 'http://localhost/x'"`))).toEqual([]);
	});

	it("does not treat a filename token as a host", () => {
		expect(targets(shell("cat report.md"))).toEqual([]);
		expect(targets(shell("ls dist/app.bundle.js"))).toEqual([]);
	});

	it("does not treat a schemeless domain-with-path as a bare host (whole-token rule)", () => {
		// Known limitation of the 整 token 匹配 rule in the design: `example.com/path` matches neither
		// the URL shape (no scheme) nor the bare-domain shape (contains `/`).
		expect(targets(shell("curl example.com/path"))).toEqual([]);
	});
});

describe("extractConnectionTargets: parameter-name filter", () => {
	// The same text is placed under different parameter names to isolate the filter from the parser.
	const mention = "grep 127.0.0.1 access.log";

	it("extracts from a command-flavored parameter and not from a detail parameter", () => {
		expect(targets(shell(mention))).toEqual(["127.0.0.1/weak"]);
		// False positive 2, closed: a report body is never a connection target, so writing a report
		// that mentions the loopback address produces no candidate at all.
		expect(targets(args("write", { file_path: "report.md", content: mention }))).toEqual([]);
		expect(targets(args("note", { body: "probe localhost for services" }))).toEqual([]);
		expect(targets(args("search", { pattern: "localhost", query: "127.0.0.1" }))).toEqual([]);
		expect(targets(args("notify", { message: "localhost answered", description: "::1 too" }))).toEqual([]);
	});

	it("produces no candidate for local file paths", () => {
		expect(targets(args("read", { path: "src/index.ts" }))).toEqual([]);
		// The batch 1c false positive: a path that merely contains the reserved name.
		expect(targets(args("read", { path: "/tmp/localhost.log" }))).toEqual([]);
		expect(targets(args("read", { filepath: "C:/localhost/x.txt" }))).toEqual([]);
	});

	it("keeps nested keys under their own verdict", () => {
		expect(targets(args("run", { args: { command: "ping localhost" } }))).toEqual(["localhost/weak"]);
		expect(targets(args("run", { args: { content: "ping localhost" } }))).toEqual([]);
		// An array passes its own key's role down to every element.
		expect(targets(args("run", { commands: ["ping localhost", "curl http://127.0.0.1/x"] }))).toEqual([
			"localhost/weak",
			"127.0.0.1/strong",
		]);
		expect(targets(args("write", { contents: ["localhost", "127.0.0.1"] }))).toEqual([]);
	});

	it("matches parameter names case-insensitively", () => {
		expect(targets(args("run", { Command: "ping localhost" }))).toEqual(["localhost/weak"]);
		expect(targets(args("write", { Content: "localhost" }))).toEqual([]);
		expect(targets(args("connect", { Host: "localhost" }))).toEqual(["localhost/strong"]);
	});

	it("treats an unknown parameter name as command surface, deliberately", () => {
		// The conservative default: a missed real target costs self-protection with no recourse, an
		// over-read detail value costs one forced ask a human can approve.
		expect(targets(args("probe", { payload: "ping 127.0.0.1" }))).toEqual(["127.0.0.1/weak"]);
		expect(targets(args("x", { a: { b: ["mentions localhost here"] } }))).toEqual(["localhost/weak"]);
	});

	it("deduplicates the same authority across commands", () => {
		expect(targets(shell("curl http://target/ ; curl http://target/other"))).toEqual(["target/strong"]);
	});
});

describe("scanTextSurface: the batch 2a text-scan view", () => {
	it("carries every string value, detail keys included", () => {
		// The whole point of the second view: SQL and payload text lives under `query`/`body`/`content`,
		// and the danger set has to see it while the connection-target view stays filtered.
		const view = scanTextSurface(args("sql_exec", { query: "DROP TABLE sessions" }));
		expect(view.strings).toEqual(["DROP TABLE sessions"]);
		expect(scanTextSurface(args("write", { file_path: "notes.md", content: "sudo reboot" })).strings).toEqual([
			"notes.md",
			"sudo reboot",
		]);
	});

	it("pre-splits lowercased command groups at command positions, wrappers skipped", () => {
		// `commands` is finished data: a matcher must not re-implement the split and drift from it.
		const view = scanTextSurface(shell("sudo rm -rf /etc/nginx && Echo Done"));
		expect(view.commands).toEqual([
			{ head: "sudo", tokens: ["sudo"] },
			{ head: "rm", tokens: ["rm", "-rf", "/etc/nginx"] },
			{ head: "echo", tokens: ["echo", "done"] },
		]);
	});

	it("sees the detail-key payload the connection-target view refuses — the view isolation claim", () => {
		const request = args("http_request", { url: "http://target/", body: "next=http://127.0.0.1/admin" });
		expect(scanTextSurface(request).strings).toContain("next=http://127.0.0.1/admin");
		// Same request, other view: `body` is a detail key, so the loopback URL inside it is payload,
		// not a candidate. If this ever returns 127.0.0.1, the two views have been merged back.
		expect(extractConnectionTargets(request).map((target) => `${target.host}/${target.evidence}`)).toEqual([
			"target/strong",
		]);
	});

	it("hands out the same streams the carrier holds, without the target filtering", () => {
		const command = shell('sh -c "rm -rf /"');
		const view = scanTextSurface(command);
		expect(view.streams.length).toBe(extractCommandSurface(command).streams.length);
		expect(view.commands.map((group) => group.head)).toContain("rm");
	});
});
