import { Effect } from "effect";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAIResponsesApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./openai-responses.ts")));
