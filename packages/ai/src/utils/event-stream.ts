import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import { Cause, Effect, Queue, Stream } from "effect";

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private readonly queue = Effect.runSync(Queue.unbounded<T, void | Cause.Done<void>>());
	private readonly stream = Stream.fromQueue(this.queue);
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		Queue.offerUnsafe(this.queue, event);

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
			Queue.endUnsafe(this.queue);
		}
	}

	end(result?: R): void {
		if (this.done) return;
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		Queue.endUnsafe(this.queue);
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return Stream.toAsyncIterable(this.stream)[Symbol.asyncIterator]();
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
