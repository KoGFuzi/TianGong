import type { ProviderStreams } from "../types.ts";
import { Effect } from "effect";
import { lazyApi } from "./lazy.ts";

export const azureOpenAIResponsesApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./azure-openai-responses.ts")));
