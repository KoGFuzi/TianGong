import { strictEqual } from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import {
	STORAGE_READ_BENCHMARKS,
	STORAGE_WRITE_BENCHMARKS,
	seedStorageBenchmark,
	seedStorageWriteBenchmark,
} from "@OnePanda-TgSec/tg-gibraltar/testing";
import { afterAll, bench, describe } from "vitest";
import { MemoryStorage } from "../src/storage/memory.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type { EntryId, Storage } from "../src/types.ts";

const STORAGE_BENCHMARK_BACKENDS = ["memory", "sqlite"] as const;
type StorageBenchmarkBackend = (typeof STORAGE_BENCHMARK_BACKENDS)[number];

const READ_OPTIONS = { time: 300, iterations: 10, warmupTime: 75, warmupIterations: 3 } as const;
const WRITE_OPTIONS = { time: 0, iterations: 20, warmupTime: 0, warmupIterations: 5 } as const;
const REOPEN_OPTIONS = { time: 0, iterations: 20, warmupTime: 0, warmupIterations: 3 } as const;

type Fixture = {
	readonly backend: StorageBenchmarkBackend;
	readonly storage: Storage;
};

const fixtures: Fixture[] = [];
const directories: string[] = [];

async function createFixture(backend: StorageBenchmarkBackend): Promise<Fixture> {
	if (backend === "memory") {
		const fixture = { backend, storage: new MemoryStorage() } satisfies Fixture;
		fixtures.push(fixture);
		return fixture;
	}
	const directory = await mkdtemp(join(tmpdir(), "tg-gibraltar-benchmark-"));
	directories.push(directory);
	const path = join(directory, "storage.sqlite");
	const fixture = { backend, storage: await openNodeSqliteStorage(path) } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

const readFixtures = await Promise.all(STORAGE_BENCHMARK_BACKENDS.map(createFixture));
const readDatasets = await Promise.all(readFixtures.map(({ storage }) => seedStorageBenchmark(storage)));
for (let index = 0; index < readFixtures.length; index++) {
	for (const scenario of STORAGE_READ_BENCHMARKS) {
		strictEqual(
			await scenario.run(readFixtures[index].storage, readDatasets[index]),
			scenario.expected(readDatasets[index]),
		);
	}
}

for (const scenario of STORAGE_READ_BENCHMARKS) {
	describe(scenario.name, () => {
		for (let index = 0; index < readFixtures.length; index++) {
			const fixture = readFixtures[index];
			const dataset = readDatasets[index];
			bench(
				fixture.backend,
				async () => {
					await scenario.run(fixture.storage, dataset);
				},
				READ_OPTIONS,
			);
		}
	});
}

async function createWriteFixture(backend: StorageBenchmarkBackend): Promise<Fixture> {
	const fixture = await createFixture(backend);
	await seedStorageWriteBenchmark(fixture.storage);
	return fixture;
}

const writePools = new Map<string, Fixture[]>();
for (const scenario of STORAGE_WRITE_BENCHMARKS) {
	for (const backend of STORAGE_BENCHMARK_BACKENDS) {
		const validation = await createWriteFixture(backend);
		strictEqual(await scenario.run(validation.storage), scenario.expected);
		const pool = await Promise.all(
			Array.from({ length: WRITE_OPTIONS.iterations + WRITE_OPTIONS.warmupIterations }, () =>
				createWriteFixture(backend),
			),
		);
		writePools.set(`${scenario.name}:${backend}`, pool);
	}
	describe(scenario.name, () => {
		for (const backend of STORAGE_BENCHMARK_BACKENDS) {
			const pool = writePools.get(`${scenario.name}:${backend}`)!;
			bench(
				backend,
				async () => {
					const fixture = pool.shift();
					if (fixture === undefined) throw new Error("Write benchmark fixture pool was exhausted");
					await scenario.run(fixture.storage);
				},
				WRITE_OPTIONS,
			);
		}
	});
}

type PersistentBackend = Exclude<StorageBenchmarkBackend, "memory">;
type ReopenFixture = {
	readonly backend: PersistentBackend;
	readonly path: string;
	readonly firstEntryId: EntryId;
	readonly samples: string[];
};

async function openPersistentStorage(backend: PersistentBackend, path: string): Promise<Storage> {
	return openNodeSqliteStorage(path);
}

async function copyPersistentStorage(source: string, destination: string): Promise<void> {
	await copyFile(source, destination);
}

const reopenFixtures: ReopenFixture[] = [];
for (const backend of STORAGE_BENCHMARK_BACKENDS) {
	if (backend === "memory") continue;
	const seedDirectory = await mkdtemp(join(tmpdir(), `tg-gibraltar-${backend}-reopen-benchmark-`));
	directories.push(seedDirectory);
	const seedPath = join(seedDirectory, "storage.sqlite");
	const seed = await openPersistentStorage(backend, seedPath);
	const dataset = await seedStorageBenchmark(seed);
	await seed.close(BACKGROUND_CONTEXT);
	const samples = await Promise.all(
		Array.from({ length: REOPEN_OPTIONS.iterations + REOPEN_OPTIONS.warmupIterations }, async () => {
			const directory = await mkdtemp(join(tmpdir(), `tg-gibraltar-${backend}-reopen-sample-`));
			directories.push(directory);
			const path = join(directory, backend === "sqlite" ? "storage.sqlite" : "storage");
			await copyPersistentStorage(seedPath, path);
			return path;
		}),
	);
	reopenFixtures.push({ backend, path: seedPath, firstEntryId: dataset.firstEntryId, samples });
}

const reopenedStorages: Storage[] = [];
async function reopenAndRead(
	backend: PersistentBackend,
	path: string,
	firstEntryId: EntryId,
): Promise<{ readonly id: number; readonly storage: Storage }> {
	const storage = await openPersistentStorage(backend, path);
	const id = (await storage.entry(firstEntryId, BACKGROUND_CONTEXT))?.entry.id ?? -1;
	return { id, storage };
}

for (const fixture of reopenFixtures) {
	const reopenValidation = await reopenAndRead(fixture.backend, fixture.path, fixture.firstEntryId);
	strictEqual(reopenValidation.id, fixture.firstEntryId);
	await reopenValidation.storage.close(BACKGROUND_CONTEXT);
}

describe("reopen and first exact read", () => {
	for (const fixture of reopenFixtures) {
		bench(
			fixture.backend,
			async () => {
				const path = fixture.samples.shift();
				if (path === undefined) throw new Error("Reopen benchmark fixture pool was exhausted");
				const result = await reopenAndRead(fixture.backend, path, fixture.firstEntryId);
				reopenedStorages.push(result.storage);
			},
			REOPEN_OPTIONS,
		);
	}
});

afterAll(async () => {
	for (const storage of reopenedStorages) await storage.close(BACKGROUND_CONTEXT);
	for (const fixture of fixtures) await fixture.storage.close(BACKGROUND_CONTEXT);
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});
