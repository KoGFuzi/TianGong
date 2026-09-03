import { join } from "node:path";
import { Effect } from "effect";
import type { SessionMetadata, SessionRepo } from "@onepanda-tiangongsec/tg-agent-core";
import { NodeExecutionEnv } from "@onepanda-tiangongsec/tg-agent-core/node";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "@onepanda-tiangongsec/tg-agent-core/session/testing";
import { describe, it } from "vitest";
import { createBunSqliteFactory, type SqliteSessionMetadata, SqliteSessionRepository } from "../src/index.ts";
import { createTempDir } from "./test-utils.ts";

function requireSqliteMetadata(metadata: SessionMetadata): SqliteSessionMetadata {
	const cwd = "cwd" in metadata ? metadata.cwd : undefined;
	if (typeof cwd !== "string") {
		throw new Error(`Expected SQLite metadata for session ${metadata.id}`);
	}
	const path = "path" in metadata ? metadata.path : undefined;
	if (typeof path !== "string") {
		throw new Error(`Expected SQLite metadata for session ${metadata.id}`);
	}
	return { ...metadata, cwd, path };
}

const conformance = createSessionBackendConformance(async () => {
	const root = createTempDir();
	const sqliteRepository = new SqliteSessionRepository({
		env: new NodeExecutionEnv({ cwd: root }),
		sqlite: createBunSqliteFactory(),
		databasePath: join(root, "sessions.sqlite"),
	});
	const repository: SessionRepo = {
		create: (options = {}) => Effect.promise(() => sqliteRepository.create({ ...options, cwd: root })),
		open: (metadata) => Effect.promise(() => sqliteRepository.open(requireSqliteMetadata(metadata))),
		list: () => Effect.promise(() => sqliteRepository.list()),
		delete: (metadata) => Effect.promise(() => sqliteRepository.delete(requireSqliteMetadata(metadata))),
		fork: (source, options = {}) => Effect.promise(() => sqliteRepository.fork(requireSqliteMetadata(source), { ...options, cwd: root })),
	};
	return {
		repository,
		async [Symbol.asyncDispose]() {
			await sqliteRepository.close();
		},
	} satisfies SessionBackendFixture;
});

describe("SqliteSessionRepository conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});
