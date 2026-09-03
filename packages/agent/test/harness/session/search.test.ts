// @ts-nocheck - Test file
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "../../bun-test.ts";
import { Effect, Stream } from "effect";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import {
	InMemorySessionStorage,
	type JsonlSessionListOptions,
	JsonlSessionRepo,
	type JsonlSessionRepoOptions,
	Session,
	type SessionMetadata,
	type SessionStorage,
} from "../../../src/harness/session/index.ts";
import { listJsonlSessionMetadata } from "../../../src/harness/session/jsonl/repo.ts";
import { createScanningSessionSearch } from "../../../src/search/index.ts";
import type { AgentMessage } from "../../../src/types.ts";

interface WorkspaceMetadata extends SessionMetadata {
	cwd: string;
}

const tempDirs: string[] = [];

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-search-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function message(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function createMemorySession(metadata: WorkspaceMetadata): Session<WorkspaceMetadata> {
	return new Session<WorkspaceMetadata>(new InMemorySessionStorage(metadata));
}

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);

async function collect<T>(stream: Stream.Stream<T, never>): Promise<T[]> {
	return Effect.runPromise(Stream.runCollect(stream));
}

async function* jsonlReadables(options: JsonlSessionRepoOptions, query: JsonlSessionListOptions = {}) {
	const repository = new JsonlSessionRepo(options);
	for (const metadata of await listJsonlSessionMetadata(options, query)) {
		yield await run(repository.open(metadata));
	}
}

function jsonlReadablesStream(options: JsonlSessionRepoOptions, query?: JsonlSessionListOptions): Stream.Stream<Session<WorkspaceMetadata>, never> {
	return Stream.fromAsyncIterable(jsonlReadables(options, query), () => new Error("Failed to read session"));
}

describe("session search", () => {
	it("scans an arbitrary in-memory projected source", async () => {
		const root = createMemorySession({ id: "root", createdAt: 1, cwd: "/repo" });
		await run(root.appendMessage(message("fix auth flow")));
		const other = createMemorySession({ id: "other", createdAt: 2, cwd: "/other" });
		await run(other.appendMessage(message("auth in another workspace")));
		const search = createScanningSessionSearch([root, other]);

		expect("apply" in search).toBe(false);
		expect(await collect(search.search("auth"))).toMatchObject([{ sessionId: "root" }, { sessionId: "other" }]);
		expect(await collect(search.search("missing"))).toEqual([]);
	});

	it("exposes the same search flow as an Effect Stream", async () => {
		const session = createMemorySession({ id: "effect", createdAt: 1, cwd: "/repo" });
		const entryId = await run(session.appendMessage(message("effect auth result")));
		const search = createScanningSessionSearch([session]);
		const stream = search.searchStream("auth");

		const hits = await Effect.runPromise(Stream.runCollect(stream));
		expect(hits).toMatchObject([{ sessionId: "effect", entryId }]);
	});

	it("includes labels in memory scanning projections", async () => {
		const session = createMemorySession({ id: "session", createdAt: 1, cwd: "/repo" });
		const entryId = await run(session.appendMessage(message("plain body")));
		await run(session.setLabel(entryId, "important label"));
		const search = createScanningSessionSearch([session]);

		expect(await collect(search.search("important"))).toMatchObject([{ sessionId: "session", entryId }]);
	});

	it("honors entry type filters and abort signals in scanning search", async () => {
		const session = createMemorySession({ id: "session", createdAt: 1, cwd: "/repo" });
		const messageEntryId = await run(session.appendMessage(message("auth message")));
		await run(session.appendCustomEntry("note", { text: "auth custom" }));
		const search = createScanningSessionSearch([session]);

		expect(await collect(search.search("auth", { entryTypes: ["message"] }))).toMatchObject([
			{ sessionId: "session", entryId: messageEntryId },
		]);

		const controller = new AbortController();
		controller.abort();
		await expect(collect(search.search("auth", { signal: controller.signal }))).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("scans JSONL sessions from disk through the JSONL scanning source", async () => {
		const root = createTempDir();
		const options = { fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root };
		const repository = new JsonlSessionRepo(options);
		const cwd = join(root, "workspace");
		const otherCwd = join(root, "other");
		const session = await run(repository.create({ id: "jsonl", cwd }));
		const entryId = await run(session.appendMessage(message("jsonl backed auth entry")));
		await run(session.setLabel(entryId, "disk label"));
		const other = await run(repository.create({ id: "other", cwd: otherCwd }));
		const otherEntryId = await run(other.appendMessage(message("jsonl backed auth entry in another cwd")));
		const search = createScanningSessionSearch((query?: JsonlSessionListOptions) => jsonlReadablesStream(options, query));

		const authHits = await collect(search.search("auth"));
		expect(authHits).toHaveLength(2);
		expect(authHits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: "jsonl",
					entryId,
				}),
				expect.objectContaining({
					sessionId: "other",
					entryId: otherEntryId,
				}),
			]),
		);
		expect(await collect(search.search("disk"))).toMatchObject([{ sessionId: "jsonl", entryId }]);
	});
});
