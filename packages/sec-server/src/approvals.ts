import type { JsonValue } from "@OnePanda-TgSec/chord";
import type { SecAskReply } from "./contract.ts";
import { summarizeJson } from "./projector.ts";

/** One guard escalation as the host hands it over; `args` is the raw tool-call argument tree. */
export type SecApprovalRequest = {
	readonly toolName: string;
	readonly resource: string;
	readonly reason: string;
	readonly forced: boolean;
	readonly args: unknown;
};

/** One escalation waiting on the operator, shaped for the `ask` frame. */
export type SecPendingApproval = {
	readonly id: string;
	readonly toolName: string;
	readonly resource: string;
	readonly reason: string;
	readonly forced: boolean;
	readonly args: JsonValue;
};

/**
 * The operator approval queue behind the WebUI. The host (sec-agent) creates it, adapts the
 * guard's ask channel onto `ask`, and hands the same object to the server; the server broadcasts
 * pending entries and resolves them from `ask_reply` frames. It deliberately knows nothing about
 * sec-guard: the guard semantics of `always` stay inside the guard, which is the only caller.
 *
 * Closing resolves every pending ask as `deny` and makes every later ask resolve `deny` at once.
 * That is the fail-closed answer for a sidecar that disappeared while a tool call was waiting.
 */
export type SecApprovalQueue = {
	/** Park `request` until an operator replies; resolves `deny` when the queue is closed. */
	ask(request: SecApprovalRequest): Promise<SecAskReply>;
	/** Resolve one pending ask; false when the id is unknown or already settled. */
	reply(id: string, reply: SecAskReply): boolean;
	pending(): readonly SecPendingApproval[];
	/** Deny every pending ask; returns how many were settled. */
	denyAll(): number;
	close(): void;
	/** Subscribe to newly parked asks; the returned function unsubscribes. */
	subscribe(listener: (pending: SecPendingApproval) => void): () => void;
};

type Entry = {
	readonly pending: SecPendingApproval;
	readonly resolve: (reply: SecAskReply) => void;
};

export function createSecApprovalQueue(): SecApprovalQueue {
	const entries = new Map<string, Entry>();
	const listeners = new Set<(pending: SecPendingApproval) => void>();
	let sequence = 0;
	let closed = false;
	const notify = (pending: SecPendingApproval): void => {
		for (const listener of listeners) {
			try {
				listener(pending);
			} catch {
				// A broken transport must not keep another ask from being broadcast.
			}
		}
	};
	return {
		ask: (request) =>
			new Promise<SecAskReply>((resolve) => {
				if (closed) {
					resolve("deny");
					return;
				}
				sequence += 1;
				const pending: SecPendingApproval = {
					id: `ask-${sequence}`,
					toolName: request.toolName,
					resource: request.resource,
					reason: request.reason,
					forced: request.forced,
					args: summarizeJson(request.args),
				};
				entries.set(pending.id, { pending, resolve });
				notify(pending);
			}),
		reply: (id, reply) => {
			const entry = entries.get(id);
			if (entry === undefined) return false;
			entries.delete(id);
			entry.resolve(reply);
			return true;
		},
		pending: () => [...entries.values()].map((entry) => entry.pending),
		denyAll: () => {
			const settled = [...entries.values()];
			entries.clear();
			for (const entry of settled) entry.resolve("deny");
			return settled.length;
		},
		close: () => {
			closed = true;
			const settled = [...entries.values()];
			entries.clear();
			for (const entry of settled) entry.resolve("deny");
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
