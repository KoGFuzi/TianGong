import { Effect } from "effect";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const anthropicMessagesApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./anthropic-messages.ts")));
