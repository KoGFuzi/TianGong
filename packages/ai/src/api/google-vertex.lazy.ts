import { Effect } from "effect";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleVertexApi = (): ProviderStreams =>
	lazyApi(() => Effect.tryPromise(() => import("./google-vertex.ts")));
