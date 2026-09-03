import { describe, expect, it } from "../bun-test.ts";
import { HarnessHookRegistry } from "../../src/harness/hooks.ts";
import { HarnessEventBus } from "../../src/harness/events.ts";
import { HarnessClosed } from "../../src/harness/agent-harness.ts";

describe("HarnessHookRegistry", () => {
	it("runs handlers in registration order and isolates unsubscribe", async () => {
		const registry = new HarnessHookRegistry();
		const calls: string[] = [];
		const unregisterA = registry.on("before_run", () => {
			calls.push("a");
		});
		registry.on("before_run", () => {
			calls.push("b");
		});

		await registry.run("before_run", {});
		expect(calls).toEqual(["a", "b"]);

		unregisterA();
		await registry.run("before_run", {});
		expect(calls).toEqual(["a", "b", "b"]);
	});

	it("propagates hook results to the caller", async () => {
		const registry = new HarnessHookRegistry();
		registry.on("before_run", (event) => ({ seen: event }));
		const results = await registry.run("before_run", { value: 1 });
		expect(results).toEqual([{ seen: { value: 1 } }]);
	});

	it("rejects registration after close", () => {
		const registry = new HarnessHookRegistry(() => new HarnessClosed());
		registry.close();
		expect(() => registry.on("before_run", () => {})).toThrow(HarnessClosed);
	});
});

describe("HarnessEventBus", () => {
	it("delivers typed events to subscribers and supports unsubscribe", () => {
		const bus = new HarnessEventBus();
		const seen: string[] = [];
		const unsubscribe = bus.on("run_start", (event) => {
			seen.push(event.runId);
		});

		bus.emit({ type: "run_start", lane: "main", runId: "r1" });
		unsubscribe();
		bus.emit({ type: "run_start", lane: "main", runId: "r2" });
		expect(seen).toEqual(["r1"]);
	});

	it("buffers watch events until start is called", () => {
		const bus = new HarnessEventBus();
		const watch = bus.watch(() => ({ lane: "main" }));
		bus.emit({ type: "run_start", lane: "main", runId: "buffered" });

		const received: string[] = [];
		watch.start((event) => {
			if (event.type === "run_start") received.push(event.runId);
		});
		bus.emit({ type: "run_start", lane: "main", runId: "live" });

		expect(received).toEqual(["buffered", "live"]);
		watch.unsubscribe();
	});

	it("rejects registration after close", () => {
		const bus = new HarnessEventBus(() => new HarnessClosed());
		bus.close();
		expect(() => bus.on("run_start", () => {})).toThrow(HarnessClosed);
	});
});
