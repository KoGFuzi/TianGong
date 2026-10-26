import type { TgSecAskChannel, TgSecAskReply, TgSecDecision, TgSecRequest } from "@OnePanda-TgSec/tg-sec-guard";

/** One guard ask waiting on the operator, oldest first. */
export type TgSecPendingAsk = {
	readonly request: TgSecRequest;
	readonly decision: TgSecDecision & { effect: "ask" };
	readonly resolve: (reply: TgSecAskReply) => void;
};

/**
 * The interactive shell's ask channel. Guard asks arrive from tool tasks (including delegated
 * children), so they are queued rather than rendered inline: the shell shows the oldest one, and
 * every key except the answer is swallowed until it is settled. Closing resolves every pending ask
 * as `deny`, which is the fail-closed answer a disappearing operator deserves.
 */
export type TgSecAskController = {
	readonly ask: TgSecAskChannel;
	pending(): TgSecPendingAsk | undefined;
	readonly queued: number;
	/** Answer the oldest ask; false when none is pending. */
	answer(reply: TgSecAskReply): boolean;
	/** Deny every pending ask; returns how many were settled. */
	denyAll(): number;
	onChange(listener: () => void): () => void;
	close(): void;
};

export function createTgSecAskController(): TgSecAskController {
	const queue: TgSecPendingAsk[] = [];
	const listeners = new Set<() => void>();
	let closed = false;
	const notify = (): void => {
		for (const listener of listeners) listener();
	};
	const ask: TgSecAskChannel = (request, decision) =>
		new Promise<TgSecAskReply>((resolve) => {
			if (closed) {
				resolve("deny");
				return;
			}
			queue.push({ request, decision, resolve });
			notify();
		});
	return {
		ask,
		pending: () => queue[0],
		get queued() {
			return queue.length;
		},
		answer: (reply) => {
			const entry = queue.shift();
			if (entry === undefined) return false;
			entry.resolve(reply);
			notify();
			return true;
		},
		denyAll: () => {
			const entries = queue.splice(0, queue.length);
			for (const entry of entries) entry.resolve("deny");
			if (entries.length > 0) notify();
			return entries.length;
		},
		onChange: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close: () => {
			closed = true;
			const entries = queue.splice(0, queue.length);
			for (const entry of entries) entry.resolve("deny");
			if (entries.length > 0) notify();
		},
	};
}
