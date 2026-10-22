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
});

describe("localInterfaceAddresses", () => {
	it("returns an array of address strings", () => {
		const addresses = localInterfaceAddresses();
		expect(Array.isArray(addresses)).toBe(true);
		for (const address of addresses) expect(typeof address).toBe("string");
	});
});
