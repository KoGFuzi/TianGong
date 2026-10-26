import type { TgSecDecision, TgSecRequest } from "@OnePanda-TgSec/tg-sec-guard";
import { describe, expect, it } from "vitest";
import { createTgSecAskController } from "../src/tui/ask.ts";

const request: TgSecRequest = { toolName: "bash", resource: "tool:bash", arguments: { command: "pwd" } };
const decision: TgSecDecision & { effect: "ask" } = { effect: "ask", reason: "test ask", forced: false };

describe("createTgSecAskController", () => {
	it("shows the oldest ask first and settles one reply at a time", async () => {
		const asks = createTgSecAskController();
		const first = asks.ask(request, decision);
		const second = asks.ask(request, decision);

		expect(asks.queued).toBe(2);
		expect(asks.pending()?.request).toBe(request);
		expect(asks.answer("allow")).toBe(true);
		await expect(first).resolves.toBe("allow");

		expect(asks.queued).toBe(1);
		expect(asks.answer("deny")).toBe(true);
		await expect(second).resolves.toBe("deny");

		expect(asks.answer("allow")).toBe(false);
		expect(asks.pending()).toBeUndefined();
		asks.close();
	});

	it("denies every pending ask and every later ask after close", async () => {
		const asks = createTgSecAskController();
		const pending = asks.ask(request, decision);
		asks.close();
		await expect(pending).resolves.toBe("deny");
		await expect(asks.ask(request, decision)).resolves.toBe("deny");
		expect(asks.queued).toBe(0);
	});

	it("denies the whole queue on demand and reports how many were settled", async () => {
		const asks = createTgSecAskController();
		const first = asks.ask(request, decision);
		const second = asks.ask(request, decision);
		expect(asks.denyAll()).toBe(2);
		await expect(first).resolves.toBe("deny");
		await expect(second).resolves.toBe("deny");
		expect(asks.denyAll()).toBe(0);
		asks.close();
	});

	it("notifies on arrival and settlement until the listener is disposed", async () => {
		const asks = createTgSecAskController();
		let changes = 0;
		const dispose = asks.onChange(() => {
			changes += 1;
		});
		const pending = asks.ask(request, decision);
		expect(changes).toBe(1);
		asks.answer("deny");
		await pending;
		expect(changes).toBe(2);

		dispose();
		const late = asks.ask(request, decision);
		asks.close();
		await expect(late).resolves.toBe("deny");
		expect(changes).toBe(2);
	});
});
