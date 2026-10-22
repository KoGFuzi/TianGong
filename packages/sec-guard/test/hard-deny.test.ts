import { describe, expect, it } from "vitest";
import { evaluateHardDeny, localInterfaceAddresses, type TgSecHardDenyHit, type TgSecRequest } from "../src/index.ts";

function shell(command: string): TgSecRequest {
	return { toolName: "shell", resource: "tool:shell", arguments: { command } };
}

/** Asserts that the request is hard-denied and returns the hit, so each case can name the rule. */
function denyHit(request: TgSecRequest, hostAddresses: readonly string[] = []): TgSecHardDenyHit {
	const hit = evaluateHardDeny(request, hostAddresses);
	if (hit === undefined) throw new Error(`expected a hard-deny hit for ${request.toolName}, got none`);
	return hit;
}

describe("evaluateHardDeny", () => {
	it("refuses loopback targets on every surface", () => {
		expect(denyHit(shell("curl http://localhost:8080/admin")).ruleId).toBe("self-protection.loopback-hostname");
		expect(denyHit(shell("ping 127.0.0.1")).ruleId).toBe("self-protection.loopback-v4");
		expect(denyHit(shell("curl 'http://[::1]:8080/x'")).ruleId).toBe("self-protection.loopback-v6");
	});

	it("refuses this machine's own interface addresses", () => {
		expect(denyHit(shell("ssh 192.168.1.5 rm -r /srv"), ["192.168.1.5", "10.0.0.1"]).ruleId).toBe(
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
		expect(denyHit(shell("curl localhost && rm -rf /")).ruleId).toBe("self-protection.loopback-hostname");
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

	it("still denies a local interface address that is a connection target", () => {
		expect(denyHit(shell("nc -e /bin/sh 10.0.0.1 4444"), ["10.0.0.1"]).ruleId).toBe(
			"self-protection.local-interface",
		);
	});

	it("denies a bare loopback mention outside a data flag, by the extraction rule as written", () => {
		// `grep 127.0.0.1 access.log` is hard-denied because the extraction rule puts every bare,
		// non-data-flag token into the candidate set. Asserted as-is; see the batch report.
		expect(denyHit(shell("grep 127.0.0.1 access.log"), []).ruleId).toBe("self-protection.loopback-v4");
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
