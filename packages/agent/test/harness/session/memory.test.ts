import { Effect } from "effect";
import { describe, expect, it } from "../../bun-test.ts";
import { InMemorySessionRepo, InMemorySessionStorage, Session } from "../../../src/harness/session/index.ts";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "../../../src/harness/session/testing/index.ts";

const conformance = createSessionBackendConformance(() =>
	Promise.resolve<SessionBackendFixture>({
		repository: new InMemorySessionRepo(),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	}),
);

describe("InMemorySessionRepo conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("Session with in-memory storage", () => {
	it("commits entries and registers atomically", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "atomic", createdAt: 1 }));
		const result = await Effect.runPromise(session.commit({
			writes: [
				{ kind: "entry", lane: "main", entry: { type: "custom", id: "entry", customType: "note", data: { value: 1 } } },
				{ kind: "register", op: "set", namespace: "op.meta", key: "operation", value: { kind: "run" } },
				{ kind: "register", op: "set", namespace: "lane.state", key: "main", value: { currentOperationId: "operation" } },
			],
		}));

		expect(result.seqs).toEqual([1, 2, 3]);
		expect(await Effect.runPromise(session.getEntries(["entry"]))).toEqual(new Map([["entry", expect.objectContaining({ seq: 1 })]]));
		expect(await Effect.runPromise(session.getRegister("op.meta", "operation"))).toMatchObject({ seq: 2, value: { kind: "run" } });
		expect(await Effect.runPromise(session.listRegisters("lane.state"))).toMatchObject([{ key: "main", seq: 3 }]);
	});

	it("uses one injectable id generator across lane views", async () => {
		let nextId = 0;
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }), {
			idGenerator: { next: () => `generated-${++nextId}` },
		});
		const mainId = await Effect.runPromise(session.appendCustomEntry("note"));
		await Effect.runPromise(session.createLane("thread", mainId));
		const threadId = await Effect.runPromise(session.view("thread").appendCustomEntry("note"));

		expect(mainId).toBe("generated-1");
		expect(threadId).toBe("generated-2");
	});
});