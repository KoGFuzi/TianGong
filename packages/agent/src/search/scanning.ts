import type { Entry, SessionMetadata, SessionStorage } from "../harness/session/types.ts";
import { Effect, Stream } from "effect";
import type { EffectSessionSearch, SessionSearchHit, SessionSearchOptions } from "./index.ts";

export interface SessionSearchCandidate {
	readonly entryId: string;
	readonly seq: number;
	readonly type: Entry["type"];
	readonly timestamp: number;
	readonly text: string;
	readonly fields?: Record<string, unknown>;
}

export type ScanningReadable<TMetadata extends SessionMetadata = SessionMetadata> = Pick<
	SessionStorage<TMetadata>,
	"getMetadata" | "findEntries" | "getLabel"
>;

export type ScanningReadableSource<TMetadata extends SessionMetadata = SessionMetadata, TOptions = unknown> = (
	options?: TOptions,
) => Stream.Stream<ScanningReadable<TMetadata>, never>;

export type ScanningSearchTextProjector<TMetadata extends SessionMetadata = SessionMetadata> = (
	metadata: TMetadata,
	entry: Entry,
	label: string | undefined,
) => string;

export interface ScanningReadableOptions<TMetadata extends SessionMetadata = SessionMetadata> {
	projectText?: ScanningSearchTextProjector<TMetadata>;
	pageSize?: number;
}

export interface ScanningSessionSearchHit extends SessionSearchHit {
	readonly timestamp: number;
	readonly snippet: string;
}

export interface ScanningSessionSearchOptions<
	TMetadata extends SessionMetadata = SessionMetadata,
	TSourceOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
> extends ScanningReadableOptions<TMetadata> {
	sourceOptions?: (text: string, options: SessionSearchOptions) => TSourceOptions | undefined;
	match?: (queryText: string, candidate: SessionSearchCandidate, metadata: TMetadata) => boolean;
	createHit?: (metadata: TMetadata, candidate: SessionSearchCandidate) => THit;
}

function defaultSearchText<TMetadata extends SessionMetadata>(
	_metadata: TMetadata,
	entry: Entry,
	label: string | undefined,
): string {
	return label === undefined ? JSON.stringify(entry) : `${JSON.stringify(entry)} ${label}`;
}

function loadPageEffect<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	metadata: TMetadata,
	projectText: ScanningSearchTextProjector<TMetadata>,
	afterSeq: number,
	limit: number,
	singleType: Entry["type"] | undefined,
	entryTypes: Set<Entry["type"]> | undefined,
	signal: AbortSignal | undefined,
): Effect.Effect<SessionSearchCandidate[], unknown> {
	const effect = readable.findEntries({
		order: "oldestFirst",
		limit,
		cursor: { afterSeq },
		type: singleType,
	});

	return Effect.flatMap(effect, (entries) => {
		if (entries.length === 0) return Effect.succeed([]);
		const filtered = entryTypes !== undefined
			? entries.filter((e) => entryTypes.has(e.type))
			: entries;
		if (filtered.length === 0) return Effect.succeed([]);

		const candidates = Effect.all(
			filtered.map((entry) =>
				Effect.map(readable.getLabel(entry.id), (label) => ({
					entryId: entry.id,
					seq: entry.seq,
					type: entry.type,
					timestamp: entry.timestamp,
					text: projectText(metadata, entry, label),
					fields: label === undefined ? undefined : { label },
				}))
			),
			{ concurrency: "unbounded" },
		);

		return Effect.map(candidates, (results) => {
			if (signal?.aborted) {
				const err = new Error("The operation was aborted");
				err.name = "AbortError";
				throw err;
			}
			return results;
		});
	});
}

function scanEntriesEffect<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	metadata: TMetadata,
	options: ScanningReadableOptions<TMetadata>,
	query: { afterSeq?: number; limit?: number; entryTypes?: readonly Entry["type"][]; signal?: AbortSignal } = {},
	): Effect.Effect<SessionSearchCandidate[], unknown> {
	const projectText = options.projectText ?? defaultSearchText;
	const pageSize = query.limit ?? options.pageSize ?? 100;
	const entryTypes = query.entryTypes === undefined ? undefined : new Set(query.entryTypes);
	const singleType = query.entryTypes?.length === 1 ? query.entryTypes[0] : undefined;
	const signal = query.signal;
	const hasLimit = query.limit !== undefined;
	const limit = hasLimit ? query.limit! : Number.MAX_SAFE_INTEGER;

	const fetchPage = (afterSeq: number, fetchLimit: number): Effect.Effect<SessionSearchCandidate[], unknown> => {
		const entriesEffect = readable.findEntries({
			order: "oldestFirst",
			limit: fetchLimit,
			cursor: { afterSeq },
			type: singleType,
		});

		return Effect.flatMap(entriesEffect, (entries) => {
			if (entries.length === 0) {
				return Effect.succeed([]);
			}
			const filtered = entryTypes !== undefined
				? entries.filter((e) => entryTypes.has(e.type))
				: entries;
			if (filtered.length === 0) {
				return Effect.succeed([]);
			}
			const labelEffects = filtered.map((entry) =>
				Effect.map(readable.getLabel(entry.id), (label) => ({
					entryId: entry.id,
					seq: entry.seq,
					type: entry.type,
					timestamp: entry.timestamp,
					text: projectText(metadata, entry, label),
					fields: label === undefined ? undefined : { label },
				}))
			);
			return Effect.map(
				Effect.all(labelEffects, { concurrency: "unbounded" }),
				(candidates) => {
					if (signal?.aborted) {
						const err = new Error("The operation was aborted");
						err.name = "AbortError";
						throw err;
					}
					return candidates;
				},
			);
		});
	};

	const step = (afterSeq: number, remainingLimit: number, results: SessionSearchCandidate[]): Effect.Effect<SessionSearchCandidate[], unknown> => {
		if (signal?.aborted) {
			const err = new Error("The operation was aborted");
			err.name = "AbortError";
			return Effect.fail(err);
		}
		const fetchLimit = Math.min(pageSize, remainingLimit);
		return Effect.flatMap(fetchPage(afterSeq, fetchLimit), (candidates) => {
			if (candidates.length === 0) {
				const output = results;
				return Effect.succeed(hasLimit ? output.slice(0, limit) : output);
			}
			if (candidates.length < fetchLimit) {
				const output = results.concat(candidates);
				return Effect.succeed(hasLimit ? output.slice(0, limit) : output);
			}
			const newResults = results.concat(candidates);
			if (newResults.length >= limit) {
				return Effect.succeed(newResults.slice(0, limit));
			}
			const lastSeq = candidates[candidates.length - 1]?.seq ?? afterSeq;
			const newRemaining = remainingLimit - candidates.length;
			return step(lastSeq, newRemaining, newResults);
		});
	};

	return step(query.afterSeq ?? 0, limit, []);
}

export function scanningEntries<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	options: ScanningReadableOptions<TMetadata> = {},
): Stream.Stream<SessionSearchCandidate, unknown> {
	return Stream.flatMap(
		Stream.fromEffect(readable.getMetadata()),
		(metadata) => {
			const resultsEffect = scanEntriesEffect(readable, metadata, options);
			return Stream.fromEffect(Effect.map(resultsEffect, (results) => Stream.fromIterable(results)));
		},
		{ concurrency: "unbounded" },
	).pipe(Stream.flatMap((s) => s));
}

function readablesFor<TMetadata extends SessionMetadata, TSourceOptions>(
	source: readonly ScanningReadable<TMetadata>[] | ScanningReadableSource<TMetadata, TSourceOptions>,
	options: TSourceOptions | undefined,
): Stream.Stream<ScanningReadable<TMetadata>, never> {
	if (typeof source === "function") {
		const result = source(options);
		return result ?? Stream.empty;
	}
	return Stream.fromIterable(source as ScanningReadable<TMetadata>[]);
}

function defaultMatch(queryText: string, candidate: SessionSearchCandidate): boolean {
	return candidate.text.toLowerCase().includes(queryText);
}

function createDefaultScanningHit<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	candidate: SessionSearchCandidate,
): ScanningSessionSearchHit {
	return {
		sessionId: metadata.id,
		entryId: candidate.entryId,
		timestamp: candidate.timestamp,
		snippet: candidate.text,
	};
}

export function createScanningSessionSearch<
	TMetadata extends SessionMetadata,
	TSourceOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
>(
	source: readonly ScanningReadable<TMetadata>[] | ScanningReadableSource<TMetadata, TSourceOptions>,
	options: ScanningSessionSearchOptions<TMetadata, TSourceOptions, THit> = {},
): EffectSessionSearch<THit> {
	const createHit =
		options.createHit ??
		((metadata: TMetadata, candidate: SessionSearchCandidate) =>
			createDefaultScanningHit(metadata, candidate) as unknown as THit);

	const search = (
		text: string,
		searchOptions: SessionSearchOptions = {},
	): Stream.Stream<THit, unknown> => {
		const normalizedText = text.trim().toLowerCase();
		if (!normalizedText || (searchOptions.limit !== undefined && searchOptions.limit <= 0)) {
			return Stream.empty;
		}
		if (searchOptions.entryTypes?.length === 0) return Stream.empty;
		const entryTypes = searchOptions.entryTypes !== undefined
			? new Set(searchOptions.entryTypes)
			: undefined;
		const sourceOptions = options.sourceOptions?.(normalizedText, searchOptions);
		const seenSessionIds = new Set<string>();

		return Stream.flatMap(readablesFor(source, sourceOptions), (readable) =>
			Stream.flatMap(
				Stream.fromEffect(readable.getMetadata()),
				(metadata) => {
					if (seenSessionIds.has(metadata.id)) {
						return Stream.fail(new Error(`Duplicate sessionId: ${metadata.id}`));
					}
					seenSessionIds.add(metadata.id);
					return Stream.fromEffect(
						scanEntriesEffect(readable, metadata, options, {
							entryTypes: searchOptions.entryTypes,
							signal: searchOptions.signal,
						}).pipe(
							Effect.map((results) =>
								results
									.map((candidate) => {
										if (entryTypes !== undefined && !entryTypes.has(candidate.type)) {
											return null;
										}
										const matches = options.match?.(normalizedText, candidate, metadata) ??
											defaultMatch(normalizedText, candidate);
										if (!matches) return null;
										return createHit(metadata, candidate) as THit;
									})
									.filter((hit): hit is THit => hit !== null),
							),
						),
					).pipe(
						Stream.flatMap((results) => Stream.fromIterable(results)),
					);
				},
			),
		);
	};

	return {
		searchStream(text: string, searchOptions: SessionSearchOptions = {}) {
			return search(text, searchOptions);
		},
		search,
	};
}
