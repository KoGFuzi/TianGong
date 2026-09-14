import { createTempDirectory, joinPath, removeDirectoryTree } from "../src/sqlite/bunfs.ts";
import {
	type ConformanceCase,
	createSessionRepoConformance,
} from "@onepanda-tiangongsec/tg-agent-core/session/testing";
import { describe, it } from "bun:test";
import { createBunSqliteFactory, SqliteSessionRepo } from "../src/index.ts";

const NOW = 1_700_000_000_000;

function registerConformance(name: string, cases: readonly ConformanceCase[]): void {
	describe(name, () => {
		for (const group of new Set(cases.map((testCase) => testCase.group))) {
			describe(group, () => {
				for (const testCase of cases.filter((candidate) => candidate.group === group)) {
					it(testCase.name, () => testCase.run());
				}
			});
		}
	});
}

let currentDirectory: string | undefined;
let currentSharedDirectory: string | undefined;

async function createConformanceRepo() {
	currentDirectory = await createTempDirectory("tg-sqlite-session-repo-conformance-");
	return new SqliteSessionRepo({
		directory: currentDirectory,
		databaseFactory: createBunSqliteFactory(),
		now: () => NOW,
	});
}

async function createSharedContainerConformanceRepo() {
	currentSharedDirectory = await createTempDirectory("tg-sqlite-session-repo-shared-conformance-");
	return new SqliteSessionRepo({
		directory: currentSharedDirectory,
		databasePath: joinPath(currentSharedDirectory, "sessions.sqlite"),
		databaseFactory: createBunSqliteFactory(),
		now: () => NOW,
	});
}

async function cleanupConformanceRepo() {
	if (currentDirectory === undefined) return;
	await removeDirectoryTree(currentDirectory);
	currentDirectory = undefined;
}

async function cleanupSharedContainerConformanceRepo() {
	if (currentSharedDirectory === undefined) return;
	await removeDirectoryTree(currentSharedDirectory);
	currentSharedDirectory = undefined;
}

registerConformance(
	"SqliteSessionRepo conformance",
	createSessionRepoConformance(createConformanceRepo, cleanupConformanceRepo),
);

registerConformance(
	"SqliteSessionRepo shared-container conformance",
	createSessionRepoConformance(createSharedContainerConformanceRepo, cleanupSharedContainerConformanceRepo),
);
