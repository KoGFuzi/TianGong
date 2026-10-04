import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const tgMessagesApi = (): ProviderStreams => lazyApi(() => import("./tg-messages.ts"));
