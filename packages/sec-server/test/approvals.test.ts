import { describe, expect, test } from "vitest";
import { createSecApprovalQueue, summarizeJson } from "../src/index.ts";

const ask = {
	toolName: "bash",
	resource: "tool:bash",
	reason: "the call matches the dangerous-instruction set",
	forced: true,
	args: { command: "mysql -e 'DROP TABLE probe' demo" },
} as const;

describe("createSecApprovalQueue", () => {
	test("parks an ask, notifies subscribers, and resolves the operator's reply", async () => {
		const queue = createSecApprovalQueue();
		const seen: unknown[] = [];
		const unsubscribe = queue.subscribe((pending) => seen.push(pending));

		const answer = queue.ask(ask);
		const pending = queue.pending();
		expect(pending).toEqual([
			{
				id: "ask-1",
				toolName: "bash",
				resource: "tool:bash",
				reason: ask.reason,
				forced: true,
				args: ask.args,
			},
		]);
		expect(seen).toEqual(pending);

		expect(queue.reply("ask-1", "allow")).toBe(true);
		await expect(answer).resolves.toBe("allow");
		expect(queue.pending()).toEqual([]);
		expect(queue.reply("ask-1", "deny")).toBe(false);
		unsubscribe();
	});

	test("summarizes arguments at rest: body-shaped keys are redacted and long strings capped", async () => {
		const queue = createSecApprovalQueue();
		const answer = queue.ask({
			...ask,
			args: {
				command: "http_request",
				body: "A".repeat(400),
				nested: { requestBase64: "QUJD" },
				note: "x".repeat(400),
			},
		});
		const [pending] = queue.pending();
		expect(pending?.args).toEqual({
			command: "http_request",
			body: "[omitted 300 bytes]",
			nested: { requestBase64: "[omitted 3 bytes]" },
			note: `${"x".repeat(299)}…`,
		});
		queue.close();
		await expect(answer).resolves.toBe("deny");
	});

	test("denyAll settles every parked ask and reports the count", async () => {
		const queue = createSecApprovalQueue();
		const first = queue.ask(ask);
		const second = queue.ask({ ...ask, toolName: "read", resource: "tool:read", forced: false });
		expect(queue.pending()).toHaveLength(2);

		expect(queue.denyAll()).toBe(2);
		await expect(first).resolves.toBe("deny");
		await expect(second).resolves.toBe("deny");
		expect(queue.pending()).toEqual([]);
		expect(queue.denyAll()).toBe(0);
	});

	test("close denies pending and future asks", async () => {
		const queue = createSecApprovalQueue();
		const parked = queue.ask(ask);
		queue.close();
		await expect(parked).resolves.toBe("deny");
		await expect(queue.ask(ask)).resolves.toBe("deny");
		expect(queue.pending()).toEqual([]);
	});
});

describe("summarizeJson", () => {
	test("caps depth and turns non-JSON leaves into explicit strings", () => {
		expect(summarizeJson({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({
			a: { b: { c: { d: { e: "[depth limit]" } } } },
		});
		expect(summarizeJson(undefined)).toBe("[undefined]");
		expect(summarizeJson(Number.NaN)).toBe("NaN");
		expect(summarizeJson(10n)).toBe("10n");
		expect(summarizeJson(() => 1)).toBe("[unsupported: function]");
	});

	test("caps arrays and object key counts", () => {
		const array = Array.from({ length: 25 }, (_, index) => index);
		const summarized = summarizeJson(array) as unknown[];
		expect(summarized).toHaveLength(21);
		expect(summarized[20]).toBe("[5 more]");

		const wide = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`k${index}`, index]));
		const summarizedWide = summarizeJson(wide) as Record<string, unknown>;
		expect(Object.keys(summarizedWide)).toHaveLength(41);
		expect(summarizedWide["…"]).toBe("[key limit]");
	});
});
