import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { effectInMemorySessionRepo } from "../../../src/harness/session/memory.ts";

describe("Effect session contract", () => {
	test("runs the in-memory repository through Effect", async () => {
		const repository = effectInMemorySessionRepo();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const session = yield* repository.create({ id: "effect-session" });
				const entryId = yield* session.appendCustomEntry("note", { value: 1 });
				const entry = yield* session.getEntry(entryId);
				return { entryId, entry };
			}),
		);

		expect(result.entryId).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.entry).toMatchObject({ type: "custom", customType: "note", data: { value: 1 } });
	});
});
