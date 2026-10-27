import { defineDoc } from "@OnePanda-TgSec/tg-gibraltar";
import type { SecAgentLane } from "./bootstrap.ts";
import type { TgSecAgentRole } from "./role-policies.ts";

/**
 * The policy scope one conversation runs under: its depth below the root and the role/lane its
 * `task` delegation chose. Written in the child's own fork commit, so the depth gate has a durable
 * fact to read instead of trusting the caller.
 */
export type TgSecTaskScopeValue = {
	depth: number;
	role: TgSecAgentRole;
	lane: SecAgentLane;
};

export const TgSecTaskScopeDoc = defineDoc<TgSecTaskScopeValue>({
	kind: "tg.sec.task-scope",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ depth: 0, role: "redteam", lane: "redteam" }),
});
