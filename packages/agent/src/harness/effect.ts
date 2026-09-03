import { Context, Effect, Layer, Ref } from "effect";
import type { Api, Model, Models, RetryPolicy } from "@onepanda-tiangongsec/tg-ai";
import type { AgentMessage, QueueMode, ThinkingLevel } from "../types.ts";
import type { CompactionSettings } from "./compaction/compaction.ts";
import type { Session, SessionTree } from "./session/index.ts";
import type { AgentHarnessOptions, HarnessTool, Resources, StreamOptions } from "./agent-harness.ts";

/** Dependencies used by the harness interpreter. Keep this small: effects are
 * supplied by the application, while orchestration remains deterministic. */
export interface HarnessRuntime {
	readonly session: Session;
	readonly models: Models;
	readonly model: Model<Api>;
	readonly lane: string;
	readonly tools: readonly HarnessTool[];
	readonly resources: Resources;
	readonly thinkingLevel: ThinkingLevel;
	readonly activeToolNames: readonly string[];
	readonly streamOptions: StreamOptions;
	readonly retryPolicy: RetryPolicy;
	readonly compaction: CompactionSettings;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
}

export const HarnessRuntimeTag = Context.Service<HarnessRuntime>("tg-agent/HarnessRuntime");
export const HarnessStateTag = Context.Service<Ref.Ref<HarnessRuntime>>("tg-agent/HarnessState");

export type HarnessEffect<A, E = never> = Effect.Effect<A, E, HarnessRuntime | Ref.Ref<HarnessRuntime>>;

export const runtime = Effect.service(HarnessRuntimeTag);

/** Creates the orchestration environment without starting an Effect runtime. */
export const harnessLayerFromOptions = (
	options: AgentHarnessOptions,
): Layer.Layer<HarnessRuntime | Ref.Ref<HarnessRuntime>> =>
	makeHarnessLayer({
		session: options.session,
		models: options.models,
		model: options.model,
		tools: options.tools ?? [],
		resources: {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		},
		thinkingLevel: options.thinkingLevel ?? "off",
		activeToolNames: [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])],
		streamOptions: { ...(options.streamOptions ?? {}) },
		retryPolicy: options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 },
		compaction: options.compaction ?? { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		steeringMode: options.steeringMode ?? "one-at-a-time",
		followUpMode: options.followUpMode ?? "one-at-a-time",
	});

export const sessionTree: HarnessEffect<SessionTree> = Effect.gen(function* () {
	const current = yield* Ref.get(yield* Effect.service(HarnessStateTag));
	return current.session.view(current.lane);
});

export const getModel: HarnessEffect<Model<Api>> = Effect.gen(function* () {
	const current = yield* Ref.get(yield* Effect.service(HarnessStateTag));
	return current.model;
});

export const getThinkingLevel: HarnessEffect<ThinkingLevel> = Effect.gen(function* () {
	const current = yield* Ref.get(yield* Effect.service(HarnessStateTag));
	return current.thinkingLevel;
});

export const getActiveTools: HarnessEffect<readonly string[]> = Effect.gen(function* () {
	const current = yield* Ref.get(yield* Effect.service(HarnessStateTag));
	return [...current.activeToolNames];
});

export const setThinkingLevel = (level: ThinkingLevel): HarnessEffect<void> =>
	Effect.flatMap(Effect.service(HarnessStateTag), (state) =>
		Ref.update(state, (current) => ({ ...current, thinkingLevel: level })),
	);

export const setActiveTools = (names: readonly string[]): HarnessEffect<void> =>
	Effect.flatMap(Effect.service(HarnessStateTag), (state) =>
		Ref.update(state, (current) => ({ ...current, activeToolNames: [...names] })),
	);

export const makeHarnessLayer = (options: Omit<HarnessRuntime, "lane"> & { lane?: string }): Layer.Layer<
	HarnessRuntime | Ref.Ref<HarnessRuntime>
> => {
	const value: HarnessRuntime = { ...options, lane: options.lane ?? "main" };
	const state = Effect.runSync(Ref.make(value));
	return Layer.mergeAll(
		Layer.succeed(HarnessRuntimeTag, value),
		Layer.succeed(HarnessStateTag, state),
	);
};

export const runHarness = <A, E>(
	effect: HarnessEffect<A, E>,
	layer: Layer.Layer<HarnessRuntime | Ref.Ref<HarnessRuntime>>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);
