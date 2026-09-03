import { Effect } from "effect";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICompletionsApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./openai-completions.ts")));
