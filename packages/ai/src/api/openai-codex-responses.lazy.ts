import { Effect } from "effect";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICodexResponsesApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./openai-codex-responses.ts")));
