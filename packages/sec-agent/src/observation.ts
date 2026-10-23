import type { Context } from "@OnePanda-TgSec/chord";
import {
	type AgentEvent,
	type AgentEventStream,
	type ConversationId,
	type Harness,
	type SnapshotEvent,
	watchEvents,
} from "@OnePanda-TgSec/tg-gibraltar";

/** One downstream consumer of the folded event stream. */
export type SecEventListener = (events: readonly AgentEvent[], context: Context) => void | Promise<void>;

/** The open work a snapshot frame implies: the live state a fresh consumer must not double-count. */
export type SecOpenState = {
	readonly runOpen: boolean;
	readonly messageOpen: boolean;
	readonly openToolCalls: readonly string[];
};

/**
 * The turn tracker (legacy P0-1). A `snapshot` event is a folding frame: watch overflow replaces
 * undelivered batches with it, so everything the listener missed must be reconstructible from the
 * snapshot alone. The tracker keeps the open-work view — run in flight, assistant partial streaming,
 * tools running — and replaces it wholesale on a snapshot instead of patching it, so a fold can
 * neither lose an open turn nor leak one that already ended.
 */
export type SecTurnTracker = {
	observe(event: AgentEvent): void;
	state(): SecOpenState;
};

export function createSecTurnTracker(): SecTurnTracker {
	let runOpen = false;
	let messageOpen = false;
	const openTools = new Set<string>();
	const fold = (snapshot: SnapshotEvent): void => {
		runOpen = snapshot.run !== undefined;
		messageOpen = snapshot.generation?.message !== undefined;
		openTools.clear();
		for (const slot of snapshot.tools) {
			if (slot.status === "running") openTools.add(slot.callId);
		}
	};
	return {
		observe(event) {
			switch (event.type) {
				case "snapshot":
					fold(event);
					return;
				case "run_start":
					runOpen = true;
					return;
				case "run_end":
					runOpen = false;
					return;
				case "message_start":
					if (event.message.role === "assistant") messageOpen = true;
					return;
				case "message_end":
					messageOpen = false;
					return;
				case "tool_execution_start":
					openTools.add(event.toolCallId);
					return;
				case "tool_execution_end":
					openTools.delete(event.toolCallId);
					return;
			}
		},
		state: () => ({ runOpen, messageOpen, openToolCalls: [...openTools] }),
	};
}

export type WatchSecEventsOptions = {
	harness: Harness;
	conversationId: ConversationId;
	context: Context;
	/** One failing consumer must never stop the watch (legacy P0-2); the error lands here too. */
	onError?: (error: unknown) => void;
};

/** The wrapped stream: same lifecycle as `AgentEventStream`, plus the tracker and the error sink. */
export type SecObservation = {
	readonly snapshot: SnapshotEvent;
	readonly stream: AgentEventStream;
	readonly errors: readonly unknown[];
	/** Register consumers before `start()`. A throw inside one is caught and recorded; the others still run. */
	on(listener: SecEventListener): void;
	start(): void;
	stop(): Promise<void>;
	closed: Promise<unknown>;
	/** The open-work view, folded through snapshot frames. */
	state(): SecOpenState;
};

/**
 * `watchEvents` with the two fixes the legacy observation loop earned its rules for: a listener that
 * throws is isolated per listener (P0-2 — one broken consumer used to kill the whole watch), and
 * every batch passes through a turn tracker that folds snapshot frames instead of ignoring them
 * (P0-1 — an overflow snapshot left unclosed turns in the old consumer's state).
 */
export async function watchSecEvents(options: WatchSecEventsOptions): Promise<SecObservation> {
	const stream = await watchEvents(options.harness, options.conversationId, options.context);
	const listeners: SecEventListener[] = [];
	const tracker = createSecTurnTracker();
	const errors: unknown[] = [];
	const record = (error: unknown): void => {
		errors.push(error);
		options.onError?.(error);
	};
	tracker.observe(stream.snapshot);
	return {
		snapshot: stream.snapshot,
		stream,
		get errors() {
			return errors;
		},
		on: (listener) => {
			listeners.push(listener);
		},
		start: () => {
			stream.start(async (events, context) => {
				for (const event of events) tracker.observe(event);
				for (const listener of listeners) {
					try {
						await listener(events, context);
					} catch (error) {
						record(error);
					}
				}
			});
		},
		stop: async () => {
			await stream.stop();
		},
		closed: stream.closed,
		state: () => tracker.state(),
	};
}
