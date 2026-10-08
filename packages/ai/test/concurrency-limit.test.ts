import { describe, expect, it } from "vitest";
import { ConcurrencyLimitError, ConcurrencyLimiter } from "../src/utils/concurrency-limit.ts";

/** A promise whose settlement the test controls, so in-flight windows are observable. */
function gate(): { promise: Promise<string>; open: (value: string) => void; fail: (error: Error) => void } {
	let open!: (value: string) => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<string>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { fail, open, promise };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ConcurrencyLimiter", () => {
	it("admits up to the limit and rejects the one past it", async () => {
		const limiter = new ConcurrencyLimiter({ limit: 2 });
		const first = gate();
		const second = gate();

		const running = [limiter.run("openai", () => first.promise), limiter.run("openai", () => second.promise)];
		await tick();
		expect(limiter.inFlight("openai")).toBe(2);

		await expect(limiter.run("openai", async () => "never")).rejects.toBeInstanceOf(ConcurrencyLimitError);

		first.open("a");
		second.open("b");
		await expect(Promise.all(running)).resolves.toEqual(["a", "b"]);
		expect(limiter.inFlight("openai")).toBe(0);
	});

	it("reports the provider and limit on rejection", async () => {
		const limiter = new ConcurrencyLimiter({ limit: 1 });
		const held = gate();
		const running = limiter.run("anthropic", () => held.promise);
		await tick();

		const error = await limiter.run("anthropic", async () => "never").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ConcurrencyLimitError);
		expect((error as ConcurrencyLimitError).providerId).toBe("anthropic");
		expect((error as ConcurrencyLimitError).limit).toBe(1);

		held.open("done");
		await running;
	});

	it("frees the slot when the operation rejects", async () => {
		const limiter = new ConcurrencyLimiter({ limit: 1 });
		await expect(
			limiter.run("openai", async () => {
				throw new Error("upstream 500");
			}),
		).rejects.toThrow("upstream 500");
		expect(limiter.inFlight("openai")).toBe(0);

		await expect(limiter.run("openai", async () => "recovered")).resolves.toBe("recovered");
	});

	it("frees the slot when the caller's signal aborts mid-flight", async () => {
		const limiter = new ConcurrencyLimiter({ limit: 1 });
		const held = gate();
		const controller = new AbortController();
		const running = limiter.run("openai", () => held.promise, controller.signal);
		await tick();
		expect(limiter.inFlight("openai")).toBe(1);

		controller.abort();
		await expect(running).rejects.toThrow();
		await tick();
		expect(limiter.inFlight("openai")).toBe(0);

		held.open("late");
		await expect(limiter.run("openai", async () => "next")).resolves.toBe("next");
	});

	it("keeps buckets independent so one saturated provider cannot starve another", async () => {
		const limiter = new ConcurrencyLimiter({ limit: 1 });
		const held = gate();
		const running = limiter.run("openai", () => held.promise);
		await tick();

		await expect(limiter.run("openai", async () => "never")).rejects.toBeInstanceOf(ConcurrencyLimitError);
		await expect(limiter.run("anthropic", async () => "unaffected")).resolves.toBe("unaffected");

		held.open("done");
		await running;
	});

	it("runs everything when the limit is zero", async () => {
		const limiter = new ConcurrencyLimiter({ limit: 0 });
		const gates = [gate(), gate(), gate()];
		const running = gates.map((entry) => limiter.run("openai", () => entry.promise));
		await tick();
		expect(limiter.inFlight("openai")).toBe(0);

		gates[0]?.open("a");
		gates[1]?.open("b");
		gates[2]?.open("c");
		await expect(Promise.all(running)).resolves.toEqual(["a", "b", "c"]);
	});

	it("treats a negative limit as unlimited", async () => {
		const limiter = new ConcurrencyLimiter({ limit: -1 });
		await expect(limiter.run("openai", async () => "ok")).resolves.toBe("ok");
	});

	it("does not admit a call whose signal is already aborted", async () => {
		const limiter = new ConcurrencyLimiter({ limit: 4 });
		const controller = new AbortController();
		controller.abort();
		await expect(limiter.run("openai", async () => "never", controller.signal)).rejects.toThrow();
		expect(limiter.inFlight("openai")).toBe(0);
	});

	it("never exceeds the limit under a burst", async () => {
		const limit = 4;
		const limiter = new ConcurrencyLimiter({ limit });
		let peak = 0;
		let active = 0;

		await Promise.all(
			Array.from({ length: 40 }, async () => {
				try {
					await limiter.run("openai", async () => {
						active++;
						peak = Math.max(peak, active);
						await new Promise((resolve) => setTimeout(resolve, 1));
						active--;
					});
				} catch {
					// Over the limit: rejected by design.
				}
			}),
		);

		expect(peak).toBe(limit);
		expect(limiter.inFlight("openai")).toBe(0);
	});
});
