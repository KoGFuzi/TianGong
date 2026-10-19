/**
 * Bounded undo stack.
 *
 * Callers push snapshots that are already detached from live state; the stack stores and pops
 * them as-is. Strings are immutable and safe to share across snapshots, so detaching is a shallow
 * copy of the mutable container, not a deep clone. `push` drops the oldest snapshot past the
 * capacity so a long session cannot grow the stack without bound.
 */
export class UndoStack<S> {
	static readonly DEFAULT_CAPACITY = 200;

	private readonly stack: S[] = [];
	private readonly capacity: number;

	constructor(capacity: number = UndoStack.DEFAULT_CAPACITY) {
		this.capacity = capacity;
	}

	/** Store a detached snapshot, evicting the oldest one over capacity. */
	push(state: S): void {
		this.stack.push(state);
		if (this.stack.length > this.capacity) {
			this.stack.shift();
		}
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
