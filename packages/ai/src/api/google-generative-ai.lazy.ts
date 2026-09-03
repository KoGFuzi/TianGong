import { Effect } from "effect";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleGenerativeAIApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./google-generative-ai.ts")));
