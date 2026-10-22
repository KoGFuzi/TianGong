import { describe, expect, it } from "vitest";
import {
	evaluateHardDeny,
	evaluateWeakSelfProtection,
	localInterfaceAddresses,
	type TgSecHardDenyHit,
	type TgSecRequest,
	type TgSecWeakSelfProtectionHit,
} from "../src/index.ts";

function shell(command: string): TgSecRequest {
	return { toolName: "shell", resource: "tool:shell", arguments: { command } };
}

/** One named argument, the shape a non-shell tool call arrives in. */
function args(toolName: string, arguments_: Record<string, unknown>): TgSecRequest {
	return { toolName, resource: `tool:${toolName}`, arguments: arguments_ };
}

/** Asserts that the request is hard-denied and returns the hit, so each case can name the rule. */
function denyHit(request: TgSecRequest, hostAddresses: readonly string[] = []): TgSecHardDenyHit {
	const hit = evaluateHardDeny(request, hostAddresses);
	if (hit === undefined) throw new Error(`expected a hard-deny hit for ${request.toolName}, got none`);
	return hit;
}

/** The same for the weak-evidence half: asserts there is an ask to report and returns it. */
function weakHit(request: TgSecRequest, hostAddresses: readonly string[] = []): TgSecWeakSelfProtectionHit {
	const hit = evaluateWeakSelfProtection(request, hostAddresses);
	if (hit === undefined) throw new Error(`expected a weak-evidence self-protection hit for ${request.toolName}`);
	return hit;
}

describe("evaluateHardDeny", () => {
	it("refuses loopback targets on every strong surface", () => {
		expect(denyHit(shell("curl http://localhost:8080/admin")).ruleId).toBe("self-protection.loopback-hostname");
		// `-u` is a target flag, so its value is a target whatever its shape (batch 1c tier rule).
		expect(denyHit(shell("curl -u http://127.0.0.1/x")).ruleId).toBe("self-protection.loopback-v4");
		expect(denyHit(shell("curl 'http://[::1]:8080/x'")).ruleId).toBe("self-protection.loopback-v6");
		expect(denyHit(shell('sh -c "wget http://[::1]/"')).ruleId).toBe("self-protection.loopback-v6");
	});

	it("refuses this machine's own interface addresses when they are declared targets", () => {
		expect(denyHit(shell("curl http://192.168.1.5/srv"), ["192.168.1.5", "10.0.0.1"]).ruleId).toBe(
			"self-protection.local-interface",
		);
		expect(denyHit(args("connect", { host: "10.0.0.1" }), ["10.0.0.1"]).ruleId).toBe(
			"self-protection.local-interface",
		);
	});

	it("refuses machine self-destruction", () => {
		expect(denyHit(shell("rm -rf /")).ruleId).toBe("self-destruction.rm-root");
		expect(denyHit(shell("rm -rf / --no-preserve-root")).ruleId).toBe("self-destruction.rm-root");
		expect(denyHit(shell("mkfs.ext4 /dev/sda1")).ruleId).toBe("self-destruction.mkfs");
		expect(denyHit(shell("dd if=/dev/zero of=/dev/sda bs=1M")).ruleId).toBe("self-destruction.dd-device");
		expect(denyHit(shell(":(){ :|:& };:")).ruleId).toBe("self-destruction.fork-bomb");
		expect(denyHit(shell("shutdown -h now")).ruleId).toBe("self-destruction.power");
		expect(denyHit(shell("reboot")).ruleId).toBe("self-destruction.power");
		expect(denyHit(shell("poweroff")).ruleId).toBe("self-destruction.power");
	});

	it("lets ordinary calls through", () => {
		expect(evaluateHardDeny(shell("ls -la /tmp"), [])).toBeUndefined();
		expect(evaluateHardDeny(shell("rm -rf build"), [])).toBeUndefined();
		expect(evaluateHardDeny(shell("rm -rf /home/user/scratch"), [])).toBeUndefined();
		expect(evaluateHardDeny(shell("cat /etc/hostname"), [])).toBeUndefined();
		expect(
			evaluateHardDeny({ toolName: "read", resource: "tool:read", arguments: { path: "src/index.ts" } }, []),
		).toBeUndefined();
	});

	it("never puts request text into the reason", () => {
		const hit = denyHit(shell("rm -rf / top-secret-token"));
		expect(hit.reason).not.toContain("top-secret-token");
		expect(hit.reason).not.toContain("rm ");
	});

	it("is the first layer: the hit wins on the earliest matching family", () => {
		expect(denyHit(shell("curl http://localhost && rm -rf /")).ruleId).toBe("self-protection.loopback-hostname");
		// A weak mention does not win that race any more: it is not a deny at all, so the self-destruction
		// rule is what the request hits. This is the tier split doing its job, not a reordering.
		expect(denyHit(shell("curl localhost && rm -rf /")).ruleId).toBe("self-destruction.rm-root");
	});

	it("defect 1: nested quoting no longer hides rm-root or dd-device", () => {
		// The serialized match surface saw `\"rm` and cut the `of=` field at the escaped quote;
		// matching on the unserialized string value removes both failure modes.
		expect(denyHit(shell('sh -c "rm -rf /"')).ruleId).toBe("self-destruction.rm-root");
		expect(denyHit(shell('bash -c "dd if=/dev/zero of=/dev/sda"')).ruleId).toBe("self-destruction.dd-device");
	});

	it("defect 2: self-destruction rules match command positions only", () => {
		expect(evaluateHardDeny(shell("grep shutdown /var/log/messages"), [])).toBeUndefined();
		expect(evaluateHardDeny(shell("curl http://1.2.3.4/api/shutdown"), [])).toBeUndefined();
		expect(evaluateHardDeny(shell("cat mkfs.ext4.8.gz"), [])).toBeUndefined();
		expect(denyHit(shell("shutdown -h now")).ruleId).toBe("self-destruction.power");
		expect(denyHit(shell("sudo reboot")).ruleId).toBe("self-destruction.power");
		expect(denyHit(shell("proxychains4 mkfs.ext4 /dev/sdb1")).ruleId).toBe("self-destruction.mkfs");
	});

	it("rm of the home directory hits self-destruction.rm-home", () => {
		expect(denyHit(shell("rm -rf ~")).ruleId).toBe("self-destruction.rm-home");
		expect(denyHit(shell("rm -rf $HOME")).ruleId).toBe("self-destruction.rm-home");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${HOME} is the literal match target of the rm-home rule, not an interpolation
		expect(denyHit(shell('rm -rf "${HOME}"')).ruleId).toBe("self-destruction.rm-home");
		expect(denyHit(shell('sh -c "rm -rf ~"')).ruleId).toBe("self-destruction.rm-home");
		expect(evaluateHardDeny(shell("rm -rf ./build"), [])).toBeUndefined();
	});

	it("defect 2 boundary: self-protection keeps target semantics, not command positions", () => {
		expect(denyHit(shell("curl http://localhost:8080/")).ruleId).toBe("self-protection.loopback-hostname");
	});
});

describe("self-protection matches connection targets only (batch 1b)", () => {
	it("lets an SSRF payload in a data flag through", () => {
		expect(evaluateHardDeny(shell(`curl -d '{"u":"http://localhost/admin"}' http://target/`), [])).toBeUndefined();
	});

	it("lets a localhost mention in a header through", () => {
		expect(evaluateHardDeny(shell("curl -H 'X-Forwarded-For: localhost' http://target/"), [])).toBeUndefined();
	});

	it("lets a redirect payload in the URL path through", () => {
		expect(evaluateHardDeny(shell("curl 'http://target/redirect?to=http://127.0.0.1/admin'"), [])).toBeUndefined();
	});

	it("still denies a direct loopback target", () => {
		expect(denyHit(shell("curl http://localhost:8080/")).ruleId).toBe("self-protection.loopback-hostname");
	});

	it("still denies a loopback target reached through boolean flags", () => {
		expect(denyHit(shell("curl -sSL http://127.0.0.1/admin")).ruleId).toBe("self-protection.loopback-v4");
	});

	it("still denies a local interface address that is a declared target", () => {
		expect(denyHit(shell("nc -e /bin/sh --url 10.0.0.1 4444"), ["10.0.0.1"]).ruleId).toBe(
			"self-protection.local-interface",
		);
	});
});

describe("self-protection splits on evidence tier (batch 1c)", () => {
	it("does not hard deny a loopback mention in a command that never connects", () => {
		// False positive 1, closed: `grep` reads a file, it does not open a connection. Hard deny has no
		// appeal channel, so a bare token that merely has the shape of a loopback address may not deny;
		// the guard chain turns it into a forced ask (see guard.test.ts).
		expect(evaluateHardDeny(shell("grep 127.0.0.1 access.log"), [])).toBeUndefined();
		expect(weakHit(shell("grep 127.0.0.1 access.log"), [])).toEqual({
			ruleId: "self-protection.loopback-v4",
			host: "127.0.0.1",
			reason: expect.stringContaining("weak evidence"),
		});
	});

	it("does not hard deny a loopback mention in a written report body", () => {
		// False positive 2, the more severe one, closed by the parameter-name filter instead of by the
		// tier: a detail parameter produces no candidate at any tier, so neither a deny nor an ask.
		const report = args("write", { file_path: "report.md", content: "scanned localhost and 127.0.0.1" });
		expect(evaluateHardDeny(report, [])).toBeUndefined();
		expect(evaluateWeakSelfProtection(report, [])).toBeUndefined();
	});

	it("downgrades a bare local interface address to the ask half", () => {
		// `nc 192.168.1.5 4444` names the address as a positional argument, which is exactly the shape a
		// log line or a grep pattern has, so it is weak; the injected address list still recognizes it.
		expect(evaluateHardDeny(shell("nc 192.168.1.5 4444"), ["192.168.1.5"])).toBeUndefined();
		expect(weakHit(shell("nc 192.168.1.5 4444"), ["192.168.1.5"]).ruleId).toBe("self-protection.local-interface");
	});

	it("keeps the two tiers apart: the same host is denied once, asked once, never both", () => {
		const strong = shell("curl http://localhost/x");
		expect(evaluateHardDeny(strong, [])?.ruleId).toBe("self-protection.loopback-hostname");
		expect(evaluateWeakSelfProtection(strong, [])).toBeUndefined();
		const weak = shell("ping localhost");
		expect(evaluateHardDeny(weak, [])).toBeUndefined();
		expect(weakHit(weak, []).ruleId).toBe("self-protection.loopback-hostname");
	});

	it("asks on a bare IPv6 loopback mention", () => {
		expect(evaluateHardDeny(shell("ping ::1"), [])).toBeUndefined();
		expect(weakHit(shell("ping ::1"), []).ruleId).toBe("self-protection.loopback-v6");
	});

	it("leaves non-loopback candidates to the scope resolver", () => {
		expect(evaluateWeakSelfProtection(shell("nmap -p 80 203.0.113.9"), ["192.168.1.5"])).toBeUndefined();
	});
});

describe("machine self-destruction ignores the parameter-name filter (batch 1c)", () => {
	it("denies rm -rf / wherever the parameter name put it", () => {
		// Deliberate: the filter bounds connection-target extraction only. A destroyed root is
		// unappealable either way, and the command-position requirement — not the filter — is what keeps
		// a mention (`grep "rm -rf /" notes.txt`, whose `grep` head is not an `rm`) out of this set.
		expect(denyHit(args("write", { content: "rm -rf /" }), []).ruleId).toBe("self-destruction.rm-root");
		expect(denyHit(args("note", { body: "sudo reboot" }), []).ruleId).toBe("self-destruction.power");
		expect(denyHit(args("write", { path: "x", contents: ["mkfs.ext4 /dev/sda1"] }), []).ruleId).toBe(
			"self-destruction.mkfs",
		);
	});

	it("denies a fork bomb in a detail parameter, which matches whole values by shape", () => {
		expect(denyHit(args("write", { content: ":(){ :|:& };:" }), []).ruleId).toBe("self-destruction.fork-bomb");
	});

	it("still refuses a mention of a self-destruction command that is not at a command position", () => {
		expect(evaluateHardDeny(args("write", { content: "grep rm -rf / over the notes" }), [])).toBeUndefined();
	});
});

describe("dd device targets keep only the destructive half", () => {
	it("lets the /dev/null sink through (standard benchmark, no destructive effect)", () => {
		expect(evaluateHardDeny(shell("dd if=/dev/zero of=/dev/null bs=1M count=1024"), [])).toBeUndefined();
	});

	it("lets an /dev/zero output through (writing zeros to zero overwrites nothing)", () => {
		expect(evaluateHardDeny(shell("dd if=/dev/urandom of=/dev/zero"), [])).toBeUndefined();
	});

	it("still denies a real device target", () => {
		expect(denyHit(shell("dd if=/dev/zero of=/dev/sda bs=1M")).ruleId).toBe("self-destruction.dd-device");
		expect(denyHit(shell("dd of=/dev/nvme0n1")).ruleId).toBe("self-destruction.dd-device");
	});

	it("still denies a real device target inside a subcommand", () => {
		expect(denyHit(shell('bash -c "dd if=/dev/zero of=/dev/sda"')).ruleId).toBe("self-destruction.dd-device");
	});
});

describe("localInterfaceAddresses", () => {
	it("returns an array of address strings", () => {
		const addresses = localInterfaceAddresses();
		expect(Array.isArray(addresses)).toBe(true);
		for (const address of addresses) expect(typeof address).toBe("string");
	});
});
