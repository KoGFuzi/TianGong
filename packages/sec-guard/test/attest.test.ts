import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import type { JsonObject } from "@OnePanda-TgSec/tg-gibraltar";
import { describe, expect, it } from "vitest";
import {
	createTgSecGuard,
	probeForcedAskBlocks,
	probeModeDocument,
	probeRestrictedEnv,
	probeToolSetAlignment,
	runTgSecAttestation,
	type TgSecAttestContext,
	type TgSecDecision,
	type TgSecRequest,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

function eaccesError(): Error & { code: string } {
	const error = new Error("permission denied") as Error & { code: string };
	error.code = "EACCES";
	return error;
}

function askDecision(forced: boolean): TgSecDecision {
	return { effect: "ask", reason: "out of scope", forced };
}

describe("probe 1: restricted env", () => {
	it("passes when the forbidden read is refused with EACCES", async () => {
		const probe = probeRestrictedEnv(async () => {
			throw eaccesError();
		});
		await expect(probe.run()).resolves.toBeUndefined();
	});

	it("fails when the forbidden read succeeds", async () => {
		const probe = probeRestrictedEnv(async () => "contents");
		await expect(probe.run()).rejects.toThrow(/is not in effect/);
	});

	it("fails when the read is refused with any other code", async () => {
		const probe = probeRestrictedEnv(async () => {
			const error = new Error("not found") as Error & { code: string };
			error.code = "ENOENT";
			throw error;
		});
		await expect(probe.run()).rejects.toThrow(/expected an EACCES refusal/);
	});
});

describe("probe 4: tool set alignment", () => {
	it("passes on the same set in any order", async () => {
		await expect(probeToolSetAlignment(["read", "shell"], ["shell", "read"]).run()).resolves.toBeUndefined();
	});

	it("fails when a declared tool is missing", async () => {
		await expect(probeToolSetAlignment(["read"], ["read", "shell"]).run()).rejects.toThrow(/missing: shell/);
	});

	it("fails when an undeclared tool is registered", async () => {
		await expect(probeToolSetAlignment(["read", "shell", "netfetch"], ["read", "shell"]).run()).rejects.toThrow(
			/extra: netfetch/,
		);
	});
});

describe("probe 5: mode document", () => {
	it("passes on each of the four modes", async () => {
		for (const mode of ["strict", "judge-auto", "auto", "yolo"] as const) {
			await expect(probeModeDocument(async () => mode).run()).resolves.toBeUndefined();
		}
	});

	it("fails on a value outside the four modes", async () => {
		await expect(probeModeDocument(async () => "permissive").run()).rejects.toThrow(/not one of the four modes/);
	});

	it("fails when reading the document throws", async () => {
		await expect(
			probeModeDocument(async () => {
				throw new Error("storage closed");
			}).run(),
		).rejects.toThrow("storage closed");
	});
});

describe("probe 7: forced ask fails closed", () => {
	it("passes when a forced ask blocks", async () => {
		await expect(probeForcedAskBlocks(askDecision(true), true).run()).resolves.toBeUndefined();
	});

	it("fails when a forced ask passes", async () => {
		await expect(probeForcedAskBlocks(askDecision(true), false).run()).rejects.toThrow(/must block the call/);
	});

	it("fails when the sample is not a forced ask", async () => {
		await expect(probeForcedAskBlocks(askDecision(false), true).run()).rejects.toThrow(/must force an ask/);
		await expect(probeForcedAskBlocks({ effect: "allow" }, true).run()).rejects.toThrow(/must force an ask/);
	});
});

describe("runTgSecAttestation", () => {
	it("runs every probe when all pass", async () => {
		const seen: string[] = [];
		const probes = ["one", "two"].map((name) => ({
			name,
			run: async () => {
				seen.push(name);
			},
		}));
		await expect(runTgSecAttestation(probes)).resolves.toBeUndefined();
		expect(seen).toEqual(["one", "two"]);
	});

	it("stops at the first failure and names the probe", async () => {
		let ran = 0;
		const probes = [
			{ name: "first", run: async () => {} },
			{
				name: "second",
				run: async () => {
					ran += 1;
					throw new Error("boom");
				},
			},
			{
				name: "third",
				run: async () => {
					ran += 1;
				},
			},
		];
		await expect(runTgSecAttestation(probes)).rejects.toThrow('attestation probe "second" failed: boom');
		expect(ran).toBe(1);
	});
});

describe("guard.attest end to end", () => {
	const DECLARED = ["read", "shell"];

	function attestContext(over: Partial<TgSecAttestContext> = {}): TgSecAttestContext {
		return {
			context,
			modeReader: { snapshot: async <T extends JsonObject>() => ({ mode: "auto" }) as unknown as Readonly<T> },
			forbiddenRead: async () => {
				throw eaccesError();
			},
			registeredTools: DECLARED,
			declaredTools: DECLARED,
			forcedAskSample: { toolName: "netfetch", resource: "tool:netfetch", arguments: { url: "x" } },
			...over,
		};
	}

	/** The out-of-scope resolver makes the sample a forced ask; no ask channel means it blocks. */
	function guarded() {
		return createTgSecGuard({
			mode: "auto",
			scopeResolver: (request: TgSecRequest) =>
				request.toolName === "netfetch" ? { inScope: false } : { inScope: true },
			dangerEvaluator: () => ({ hit: false }),
		});
	}

	it("passes when every probe holds", async () => {
		await expect(guarded().attest(attestContext())).resolves.toBeUndefined();
	});

	it("throws when the tool set drifts (probe 4 negative)", async () => {
		await expect(guarded().attest(attestContext({ registeredTools: ["read"] }))).rejects.toThrow(
			'attestation probe "tool-set-alignment" failed',
		);
	});

	it("throws when the env does not refuse the forbidden read (probe 1 negative)", async () => {
		await expect(guarded().attest(attestContext({ forbiddenRead: async () => "leaked" }))).rejects.toThrow(
			'attestation probe "restricted-env" failed',
		);
	});

	it("throws when the mode document is corrupt (probe 5 negative)", async () => {
		const corrupt = {
			modeReader: { snapshot: async <T extends JsonObject>() => ({ mode: "bogus" }) as unknown as Readonly<T> },
		};
		await expect(guarded().attest(attestContext(corrupt))).rejects.toThrow(
			'attestation probe "mode-document" failed',
		);
	});

	it("the forced-ask probe samples with no ask channel wired (probe 7 wiring)", async () => {
		const decision = await guarded().decisionFor(attestContext().forcedAskSample);
		expect(decision).toEqual({ effect: "ask", reason: "the target is outside the registered scope", forced: true });
		await expect(guarded().attest(attestContext())).resolves.toBeUndefined();
	});

	it("fails when a guard with an ask channel would let the sample through unblocked", async () => {
		const withChannel = createTgSecGuard({
			mode: "auto",
			scopeResolver: () => ({ inScope: false }),
			dangerEvaluator: () => ({ hit: false }),
			askChannel: async () => "allow",
		});
		await expect(withChannel.attest(attestContext())).rejects.toThrow(
			'attestation probe "forced-ask-fails-closed" failed',
		);
	});
});
