import { Effect } from "effect";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const tgMessagesApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./tg-messages.ts")));
