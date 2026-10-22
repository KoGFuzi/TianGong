export {
	probeDangerSetForcesAskPastGrants,
	probeForcedAskBlocks,
	probeJudgeTimeoutAsks,
	probeJudgeTransportErrorAsks,
	probeModeDocument,
	probeRestrictedEnv,
	probeRuleDenyForcesAskPastExemptions,
	probeScopeOutsideNotAllows,
	probeStrictIgnoresRuleAllow,
	probeToolSetAlignment,
	probeUnaffiliatedCallEntersChain,
	runTgSecAttestation,
	type TgSecAttestContext,
	type TgSecProbe,
	type TgSecProbeGuardPieces,
} from "./attest.ts";
// The public extraction entry is `extractConnectionTargets` alone. The surface primitives it is built
// from (`extractCommandSurface`, `connectionTargetsFromSurface`, `tokenize`) are deliberately NOT
// re-exported: a consumer holding them can bypass the filter and scan strings itself, which would put
// a second text-matching surface back into the world. The batch 2a text-scan view (`scanTextSurface`)
// is held to the same rule, and so is the built-in rule table `TG_SEC_DANGER_RULES`: the host gets a
// guard, not a scanner. `test/boundary.test.ts` asserts this.
export { extractConnectionTargets, type TgSecConnectionTarget, type TgSecTargetEvidence } from "./command-text.ts";
export { createTgSecDangerEvaluator } from "./danger.ts";
export {
	createInMemoryGrantStore,
	createTgSecGuard,
	type TgSecAskChannel,
	type TgSecEvaluation,
	type TgSecGrantStore,
	type TgSecGuard,
	type TgSecGuardOptions,
	type TgSecMatchedLayer,
} from "./guard.ts";
export {
	evaluateHardDeny,
	evaluateWeakSelfProtection,
	localInterfaceAddresses,
	type TgSecHardDenyHit,
	type TgSecHardDenyRuleId,
	type TgSecSelfProtectionRuleId,
	type TgSecWeakSelfProtectionHit,
} from "./hard-deny.ts";
export {
	createTgSecTwoAxisJudge,
	TG_SEC_JUDGE_DEFAULT_MAX_INPUT_BYTES,
	TG_SEC_JUDGE_DEFAULT_TIMEOUT_MS,
	type TgSecJudgeInput,
	type TgSecJudgeTarget,
	type TgSecJudgeTransport,
	type TgSecTwoAxisJudgeOptions,
} from "./judge.ts";
export {
	isTgSecMode,
	readTgSecMode,
	switchTgSecMode,
	TG_SEC_DEFAULT_MODE,
	TG_SEC_MODES,
	TgSecModeDoc,
	type TgSecModeReader,
	type TgSecModeValue,
	type TgSecSessionPort,
} from "./mode.ts";
export {
	createTgSecRuleTable,
	loadTgSecRules,
	parseTgSecRules,
	type TgSecRule,
	type TgSecRuleEffect,
	type TgSecRuleTable,
} from "./rules.ts";
export { createTgSecScopeResolver } from "./scope.ts";
export {
	createTgSecScopeRegistry,
	loadTgSecScopeRegistry,
	parseTgSecScopeConfig,
	type TgSecScopeEffect,
	type TgSecScopeKind,
	type TgSecScopeRegistry,
	type TgSecScopeRule,
	type TgSecScopeVerdict,
} from "./scope-registry.ts";
export {
	TG_SEC_OBJECTIVES,
	type TgSecAskReply,
	type TgSecDangerEvaluator,
	type TgSecDangerHit,
	type TgSecDangerRuleId,
	type TgSecDecision,
	type TgSecJudge,
	type TgSecObjective,
	type TgSecPermissionMode,
	type TgSecRequest,
	type TgSecScopeResolver,
	toTgSecRequest,
} from "./types.ts";
