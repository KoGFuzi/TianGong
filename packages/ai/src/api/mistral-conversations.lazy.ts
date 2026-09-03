import { Effect } from "effect";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const mistralConversationsApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./mistral-conversations.ts")));
