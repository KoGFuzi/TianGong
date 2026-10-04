import type { JsonValue } from "@OnePanda-TgSec/chord";
import type { CompactionReason, ToolDiagnostic } from "./harness/types.ts";
import type { Entry, EntryRecord, TypedEntry } from "./types.ts";

/** Define a typed entry kind whose `is()` guard narrows by `EntryRecord.kind`. */
export function defineEntry<D extends JsonValue = never>(kind: string): Entry<D> {
	if (typeof kind !== "string" || kind.length === 0) throw new TypeError("Entry kind must be a non-empty string");
	return {
		kind,
		is: (entry: EntryRecord | undefined): entry is TypedEntry<D> => entry !== undefined && entry.kind === kind,
	};
}

/** User input: `model` is `[UserMessage]`. Written by submissions. */
export const UserEntry = defineEntry("tg.user");
/** Provider result with any stop reason: `model` is `[AssistantMessage]`. Written by generation. */
export const AssistantEntry = defineEntry("tg.assistant");
/** Positional prompt and tool change: `model` is `[SystemMessage]` with empty `content`. */
export const SystemEntry = defineEntry("tg.system");
/**
 * Tool result: `model` is `[ToolResultMessage]`, whose content ends with the rendered diagnostics block; `data` holds
 * the structured diagnostics, possibly none. Written by tool tasks, and by generation for calls it did not offer.
 */
export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("tg.tool-result");
/**
 * Start of a new context: always `head: "self"`, with `model` absent for a plain reset or `[UserMessage]` carrying the
 * handoff text. Written by `Conversation.reset()` and the `handoff` tool control.
 */
export const ResetEntry = defineEntry("tg.reset");
/**
 * Compaction summary: `model` is `[UserMessage]` with the wrapped summary, `head` the first kept entry. Written by
 * compaction tasks, directly or through a write submission.
 */
export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("tg.compaction");
