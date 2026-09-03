import { Context, Effect, Layer } from "effect";
import type {
	EffectSessionRepo,
	EffectSession,
	ForkOptions,
} from "@onepanda-tiangongsec/tg-agent-core";
import { EffectSessionHandle } from "@onepanda-tiangongsec/tg-agent-core";
import { SqliteSessionRepository, type SqliteSessionRepositoryOptions } from "./repo.ts";
import type { SqliteSessionCreateOptions, SqliteSessionListOptions, SqliteSessionMetadata } from "./types.ts";

const fromPromise = <A>(operation: () => Promise<A>): Effect.Effect<A, unknown> =>
	Effect.tryPromise({ try: operation, catch: (cause) => cause });

/** Effect-native repository facade. The domain repository remains the source of session invariants. */
export class EffectSqliteSessionRepositoryLive
	implements EffectSessionRepo<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions>
{
	private readonly repository: SqliteSessionRepository;

	constructor(options: SqliteSessionRepositoryOptions) {
		this.repository = new SqliteSessionRepository(options);
	}

	create(options: SqliteSessionCreateOptions): Effect.Effect<EffectSession<SqliteSessionMetadata>, unknown> {
		return fromPromise(async () => {
			const session = await this.repository.create(options);
			return new EffectSessionHandle(session, await session.getMetadata());
		});
	}

	open(metadata: SqliteSessionMetadata): Effect.Effect<EffectSession<SqliteSessionMetadata>, unknown> {
		return fromPromise(async () => {
			const session = await this.repository.open(metadata);
			return new EffectSessionHandle(session, await session.getMetadata());
		});
	}

	list(options: SqliteSessionListOptions = {}): Effect.Effect<SqliteSessionMetadata[], unknown> {
		return fromPromise(() => this.repository.list(options));
	}

	delete(metadata: SqliteSessionMetadata): Effect.Effect<void, unknown> {
		return fromPromise(() => this.repository.delete(metadata));
	}

	fork(
		source: SqliteSessionMetadata,
		options: ForkOptions & SqliteSessionCreateOptions,
	): Effect.Effect<EffectSession<SqliteSessionMetadata>, unknown> {
		return fromPromise(async () => {
			const session = await this.repository.fork(source, options);
			return new EffectSessionHandle(session, await session.getMetadata());
		});
	}

	close(): Effect.Effect<void, unknown> {
		return fromPromise(() => this.repository.close());
	}
}

export class EffectSqliteSessionRepository extends Context.Service<
	EffectSqliteSessionRepository,
	EffectSessionRepo<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions>
>()("tg-session-backend/EffectSqliteSessionRepository") {}

/** Provides a scoped Effect repository and closes its database with the layer scope. */
export const effectSqliteSessionRepositoryLayer = (
	options: SqliteSessionRepositoryOptions,
): Layer.Layer<EffectSqliteSessionRepository> =>
	Layer.effect(
		EffectSqliteSessionRepository,
		Effect.gen(function* () {
			const repository = new EffectSqliteSessionRepositoryLive(options);
			yield* Effect.addFinalizer(() => repository.close().pipe(Effect.ignore));
			return EffectSqliteSessionRepository.of(repository);
		}),
	);
