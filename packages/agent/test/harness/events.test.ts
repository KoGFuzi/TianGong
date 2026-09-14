import { describe, expect, it } from "bun:test";
import { HarnessEventBus } from "../../src/harness/events.ts";
import type { HarnessEvent } from "../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";

const runStartEvent: HarnessEvent = {
	type: "run_start",
	lane: "main",
	runId: "run-1",
	startedAt: 0,
};

const runEndEvent: HarnessEvent = {
	type: "run_end",
	lane: "main",
	runId: "run-1",
	fromTipId: null,
	tipId: "entry-1",
	endedAt: 0,
	status: "completed",
};

describe("HarnessEventBus", () => {
	it("delivers matching events to direct listeners and watchers", async () => {
		const events = new HarnessEventBus();
		const direct: HarnessEvent[] = [];
		const watchEvents: HarnessEvent[] = [];
		const off = events.on("run_start", (event) => {
			direct.push(event);
		});
		const watch = events.watch(null, () => true, BACKGROUND_CONTEXT);
		watch.start((event) => {
			watchEvents.push(event);
		});

		await events.emit(runStartEvent, BACKGROUND_CONTEXT);
		await events.emit(runEndEvent, BACKGROUND_CONTEXT);
		off();
		await events.emit(runStartEvent, BACKGROUND_CONTEXT);

		expect(direct).toEqual([runStartEvent]);
		expect(watchEvents).toEqual([runStartEvent, runEndEvent, runStartEvent]);
	});

	it("captures a snapshot without an event gap, then flushes buffered events on start", async () => {
		const events = new HarnessEventBus();
		const expectedSnapshot = { leafId: null };
		// Events emitted while the snapshot is being captured are buffered, never delivered early.
		const watch = await events.watchFromSnapshot(async () => {
			await events.emit(runStartEvent, BACKGROUND_CONTEXT);
			return expectedSnapshot;
		}, () => true, BACKGROUND_CONTEXT);
		const received: HarnessEvent[] = [];

		expect(watch.snapshot).toBe(expectedSnapshot);

		watch.start((event) => {
			received.push(event);
		});
		await events.emit(runEndEvent, BACKGROUND_CONTEXT);
		expect(received).toEqual([runStartEvent, runEndEvent]);

		watch.unsubscribe();
		await events.emit(runStartEvent, BACKGROUND_CONTEXT);
		expect(received).toEqual([runStartEvent, runEndEvent]);
	});
});
