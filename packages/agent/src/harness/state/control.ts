/**
 * Operation kind — `op.meta/{operationId}` is written once at acceptance
 * and records this discriminant. See `harness.md` §3.1.
 */
export type OperationKind = "run" | "compaction" | "navigation";

export type ControlStatus = "running" | "cancel_requested";

/**
 * Control — the `op.state` control plane that carries cancellation
 * requests. `running` means proceed normally; `cancel_requested` means the
 * next assistant settlement must normalize `stopReason` to `aborted` and the
 * terminal transaction is `aborted`. The drained ids survive until the
 * terminal transaction deletes their `pending.entry` registers; nothing
 * else may move them. See `harness.md` §3.2.
 */
export type Control =
	| { readonly status: "running" }
	| {
			readonly status: "cancel_requested";
			readonly requestedAt: number;
			readonly drainedSteer: readonly string[];
			readonly drainedFollowUp: readonly string[];
	  };

export const RUNNING_CONTROL: Control = { status: "running" };
