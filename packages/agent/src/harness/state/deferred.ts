/**
 * Deferred — a deferred-fetch state. See `harness.md` §3.2.
 *
 * One `resume()` performs at most one `fetchDeferred(handle, { wait: 0 })`.
 * Suspended `poll` is the number of completed polls. A fresh intent uses
 * `poll + 1`, and that 1-based value is `before_request.attempt` and the
 * poll turn-id suffix. There is no polling retry cap, backoff, or internal
 * loop. A pending response must have a completely equal handle and becomes
 * the next source; a mismatched pending handle is normalized to a durable
 * `error` response explaining the mismatch.
 */
export type Deferred =
	| {
			readonly status: "suspended";
			readonly stepId: string;
			readonly sourceEntryId: string;
			readonly poll: number;
			readonly configuration: LaneConfiguration;
			readonly streamOptions: AgentHarnessStreamOptions;
	  }
	| {
			readonly status: "effect_pending";
			readonly stepId: string;
			readonly sourceEntryId: string;
			readonly poll: number;
			readonly responseEntryId: string;
			readonly usageId: string;
			readonly configuration: LaneConfiguration;
			readonly streamOptions: AgentHarnessStreamOptions;
	  };

import type { LaneConfiguration } from "./generation.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";