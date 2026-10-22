import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import type { JsonObject, Tx } from "@OnePanda-TgSec/tg-gibraltar";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { describe, expect, it } from "vitest";
import {
	isTgSecMode,
	readTgSecMode,
	switchTgSecMode,
	TG_SEC_DEFAULT_MODE,
	TG_SEC_MODES,
	type TgSecSessionPort,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

/** A session fake holding one mode document; `stored` is kept untyped so corrupt values can be written. */
function fakeSession(
	stored: { mode: unknown } | undefined,
): TgSecSessionPort & { stored: { mode: unknown } | undefined } {
	const holder = { stored };
	return Object.assign(holder, {
		snapshot: async <T extends JsonObject>() => holder.stored as unknown as Readonly<T> | undefined,
		commit: async <T>(change: (tx: Tx) => T | Promise<T>) => {
			const tx = {
				doc: async () => {
					if (holder.stored === undefined) holder.stored = { mode: TG_SEC_DEFAULT_MODE };
					return holder.stored;
				},
			};
			const result = await change(tx as unknown as Tx);
			return result;
		},
	});
}

describe("isTgSecMode", () => {
	it("accepts exactly the four modes", () => {
		for (const mode of TG_SEC_MODES) expect(isTgSecMode(mode)).toBe(true);
		expect(isTgSecMode("permissive")).toBe(false);
		expect(isTgSecMode(undefined)).toBe(false);
		expect(isTgSecMode(7)).toBe(false);
	});
});

describe("readTgSecMode", () => {
	it("reads the stored mode", async () => {
		const session = fakeSession({ mode: "strict" });
		await expect(readTgSecMode(session, context)).resolves.toBe("strict");
	});

	it("falls back to the default when the document is absent", async () => {
		const session = fakeSession(undefined);
		await expect(readTgSecMode(session, context)).resolves.toBe(TG_SEC_DEFAULT_MODE);
	});

	it("throws on a value outside the four modes instead of degrading", async () => {
		const session = fakeSession({ mode: "yololo" });
		await expect(readTgSecMode(session, context)).rejects.toThrow(TypeError);
	});
});

describe("switchTgSecMode", () => {
	it("writes the mode document and records the switch span", async () => {
		const session = fakeSession({ mode: "strict" });
		const telemetry = new InMemoryTelemetryContext();
		await switchTgSecMode(session, "auto", "operator-1", context, telemetry);
		expect(session.stored).toEqual({ mode: "auto" });
		const spans = telemetry.getSpans().filter((span) => span.name === "tg.span.sec.mode");
		expect(spans.length).toBe(1);
		expect(spans[0].attributes).toMatchObject({ from: "strict", to: "auto", actor: "operator-1" });
		expect(spans[0].status.status).toBe("ok");
	});

	it("rejects a mode outside the four before committing anything", async () => {
		const session = fakeSession({ mode: "strict" });
		const bogus: string = "yololo";
		await expect(
			switchTgSecMode(session, bogus as typeof TG_SEC_DEFAULT_MODE, "operator-1", context),
		).rejects.toThrow(TypeError);
		expect(session.stored).toEqual({ mode: "strict" });
	});

	it("rejects an empty actor before committing anything", async () => {
		const session = fakeSession({ mode: "strict" });
		await expect(switchTgSecMode(session, "auto", "  ", context)).rejects.toThrow(TypeError);
		expect(session.stored).toEqual({ mode: "strict" });
	});
});
