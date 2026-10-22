import type { Context } from "@OnePanda-TgSec/chord";
import { defineDoc, type JsonObject, type SessionDocToken, type Tx } from "@OnePanda-TgSec/tg-gibraltar";
import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	TG_SPAN_SCHEMA,
} from "@OnePanda-TgSec/tg-telemetry";
import type { TgSecPermissionMode } from "./types.ts";

/** Every mode value, in decision-power order from most to least restrictive. */
export const TG_SEC_MODES: readonly TgSecPermissionMode[] = ["strict", "judge-auto", "auto", "yolo"];

/** The value a session holds before anyone switches: the tools are not open-sourced, the users are professionals. */
export const TG_SEC_DEFAULT_MODE: TgSecPermissionMode = "auto";

/** The persisted shape of `tg.sec.mode`. */
export type TgSecModeValue = { mode: TgSecPermissionMode };

/** Session-scoped persistent document holding the current permission mode; hot-swappable, audited on every switch. */
export const TgSecModeDoc = defineDoc<TgSecModeValue>({
	kind: "tg.sec.mode",
	version: 1,
	scope: "session",
	initial: () => ({ mode: TG_SEC_DEFAULT_MODE }),
});

/**
 * The document read the mode machine needs. A gibraltar `Session` and a `HookApi` both satisfy it
 * through their session-doc `snapshot` overload; tests pass a one-method fake.
 */
export interface TgSecModeReader {
	snapshot<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<Readonly<T> | undefined>;
}

/**
 * The part of a gibraltar `Session` the mode machine writes through: one document read and one
 * commit. A real `Session` satisfies it; tests pass a two-method fake instead of stubbing the
 * whole interface.
 */
export interface TgSecSessionPort extends TgSecModeReader {
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
}

/** Runtime validation of a mode value; everything crossing the document boundary goes through this. */
export function isTgSecMode(value: unknown): value is TgSecPermissionMode {
	return typeof value === "string" && (TG_SEC_MODES as readonly string[]).includes(value);
}

/**
 * Read the session's current mode. An absent document reads as `TG_SEC_DEFAULT_MODE` (the value
 * `initial()` would mint on first creation); a value outside the four modes throws — a corrupt mode
 * document must not silently degrade to permissive.
 */
export async function readTgSecMode(session: TgSecModeReader, context: Context): Promise<TgSecPermissionMode> {
	const value = await session.snapshot(TgSecModeDoc, context);
	if (value === undefined) return TG_SEC_DEFAULT_MODE;
	if (!isTgSecMode(value.mode)) {
		throw new TypeError(
			`tg.sec.mode holds ${JSON.stringify(value.mode)}, which is not one of ${TG_SEC_MODES.join(", ")}`,
		);
	}
	return value.mode;
}

/**
 * Write the session's mode and record the `tg.span.sec.mode` audit span (from, to, actor).
 * Validation is fail-closed: an unknown mode or an empty actor throws before anything is committed.
 */
export async function switchTgSecMode(
	session: TgSecSessionPort,
	mode: TgSecPermissionMode,
	actor: string,
	context: Context,
	telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
): Promise<void> {
	if (!isTgSecMode(mode))
		throw new TypeError(`cannot switch to ${JSON.stringify(mode)}: not one of ${TG_SEC_MODES.join(", ")}`);
	if (actor.trim() === "") throw new TypeError("a mode switch requires a non-empty actor");
	const from = await readTgSecMode(session, context);
	const startSpan = createTypedSpanStarter(telemetry, [TG_SPAN_SCHEMA]);
	await startSpan("tg.span.sec.mode", { from, to: mode, actor }, async () => {
		await session.commit(async (tx) => {
			const doc = await tx.doc(TgSecModeDoc);
			doc.mode = mode;
		}, context);
	});
}
