import { Context, Data, Effect, Layer } from "effect";
import type { AssistantMessage, Api, Model, Usage } from "@onepanda-tiangongsec/tg-ai";
import type { AgentMessage, AgentToolResult } from "../types.ts";
import type { Entry, JsonValue, Register, RegisterNamespace, Transaction } from "./session/types.ts";
import type { Session } from "./session/session.ts";
import type { RunState as OperationProgram } from "./state/index.ts";
import { classifyGeneration } from "./drive/classification.ts";
import { transitionGeneration } from "./drive/generation-transition.ts";

export type OperationKind = "run" | "compaction" | "navigation";
export type OperationStatus = "checkpoint" | "effect_pending" | "completed" | "aborted" | "failed";

export type ControlStatus = "running" | "cancel_requested";

export interface Control {
	readonly status: ControlStatus;
	readonly drainedSteer: readonly AgentMessage[];
	readonly drainedFollowUp: readonly AgentMessage[];
	readonly requestedAt?: number;
}

export interface Inbox {
	/** Entry ids whose payloads live in `pending.entry/{id}`. */
	readonly steer: readonly string[];
	readonly followUp: readonly string[];
	readonly writes: readonly string[];
}

export interface OperationMeta {
	readonly id: string;
	readonly lane: string;
	readonly kind: OperationKind;
	readonly sourceLeafId: string | null;
	/** Resolved prompt for run operations; reserved entry ids for queue admissions. */
	readonly prompt: readonly AgentMessage[];
	readonly startedAt: number;
	readonly customInstructions?: string;
	readonly targetId?: string | null;
	readonly summarize?: boolean;
	readonly label?: string;
}

export interface OperationStateBase {
	readonly id: string;
	readonly lane: string;
	readonly kind: OperationKind;
	readonly status: OperationStatus;
	readonly control: Control;
	readonly inbox: Inbox;
	readonly attempt: number;
	readonly responseEntryId: string | null;
	readonly usageId: string | null;
	readonly latestMessage: AssistantMessage | null;
}

export interface OperationState extends OperationStateBase {
	/** Storage-assigned sequence for the latest lane commit that produced this state. */
	readonly laneStateSeq?: number;
	/** Storage-assigned sequence for the latest op.state commit. */
	readonly operationStateSeq?: number;
	readonly program?: OperationProgram;
	readonly resultEntryId?: string;
}

export interface LaneState {
	readonly lane: string;
	readonly leafId: string | null;
	readonly currentOperationId: string | null;
	readonly pendingNextRun: readonly string[];
}

export interface OperationCommit {
	readonly expectedOperationId?: string;
	readonly expectedLaneStateSeq?: number;
	readonly expectedOperationStateSeq?: number;
	readonly meta?: OperationMeta;
	readonly state?: OperationState;
	readonly lane: LaneState;
	readonly settlement?: {
		readonly entryId: string;
		readonly message: AssistantMessage;
		readonly usage?: Usage;
		readonly usageId?: string;
	};
	readonly compactionEntry?: {
		readonly id: string;
		readonly parentId: string;
		readonly summary: string;
		readonly retainedTail: readonly AssistantMessage[];
		readonly tokensBefore: number;
		readonly usage?: Usage;
		readonly details?: unknown;
	};
	readonly compactionUsage?: { readonly id: string; readonly entryId: string; readonly usage: Usage };
	readonly branchSummaryEntry?: {
		readonly id: string;
		readonly parentId: string;
		readonly summary: string;
		readonly fromId: string;
	};
	readonly toolIntent?: { readonly key: string; readonly args: Record<string, JsonValue> };
	readonly toolIntents?: readonly { readonly key: string; readonly args: Record<string, JsonValue> }[];
	readonly toolSettlement?: {
		readonly entryId: string;
		readonly parentId: string;
		readonly message: AgentMessage;
		readonly usage?: Usage;
		readonly usageId?: string;
		readonly deleteArgsKey?: string;
	};
	readonly queueAdmission?: { readonly kind: "steer" | "followUp"; readonly id: string; readonly message: AgentMessage };
	readonly pendingEntry?: { readonly id: string; readonly message: AgentMessage };
	readonly preparation?: { readonly key: string; readonly value: JsonValue };
	readonly result?: OperationResult;
}

export interface OperationResult {
	readonly operationId: string;
	readonly lane: string;
	readonly kind: OperationKind;
	readonly outcome: "completed" | "aborted" | "failed" | "declined";
	readonly leafId: string | null;
	readonly finalMessage?: AssistantMessage;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface QueueAdmitResult {
	readonly entryId: string;
}

export interface CancelResult {
	readonly outcome: "cancelled" | "already_consumed" | "not_found";
}

export interface AbortResult {
	readonly runId: string;
	readonly steer: readonly AgentMessage[];
	readonly followUp: readonly AgentMessage[];
}

/** Effect-first contract for the operation kernel. */
export interface EffectOperationStore {
	readonly load: (lane: string) => Effect.Effect<{
		readonly lane: LaneState;
		readonly meta?: OperationMeta;
		readonly state?: OperationState;
		readonly laneStateSeq?: number;
		readonly operationStateSeq?: number;
	}, unknown>;
	readonly commit: (
		commit: OperationCommit,
	) => Effect.Effect<{ readonly laneStateSeq?: number; readonly operationStateSeq?: number }, unknown>;
	readonly readLanePath?: (lane: string) => Effect.Effect<readonly Entry[], unknown>;
	readonly readEntry?: (id: string) => Effect.Effect<Entry | undefined, unknown>;
	readonly readQueueMessage?: (id: string) => Effect.Effect<AgentMessage | undefined, unknown>;
}

type OperationSnapshot = {
	readonly lane: LaneState;
	readonly meta?: OperationMeta;
	readonly state?: OperationState;
	readonly laneStateSeq?: number;
	readonly operationStateSeq?: number;
};

export class EffectOperationStoreService extends Context.Service<
	EffectOperationStoreService,
	EffectOperationStore
>()("tg-agent/EffectOperationStore") {}

function asJson(value: unknown): JsonValue {
	return value as JsonValue;
}

const NEW_CONTROL: Control = { status: "running", drainedSteer: [], drainedFollowUp: [] };
const NEW_INBOX: Inbox = { steer: [], followUp: [], writes: [] };
const NEW_PENDING_NEXT_RUN: readonly string[] = [];

function newState(id: string, lane: string, kind: OperationKind, status: OperationStatus): OperationStateBase {
	return { id, lane, kind, status, control: NEW_CONTROL, inbox: NEW_INBOX, attempt: 0, responseEntryId: null, usageId: null, latestMessage: null };
}

function newRunProgram(): OperationProgram {
	return {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 },
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			toolExecution: "parallel",
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
		phase: { kind: "checkpoint", triggerEntryId: "", continuation: { kind: "need_assistant", overflowRecoveryUsed: false } },
	};
}

function newLane(lane: string): LaneState {
	return { lane, leafId: null, currentOperationId: null, pendingNextRun: NEW_PENDING_NEXT_RUN };
}

function writeRegister(writes: Transaction["writes"], namespace: RegisterNamespace, key: string, value: JsonValue) {
	writes.push({ kind: "register", op: "set", namespace, key, value });
}

function deleteRegister(writes: Transaction["writes"], namespace: RegisterNamespace, key: string) {
	writes.push({ kind: "register", op: "delete", namespace, key });
}

/**
 * Builds the Effect operation-store view for an Effect-native session.
 * This is the canonical implementation; no Promise adapter remains.
 */
export function effectSessionOperationStore<TMetadata extends import("./session/types.ts").SessionMetadata = import("./session/types.ts").SessionMetadata>(session: import("./session/session.ts").Session<TMetadata>): EffectOperationStore {
	return {
		load: (lane) => loadFromSession(session, lane),
		commit: (commit) => commitOnSession(session, commit),
		readLanePath: (lane) => readLanePathFromSession(session, lane),
		readEntry: (id) => session.getEntry(id),
		readQueueMessage: (id) => session.getRegister("pending.entry", id).pipe(Effect.map((value) => value?.value as AgentMessage | undefined)),
	};
}

const loadFromSession = <TMetadata extends import("./session/types.ts").SessionMetadata>(session: import("./session/session.ts").Session<TMetadata>, lane: string) =>
	Effect.gen(function* () {
		const [laneState, laneLeaf] = yield* Effect.all([session.getRegister("lane.state", lane), session.getRegister("lane.leaf", lane)]);
		const laneValue = laneState?.value as Partial<LaneState> | undefined;
		const laneSnapshot: LaneState = {
			lane,
			leafId: typeof laneLeaf?.value === "string" ? laneLeaf.value : null,
			currentOperationId: typeof laneValue?.currentOperationId === "string" ? laneValue.currentOperationId : null,
			pendingNextRun: Array.isArray(laneValue?.pendingNextRun) ? [...(laneValue!.pendingNextRun as readonly string[])] : NEW_PENDING_NEXT_RUN,
		};
		if (!laneSnapshot.currentOperationId) return { lane: laneSnapshot };
		const [meta, state] = yield* Effect.all([session.getRegister("op.meta", laneSnapshot.currentOperationId), session.getRegister("op.state", laneSnapshot.currentOperationId)]);
		return {
			lane: laneSnapshot,
			meta: meta?.value as OperationMeta | undefined,
			state: state?.value as OperationState | undefined,
			laneStateSeq: laneState?.seq,
			operationStateSeq: state?.seq,
		} as OperationSnapshot;
	});

const readLanePathFromSession = <TMetadata extends import("./session/types.ts").SessionMetadata>(session: import("./session/session.ts").Session<TMetadata>, lane: string) =>
	Effect.gen(function* () {
		const allEntries = yield* session.findEntries({ order: "oldestFirst" });
		const targetLeaf = (yield* session.getRegister("lane.leaf", lane))?.value as string | null;
		if (!targetLeaf) return [] as readonly Entry[];
		const byId = new Map<string, Entry>(allEntries.map((e) => [e.id, e]));
		const path: Entry[] = [];
		const visited = new Set<string>();
		let current: Entry | undefined = byId.get(targetLeaf);
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			path.push(current);
			if (current.parentId === null) break;
			current = byId.get(current.parentId);
		}
		path.reverse();
		return path as readonly Entry[];
	});

const commitOnSession = <TMetadata extends import("./session/types.ts").SessionMetadata>(session: Session<TMetadata>, commit: OperationCommit) =>
	Effect.gen(function* () {
		if (commit.expectedOperationId !== undefined) {
			const current = yield* session.getRegister("lane.state", commit.lane.lane);
			const currentOperationId = (current?.value as Partial<LaneState> | undefined)?.currentOperationId ?? null;
			if (currentOperationId !== commit.expectedOperationId) throw new Error("stale operation transition");
		}
		if (commit.expectedLaneStateSeq !== undefined || commit.expectedOperationStateSeq !== undefined) {
			const [laneState, operationState] = yield* Effect.all([
				session.getRegister("lane.state", commit.lane.lane),
				commit.expectedOperationStateSeq === undefined
					? Effect.succeed(undefined)
					: session.getRegister("op.state", commit.expectedOperationId ?? ""),
			]);
			if (commit.expectedLaneStateSeq !== undefined && laneState?.seq !== commit.expectedLaneStateSeq) throw new Error("stale lane state transition");
			if (commit.expectedOperationStateSeq !== undefined && operationState?.seq !== commit.expectedOperationStateSeq) throw new Error("stale operation state transition");
		}
		const writes: Transaction["writes"] = [];
		if (commit.settlement) {
			writes.push({
				kind: "entry",
				lane: commit.lane.lane,
				entry: { type: "message", id: commit.settlement.entryId, message: commit.settlement.message },
			});
			if (commit.settlement.usage) {
				writes.push({
					kind: "usage",
					row: {
						id: commit.settlement.usageId ?? "",
						entryId: commit.settlement.entryId,
						usage: commit.settlement.usage,
						adjustment: false,
					},
				});
			}
		}
		if (commit.pendingEntry) {
			writes.push({
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: commit.pendingEntry.id,
				value: asJson(commit.pendingEntry.message),
			});
		}
		if (commit.queueAdmission) {
			writes.push({
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: commit.queueAdmission.id,
				value: asJson(commit.queueAdmission.message),
			});
		}
		if (commit.toolIntent) writeRegister(writes, "op.tool_args", commit.toolIntent.key, asJson(commit.toolIntent.args) as Record<string, JsonValue>);
		for (const intent of commit.toolIntents ?? []) writeRegister(writes, "op.tool_args", intent.key, asJson(intent.args) as Record<string, JsonValue>);
		if (commit.toolSettlement) {
			writes.push({
				kind: "entry",
				lane: commit.lane.lane,
				parentId: commit.toolSettlement.parentId,
				entry: { type: "message", id: commit.toolSettlement.entryId, message: commit.toolSettlement.message },
			});
			if (commit.toolSettlement.usage && commit.toolSettlement.usageId) {
				writes.push({
					kind: "usage",
					row: {
						id: commit.toolSettlement.usageId,
						entryId: commit.toolSettlement.entryId,
						usage: commit.toolSettlement.usage,
						adjustment: false,
					},
				});
			}
			if (commit.toolSettlement.deleteArgsKey) deleteRegister(writes, "op.tool_args", commit.toolSettlement.deleteArgsKey);
		}
		if (commit.compactionEntry) {
			writes.push({
				kind: "entry",
				lane: commit.lane.lane,
				parentId: commit.compactionEntry.parentId,
				entry: {
					type: "compaction",
					id: commit.compactionEntry.id,
					summary: commit.compactionEntry.summary,
					retainedTail: [...commit.compactionEntry.retainedTail],
					tokensBefore: commit.compactionEntry.tokensBefore,
					...(commit.compactionEntry.usage ? { usage: commit.compactionEntry.usage } : {}),
					...(commit.compactionEntry.details !== undefined ? { details: commit.compactionEntry.details } : {}),
				},
			});
			if (commit.compactionUsage) {
				writes.push({
					kind: "usage",
					row: {
						id: commit.compactionUsage.id,
						entryId: commit.compactionUsage.id,
						usage: commit.compactionUsage.usage,
						adjustment: false,
					},
				});
			}
		}
		if (commit.branchSummaryEntry) {
			writes.push({
				kind: "entry",
				lane: commit.lane.lane,
				parentId: commit.branchSummaryEntry.parentId,
				entry: {
					type: "branch_summary",
					id: commit.branchSummaryEntry.id,
					fromId: commit.branchSummaryEntry.fromId,
					summary: commit.branchSummaryEntry.summary,
				},
			});
		}
		if (commit.preparation !== undefined) writeRegister(writes, "op.preparation", commit.preparation.key, commit.preparation.value);
		if (commit.meta === undefined && commit.expectedOperationId) {
			const [toolArgs, preparations] = yield* Effect.all([
				session.listRegisters("op.tool_args", `${commit.expectedOperationId}:`),
				session.listRegisters("op.preparation", `${commit.expectedOperationId}:`),
			]);
			for (const register of [...toolArgs, ...preparations]) {
				writes.push({ kind: "register", op: "delete", namespace: register.namespace, key: register.key });
			}
		}
		writeRegister(writes, "lane.leaf", commit.lane.lane, asJson(commit.lane.leafId));
		writeRegister(writes, "lane.state", commit.lane.lane, asJson(commit.lane));
		if (commit.meta) writeRegister(writes, "op.meta", commit.meta.id, asJson(commit.meta));
		else if (commit.expectedOperationId) deleteRegister(writes, "op.meta", commit.expectedOperationId);
		if (commit.state) writeRegister(writes, "op.state", commit.state.id, asJson(commit.state));
		else if (commit.expectedOperationId) deleteRegister(writes, "op.state", commit.expectedOperationId);
		if (commit.result) writeRegister(writes, "lane.lastResult", commit.lane.lane, asJson(commit.result));
		const committed = yield* session.commit({ writes });
		const [laneState, operationState] = yield* Effect.all([
			session.getRegister("lane.state", commit.lane.lane),
			commit.expectedOperationId ? session.getRegister("op.state", commit.expectedOperationId) : Effect.succeed(undefined),
		]);
		return {
			laneStateSeq: laneState?.seq ?? committed.seqs.at(-1),
			operationStateSeq: operationState?.seq,
		};
	});

/** In-memory Effect-native operation store used by tests. */
export class InMemoryOperationStore implements EffectOperationStore {
	private readonly lanes = new Map<string, { lane: LaneState; meta?: OperationMeta; state?: OperationState }>();
	private readonly results = new Map<string, OperationResult>();
	private readonly settlements = new Map<string, NonNullable<OperationCommit["settlement"]>>();
	private readonly queueMessages = new Map<string, AgentMessage>();
	private readonly nextRunQueue = new Map<string, AgentMessage>();
	private readonly entries = new Map<string, Entry>();
	private sequence = 0;
	private readonly laneStateSeq = new Map<string, number>();
	private readonly operationStateSeq = new Map<string, number>();

	constructor(lanes: readonly string[] = ["main"]) {
		for (const lane of lanes) this.lanes.set(lane, { lane: newLane(lane) });
	}

	load(lane: string) {
		const current = this.lanes.get(lane);
		if (!current) {
			const created = { lane: newLane(lane) };
			this.lanes.set(lane, created);
			return Effect.succeed(structuredClone(created));
		}
		return Effect.succeed(structuredClone({
			...current,
			laneStateSeq: this.laneStateSeq.get(lane),
			operationStateSeq: current.state ? this.operationStateSeq.get(current.state.id) : undefined,
		}));
	}

	commit(commit: OperationCommit) {
		const current = this.lanes.get(commit.lane.lane);
		if (commit.expectedOperationId !== undefined && current?.lane.currentOperationId !== commit.expectedOperationId) {
			return Effect.fail(new OperationInvariantViolation({ message: "stale operation transition" }));
		}
		if (commit.lane.currentOperationId && current?.lane.currentOperationId && commit.lane.currentOperationId !== current.lane.currentOperationId) {
			return Effect.fail(new OperationInvariantViolation({ message: "stale operation transition" }));
		}
		if (commit.expectedLaneStateSeq !== undefined && this.laneStateSeq.get(commit.lane.lane) !== commit.expectedLaneStateSeq) return Effect.fail(new OperationInvariantViolation({ message: "stale lane state transition" }));
		if (commit.expectedOperationStateSeq !== undefined && this.operationStateSeq.get(commit.expectedOperationId ?? "") !== commit.expectedOperationStateSeq) return Effect.fail(new OperationInvariantViolation({ message: "stale operation state transition" }));
		this.lanes.set(commit.lane.lane, structuredClone({ lane: commit.lane, meta: commit.meta, state: commit.state }));
		if (commit.settlement) {
			this.entries.set(commit.settlement.entryId, {
				type: "message",
				id: commit.settlement.entryId,
				message: structuredClone(commit.settlement.message),
				parentId: null,
				seq: this.entries.size + 1,
				timestamp: Date.now(),
			} as Entry);
		}
		if (commit.settlement) this.settlements.set(commit.settlement.entryId, structuredClone(commit.settlement));
		if (commit.pendingEntry) this.nextRunQueue.set(commit.pendingEntry.id, structuredClone(commit.pendingEntry.message));
		if (commit.queueAdmission) this.queueMessages.set(commit.queueAdmission.id, structuredClone(commit.queueAdmission.message));
		if (commit.result) this.results.set(commit.result.operationId, structuredClone(commit.result));
		const laneSeq = ++this.sequence;
		this.laneStateSeq.set(commit.lane.lane, laneSeq);
		const operationStateId = commit.state?.id;
		const operationSeq = operationStateId ? ++this.sequence : undefined;
		if (operationSeq !== undefined && operationStateId !== undefined) this.operationStateSeq.set(operationStateId, operationSeq);
		return Effect.succeed({ laneStateSeq: laneSeq, operationStateSeq: operationSeq });
	}

	readLanePath(_lane: string) {
		return Effect.succeed<readonly Entry[]>([]);
	}

	readEntry(id: string) {
		return Effect.succeed(this.entries.get(id));
	}

	readQueueMessage(id: string) {
		return Effect.succeed(this.getQueueMessage(id) ?? this.getNextRunMessage(id));
	}

	getResult(operationId: string): OperationResult | undefined {
		return structuredClone(this.results.get(operationId));
	}

	getSettlement(entryId: string): NonNullable<OperationCommit["settlement"]> | undefined {
		return structuredClone(this.settlements.get(entryId));
	}

	getQueueMessage(entryId: string): AgentMessage | undefined {
		return structuredClone(this.queueMessages.get(entryId));
	}

	getNextRunMessage(entryId: string): AgentMessage | undefined {
		return structuredClone(this.nextRunQueue.get(entryId));
	}
}

export interface OperationEffects {
	readonly prepareMessages?: (input: { readonly lane: string; readonly prompt: readonly AgentMessage[] }) => Effect.Effect<readonly AgentMessage[], unknown>;
	readonly generate: (input: {
		readonly model: Model<Api>;
		readonly messages: readonly AgentMessage[];
		readonly attempt: number;
	}) => Effect.Effect<{ readonly message: AssistantMessage; readonly usage?: Usage }, unknown>;
	/** Generate a compaction summary; returns the result or a typed error. */
	readonly summarize: (
		preparation: import("./compaction/compaction.ts").CompactionPreparation,
		customInstructions: string | undefined,
	) => Effect.Effect<
		| { readonly ok: true; readonly result: import("./compaction/compaction.ts").CompactResult }
		| { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
		unknown
	>;
	/** Generate a branch summary for navigation. */
	readonly summarizeBranch: (
		entries: ReadonlyMap<string, Entry>,
		tokenBudget: number,
	) => Effect.Effect<{ readonly summary: string; readonly usage?: Usage } | { readonly error: { readonly code: string; readonly message: string } }, unknown>;
	readonly executeTool?: (input: {
		readonly toolCallId: string;
		readonly name: string;
		readonly args: Record<string, unknown>;
		readonly replay: "never" | "safe";
	}) => Effect.Effect<{ readonly result: AgentToolResult<unknown>; readonly isError: boolean }, unknown>;
	readonly toolReplay?: (name: string) => "never" | "safe" | undefined;
	readonly fetchDeferred?: (input: {
		readonly handle: unknown;
		readonly poll: number;
	}) => Effect.Effect<{ readonly message: AssistantMessage; readonly pending: boolean }, unknown>;
	readonly cancelDeferred?: (handle: unknown) => Effect.Effect<void, unknown>;
}

export class OperationBusy extends Data.TaggedError("OperationBusy")<{
	readonly lane: string;
	readonly operationId: string;
	readonly kind: OperationKind;
}> {}
export class OperationNotFound extends Data.TaggedError("OperationNotFound")<{
	readonly lane: string;
}> {}
export class NoActiveRun extends Data.TaggedError("NoActiveRun")<{
	readonly lane: string;
}> {}
export class OperationInvariantViolation extends Data.TaggedError("OperationInvariantViolation")<{
	readonly message: string;
}> {}
export class QueueItemNotFound extends Data.TaggedError("QueueItemNotFound")<{
	readonly lane: string;
	readonly entryId: string;
}> {}
export class QueueItemAlreadyConsumed extends Data.TaggedError("QueueItemAlreadyConsumed")<{
	readonly lane: string;
	readonly entryId: string;
}> {}

export class NothingToCompact extends Data.TaggedError("NothingToCompact")<{ readonly lane: string }> {}
export class InvalidNavigationTarget extends Data.TaggedError("InvalidNavigationTarget")<{ readonly lane: string; readonly targetId: string | null }> {}

const emptyLane = (lane: string): LaneState => newLane(lane);

function loadLane(store: EffectOperationStore, lane: string) {
	return store.load(lane).pipe(
		Effect.catch((cause) => Effect.fail(new OperationInvariantViolation({ message: String(cause) }))),
	);
}

function commitEffect(
	store: EffectOperationStore,
	commit: OperationCommit,
): Effect.Effect<{ readonly laneStateSeq?: number; readonly operationStateSeq?: number }, OperationInvariantViolation> {
	return store.commit(commit).pipe(
		Effect.catch((cause) => Effect.fail(new OperationInvariantViolation({ message: String(cause) }))),
	);
}

function withEffectCas(store: EffectOperationStore, snapshot: OperationSnapshot): EffectOperationStore {
	let laneStateSeq = snapshot.laneStateSeq;
	let operationStateSeq = snapshot.operationStateSeq;
	return {
		load: (lane) => store.load(lane),
		readLanePath: store.readLanePath ? (lane) => store.readLanePath!(lane) : undefined,
		readEntry: store.readEntry ? (id) => store.readEntry!(id) : undefined,
		commit: (commit) =>
			store.commit({
				...commit,
				...(commit.expectedLaneStateSeq === undefined && laneStateSeq !== undefined
					? { expectedLaneStateSeq: laneStateSeq }
					: {}),
				...(commit.expectedOperationStateSeq === undefined && operationStateSeq !== undefined
					? { expectedOperationStateSeq: operationStateSeq }
					: {}),
			}).pipe(
				Effect.tap((result) =>
					Effect.sync(() => {
						laneStateSeq = result.laneStateSeq;
						operationStateSeq = result.operationStateSeq;
					}),
				),
			),
		readQueueMessage: store.readQueueMessage,
	};
}

function finalizeFailureEffect(
	store: EffectOperationStore,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
	code: string,
	message: string,
	leafId: string | null = current.lane.leafId,
): Effect.Effect<OperationResult, unknown> {
	const result: OperationResult = {
		operationId: meta.id,
		lane,
		kind: meta.kind as "compaction" | "navigation",
		outcome: "failed",
		leafId,
		error: { code, message },
	};
	return store.commit({
		expectedOperationId: meta.id,
		meta: undefined,
		state: undefined,
		lane: { ...current.lane, currentOperationId: null },
		result,
	}).pipe(Effect.map(() => result));
}

function finalizeDeclinedEffect(
	store: EffectOperationStore,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
): Effect.Effect<OperationResult, unknown> {
	const result: OperationResult = {
		operationId: meta.id,
		lane,
		kind: meta.kind as "compaction" | "navigation",
		outcome: "declined",
		leafId: current.lane.leafId,
	};
	return store.commit({
		expectedOperationId: meta.id,
		meta: undefined,
		state: undefined,
		lane: { ...current.lane, currentOperationId: null },
		result,
	}).pipe(Effect.map(() => result));
}

function runCompactionEffect(
	store: EffectOperationStore,
	effects: OperationEffects,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
	state: OperationState,
): Effect.Effect<OperationResult, unknown> {
	return Effect.gen(function* () {
		const pathEntries = store.readLanePath ? yield* store.readLanePath(lane) : [];
		const { prepareCompaction } = yield* Effect.promise(() => import("./compaction/compaction.ts"));
		const prep = prepareCompaction([...pathEntries], { keepRecentTokens: 2000, reserveTokens: 500, enabled: true });
		if (!prep.ok) return yield* finalizeFailureEffect(store, lane, current, meta, "preparation_failed", prep.error.message);
		if (prep.value === undefined) return yield* finalizeDeclinedEffect(store, lane, current, meta);
		const summaryResult = yield* effects.summarize(prep.value, meta.customInstructions);
		if (!summaryResult.ok) return yield* finalizeFailureEffect(store, lane, current, meta, "summarization_failed", summaryResult.error.message);
		const compactResult = summaryResult.result;
		const compactEntryId = state.resultEntryId ?? crypto.randomUUID();
		const usageId = compactResult.usage ? crypto.randomUUID() : null;
		const result: OperationResult = { operationId: meta.id, lane, kind: "compaction", outcome: "completed", leafId: compactEntryId };
		yield* store.commit({
			expectedOperationId: meta.id,
			meta: undefined,
			state: undefined,
			lane: { ...current.lane, leafId: compactEntryId, currentOperationId: null },
			result,
			compactionEntry: {
				id: compactEntryId,
				parentId: current.lane.leafId ?? "",
				summary: compactResult.summary,
				retainedTail: [...compactResult.retainedTail] as readonly AssistantMessage[],
				tokensBefore: compactResult.tokensBefore,
				...(compactResult.details !== undefined ? { details: compactResult.details } : {}),
				...(compactResult.usage ? { usage: compactResult.usage } : {}),
			},
			...(usageId && compactResult.usage ? { compactionUsage: { id: usageId, entryId: compactEntryId, usage: compactResult.usage } } : {}),
		});
		return result;
	});
}

function runNavigationEffect(
	store: EffectOperationStore,
	effects: OperationEffects,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
): Effect.Effect<OperationResult, unknown> {
	return Effect.gen(function* () {
		if (!meta.targetId) return yield* finalizeDeclinedEffect(store, lane, current, meta);
		const newLeafId = meta.targetId;
		if (meta.summarize) {
			const entries = store.readLanePath ? yield* store.readLanePath(lane) : [];
			const branchResult = yield* effects.summarizeBranch(new Map(entries.map((entry) => [entry.id, entry])), 8000);
			if ("error" in branchResult) return yield* finalizeFailureEffect(store, lane, current, meta, "branch_summary_failed", branchResult.error.message, newLeafId);
			const summaryEntryId = crypto.randomUUID();
			const result: OperationResult = { operationId: meta.id, lane, kind: "navigation", outcome: "completed", leafId: summaryEntryId };
			yield* store.commit({ expectedOperationId: meta.id, meta: undefined, state: undefined, lane: { ...current.lane, leafId: summaryEntryId, currentOperationId: null }, result, branchSummaryEntry: { id: summaryEntryId, parentId: newLeafId, summary: branchResult.summary, fromId: current.lane.leafId ?? "" } });
			return result;
		}
		const result: OperationResult = { operationId: meta.id, lane, kind: "navigation", outcome: "completed", leafId: newLeafId };
		yield* store.commit({ expectedOperationId: meta.id, meta: undefined, state: undefined, lane: { ...current.lane, leafId: newLeafId, currentOperationId: null }, result });
		return result;
	});
}

function runGenerationEffect(
	store: EffectOperationStore,
	effects: OperationEffects,
	model: Model<Api>,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
	pending: OperationState,
): Effect.Effect<OperationResult, unknown> {
	return Effect.gen(function* () {
		const maxAttempts = 3;
		const contextWindow = model.contextWindow || 128_000;
		const intendedOutputLimit = model.maxTokens || 4_096;
		const programBase: OperationProgram = {
			kind: "run",
			control: { status: "running" },
			settings: { compaction: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 }, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", toolExecution: "parallel" },
			inbox: { steer: [], followUp: [], writes: [] },
			latestAssistantEntryId: null,
			phase: { kind: "checkpoint", triggerEntryId: meta.sourceLeafId ?? "", continuation: { kind: "need_assistant", overflowRecoveryUsed: false } },
		};
		let attempt = pending.attempt;
		let leafId = current.lane.leafId;
		let laneState = current.lane;
		let latestProgram = current.state?.program ?? programBase;
		while (attempt <= maxAttempts) {
			const responseEntryId = attempt === pending.attempt ? (pending.responseEntryId ?? crypto.randomUUID()) : crypto.randomUUID();
			const usageId = attempt === pending.attempt ? (pending.usageId ?? crypto.randomUUID()) : crypto.randomUUID();
			const generationPending = {
				status: "effect_pending" as const,
				context: { stepId: `${meta.id}:s${attempt}`, triggerEntryId: leafId ?? "", configuration: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" as const, activeToolNames: [] }, streamOptions: {}, retryPolicy: { maxAttempts, baseDelayMs: 1000 }, overflowRecoveryUsed: false },
				attempt, responseEntryId, usageId, intendedOutputLimit, contextWindow,
			};
			yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...pending, attempt, responseEntryId, usageId, program: { ...latestProgram, phase: { kind: "assistant", generation: generationPending } } }, lane: laneState });
			const messages = effects.prepareMessages ? yield* effects.prepareMessages({ lane, prompt: meta.prompt }) : meta.prompt;
			const output = yield* effects.generate({ model, messages, attempt });
			const settlement = classifyGeneration({ control: { status: "running" }, message: output.message, attempt, maxAttempts, intendedOutputLimit, contextWindow });
			const nextProgram = transitionGeneration({ state: latestProgram, generation: generationPending, responseEntryId, message: output.message, now: Date.now() }, settlement);
			latestProgram = nextProgram;
			if (settlement.kind === "retry") {
				laneState = { ...laneState, leafId: responseEntryId };
				leafId = responseEntryId;
				yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...pending, status: "checkpoint", attempt, responseEntryId, usageId, latestMessage: output.message, program: nextProgram }, lane: laneState, settlement: { entryId: responseEntryId, message: output.message, usageId, usage: output.usage } });
				if (nextProgram.phase.kind === "assistant" && nextProgram.phase.generation.status === "retry_wait") {
					const delay = Math.max(0, nextProgram.phase.generation.notBefore - Date.now());
					if (delay > 0) yield* Effect.sleep(delay);
				}
				attempt = settlement.nextAttempt;
				continue;
			}
			if (settlement.kind === "tool_use" || settlement.kind === "deferred" || settlement.kind === "overflow") {
				laneState = { ...laneState, leafId: responseEntryId };
				yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...pending, status: "checkpoint", attempt, responseEntryId, usageId, latestMessage: output.message, program: nextProgram }, lane: laneState, settlement: { entryId: responseEntryId, message: output.message, usageId, usage: output.usage } });
				return { operationId: meta.id, lane, kind: "run", outcome: "completed", leafId: responseEntryId, finalMessage: output.message };
			}
			const outcome: OperationResult["outcome"] = settlement.kind === "failed" ? "failed" : settlement.kind === "aborted" ? "aborted" : "completed";
			const error = settlement.kind === "failed" ? { code: "provider_error", message: settlement.errorMessage } : settlement.kind === "aborted" ? { code: "aborted", message: "Operation aborted" } : undefined;
			const result: OperationResult = { operationId: meta.id, lane, kind: "run", outcome, leafId: responseEntryId, ...(error ? { error } : {}), ...(output.message ? { finalMessage: output.message } : {}) };
			yield* commitEffect(store, { expectedOperationId: meta.id, meta: undefined, state: undefined, lane: { ...laneState, leafId: responseEntryId, currentOperationId: null }, result, settlement: { entryId: responseEntryId, message: output.message, usageId, usage: output.usage } });
			return result;
		}
		const exhausted: OperationResult = { operationId: meta.id, lane, kind: "run", outcome: "failed", leafId, error: { code: "retries_exhausted", message: `Generation exhausted ${maxAttempts} attempts` } };
		yield* commitEffect(store, { expectedOperationId: meta.id, meta: undefined, state: undefined, lane: { ...laneState, currentOperationId: null }, result: exhausted });
		return exhausted;
	});
}

function runToolBatchEffect(
	store: EffectOperationStore,
	effects: OperationEffects,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
): Effect.Effect<OperationResult, unknown> {
	return Effect.gen(function* () {
		const state = current.state;
		const program = state?.program;
		if (!state || !program || program.phase.kind !== "tools") return yield* Effect.fail(new OperationInvariantViolation({ message: "tool batch state missing" }));
		if (program.control.status === "cancel_requested") {
			const result: OperationResult = { operationId: meta.id, lane, kind: "run", outcome: "aborted", leafId: current.lane.leafId };
			yield* commitEffect(store, { expectedOperationId: meta.id, meta: undefined, state: undefined, lane: { ...current.lane, currentOperationId: null }, result });
			return result;
		}
		let nextProgram = program;
		let laneState = current.lane;
		const initialBatch = program.phase.batch;
		const assistant = state.latestMessage;
		const toolCalls = assistant?.role === "assistant"
			? assistant.content.filter((content): content is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => content.type === "toolCall")
			: [];
		if (program.settings.toolExecution === "parallel") {
			return yield* runParallelToolBatchEffect(store, effects, lane, current, meta, state, program, initialBatch, toolCalls);
		}
		for (let sourceIndex = 0; sourceIndex < initialBatch.calls.length; sourceIndex++) {
			const batch = nextProgram.phase.kind === "tools" ? nextProgram.phase.batch : undefined;
			const planned = batch?.calls[sourceIndex];
			if (!batch || !planned || planned.status === "completed") continue;
			const source = toolCalls[planned.sourceIndex];
			const args = source?.arguments && typeof source.arguments === "object" ? source.arguments as Record<string, unknown> : {};
			const replay = effects.toolReplay?.(source?.name ?? "unknown") ?? "never";
			const argsKey = `${meta.id}:${batch.turnId}:${planned.sourceIndex}`;
			const effectPendingCalls = batch.calls.map((call, index) => index === sourceIndex && call.status === "planned" ? { ...call, status: "effect_pending" as const, replay } : call);
			nextProgram = { ...nextProgram, phase: { kind: "tools", batch: { ...batch, calls: effectPendingCalls } } };
			yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, program: nextProgram }, lane: laneState, toolIntent: { key: argsKey, args: asJson(args) as Record<string, JsonValue> } });
			const executed = !source || !effects.executeTool
				? { result: { content: [{ type: "text" as const, text: source ? `Tool not registered: ${source.name}` : "Tool call source not found" }], details: {} } as AgentToolResult<unknown>, isError: true }
				: yield* effects.executeTool({ toolCallId: source.id, name: source.name, args, replay }).pipe(
					Effect.catch(() => Effect.succeed({ result: { content: [{ type: "text" as const, text: "tool execution failed" }], details: {} } as AgentToolResult<unknown>, isError: true })),
				);
			const toolMessage: AgentMessage = { role: "toolResult", toolCallId: source?.id ?? `missing:${sourceIndex}`, toolName: source?.name ?? "unknown", content: executed.result.content, details: executed.result.details, isError: executed.isError, timestamp: Date.now() };
			const completedCalls = effectPendingCalls.map((call, index) => index === sourceIndex ? { status: "completed" as const, sourceIndex: call.sourceIndex, resultEntryId: call.resultEntryId, terminate: executed.result.terminate === true } : call);
			const complete = completedCalls.every((call) => call.status === "completed");
			const allTerminate = complete && completedCalls.every((call) => call.status === "completed" && call.terminate);
			const nextPhase = complete ? { kind: "checkpoint" as const, triggerEntryId: planned.resultEntryId, continuation: allTerminate ? { kind: "may_finish" as const, includeFinalAssistant: false } : { kind: "need_assistant" as const, overflowRecoveryUsed: false } } : { kind: "tools" as const, batch: { ...batch, calls: completedCalls } };
			nextProgram = { ...nextProgram, phase: nextPhase };
			const parentId = laneState.leafId ?? batch.assistantEntryId;
			laneState = { ...laneState, leafId: planned.resultEntryId };
			yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "checkpoint", program: nextProgram }, lane: laneState, toolSettlement: { entryId: planned.resultEntryId, parentId, message: toolMessage, usage: executed.result.usage, usageId: executed.result.usage ? crypto.randomUUID() : undefined, deleteArgsKey: argsKey } });
		}
		return { operationId: meta.id, lane, kind: "run", outcome: "completed", leafId: laneState.leafId };
	});
}

function runParallelToolBatchEffect(
	store: EffectOperationStore,
	effects: OperationEffects,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
	state: OperationState,
	program: OperationProgram,
	initialBatch: Extract<OperationProgram["phase"], { kind: "tools" }>["batch"],
	toolCalls: readonly Extract<AssistantMessage["content"][number], { type: "toolCall" }>[],
): Effect.Effect<OperationResult, unknown> {
	return Effect.gen(function* () {
		type ToolOutcome = {
			readonly call: (typeof initialBatch.calls)[number];
			readonly result: AgentToolResult<unknown>;
			readonly isError: boolean;
		};
		const pendingCalls = initialBatch.calls.map((call) => call.status === "planned" ? { ...call, status: "effect_pending" as const, replay: effects.toolReplay?.(toolCalls[call.sourceIndex]?.name ?? "unknown") ?? "never" as const } : call);
		const pendingProgram: OperationProgram = { ...program, phase: { kind: "tools", batch: { ...initialBatch, calls: pendingCalls } } };
		yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, program: pendingProgram }, lane: current.lane });
		const toolIntents = initialBatch.calls.filter((call) => call.status === "planned").map((call) => {
			const source = toolCalls[call.sourceIndex];
			const args = source?.arguments && typeof source.arguments === "object" ? source.arguments as Record<string, unknown> : {};
			return { key: `${meta.id}:${initialBatch.turnId}:${call.sourceIndex}`, args: asJson(args) as Record<string, JsonValue> };
		});
		if (toolIntents.length > 0) yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, program: pendingProgram }, lane: current.lane, toolIntents });
		const executed = yield* Effect.forEach(initialBatch.calls, (call): Effect.Effect<ToolOutcome, never> => {
			if (call.status !== "planned") return Effect.succeed({ call, result: { content: [{ type: "text" as const, text: "" }], details: {} } as AgentToolResult<unknown>, isError: false });
			const source = toolCalls[call.sourceIndex];
			if (!source || !effects.executeTool) return Effect.succeed({ call, result: { content: [{ type: "text" as const, text: source ? `Tool not registered: ${source.name}` : "Tool call source not found" }], details: {} } as AgentToolResult<unknown>, isError: true });
			return effects.executeTool({ toolCallId: source.id, name: source.name, args: source.arguments as Record<string, unknown>, replay: effects.toolReplay?.(source.name) ?? "never" }).pipe(
				Effect.map((result) => ({ call, ...result } as ToolOutcome)),
				Effect.catch(() => Effect.succeed<ToolOutcome>({ call, result: { content: [{ type: "text" as const, text: "tool execution failed" }], details: {} } as AgentToolResult<unknown>, isError: true })),
			);
		}, { concurrency: "unbounded" });
		let nextProgram = pendingProgram;
		let laneState = current.lane;
		for (const outcome of executed) {
			if (outcome.call.status !== "planned") continue;
			const source = toolCalls[outcome.call.sourceIndex];
			const resultEntryId = outcome.call.resultEntryId;
			const calls = (nextProgram.phase.kind === "tools" ? nextProgram.phase.batch.calls : pendingCalls).map((call) => call.sourceIndex === outcome.call.sourceIndex ? { ...call, status: "completed" as const, terminate: outcome.result.terminate === true } : call);
			const complete = calls.every((call) => call.status === "completed");
			nextProgram = { ...nextProgram, phase: complete ? { kind: "checkpoint", triggerEntryId: resultEntryId, continuation: calls.every((call) => call.terminate) ? { kind: "may_finish", includeFinalAssistant: false } : { kind: "need_assistant", overflowRecoveryUsed: false } } : { kind: "tools", batch: { ...initialBatch, calls } } };
			const message: AgentMessage = { role: "toolResult", toolCallId: source?.id ?? `missing:${outcome.call.sourceIndex}`, toolName: source?.name ?? "unknown", content: outcome.result.content, details: outcome.result.details, isError: outcome.isError, timestamp: Date.now() };
			const parentId = laneState.leafId ?? initialBatch.assistantEntryId;
			laneState = { ...laneState, leafId: resultEntryId };
			yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "checkpoint", program: nextProgram }, lane: laneState, toolSettlement: { entryId: resultEntryId, parentId, message, usage: outcome.result.usage, usageId: outcome.result.usage ? crypto.randomUUID() : undefined, deleteArgsKey: `${meta.id}:${initialBatch.turnId}:${outcome.call.sourceIndex}` } });
		}
		return { operationId: meta.id, lane, kind: "run", outcome: "completed", leafId: laneState.leafId };
	});
}

function runInRunCompactionEffect(
	store: EffectOperationStore,
	effects: OperationEffects,
	model: Model<Api>,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
): Effect.Effect<OperationResult, unknown> {
	return Effect.gen(function* () {
		const state = current.state;
		const program = state?.program;
		if (!state || !program || program.phase.kind !== "compaction") return yield* Effect.fail(new OperationInvariantViolation({ message: "in-run compaction state missing" }));
		const phase = program.phase;
		const path = store.readLanePath ? yield* store.readLanePath(lane) : [];
		const { prepareCompaction } = yield* Effect.promise(() => import("./compaction/compaction.ts"));
		const prepared = prepareCompaction([...path], program.settings.compaction);
		if (!prepared.ok || !prepared.value) {
			const nextPhase = phase.reason === "threshold" && prepared.ok ? phase.resumeAfter : { kind: "failure_drain" as const, error: { code: prepared.ok ? "overflow_compaction_empty" : "compaction_preparation_failed", message: prepared.ok ? "Overflow compaction had no eligible content" : prepared.error.message }, provenance: { kind: "structural" as const, taskId: phase.structural.taskId } };
			const nextProgram = { ...program, phase: nextPhase };
			yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "checkpoint", program: nextProgram }, lane: current.lane });
			return { operationId: meta.id, lane, kind: "run", outcome: nextPhase.kind === "failure_drain" ? "failed" : "completed", leafId: current.lane.leafId, ...(nextPhase.kind === "failure_drain" ? { error: nextPhase.error } : {}) };
		}
		const preparation = prepared.value;
		const taskId = phase.structural.taskId;
		const resultEntryId = crypto.randomUUID();
		const summaryContext = { taskId, resultEntryId, kind: "compaction" as const, configuration: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" as const, activeToolNames: [] }, streamOptions: {}, retryPolicy: { maxAttempts: 1, baseDelayMs: 0 }, reason: phase.reason };
		const readyProgram: OperationProgram = { ...program, phase: { ...phase, structural: { taskId, status: "generating", generation: { status: "ready", context: summaryContext, nextAttempt: 1 } } } };
		const durablePreparation = { kind: "compaction", messagesToSummarize: preparation.messagesToSummarize, turnPrefixMessages: preparation.turnPrefixMessages, retainedTail: preparation.retainedTail, isSplitTurn: preparation.isSplitTurn, tokensBefore: preparation.tokensBefore, previousSummary: preparation.previousSummary, fileOps: { read: [...preparation.fileOps.read].sort(), written: [...preparation.fileOps.written].sort(), edited: [...preparation.fileOps.edited].sort() }, settings: preparation.settings };
		yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, program: readyProgram }, lane: current.lane, preparation: { key: `${meta.id}:${taskId}`, value: asJson(durablePreparation) } });
		const pendingProgram: OperationProgram = { ...readyProgram, phase: { ...phase, structural: { taskId, status: "generating", generation: { status: "effect_pending", context: summaryContext, attempt: 1, usageIds: [] } } } };
		yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "effect_pending", program: pendingProgram }, lane: current.lane });
		const summarized = yield* effects.summarize(preparation, undefined);
		if (!summarized.ok) {
			const failedProgram: OperationProgram = { ...program, phase: { kind: "failure_drain", error: { code: summarized.error.code, message: summarized.error.message }, provenance: { kind: "structural", taskId } } };
			yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "failed", program: failedProgram }, lane: current.lane });
			return { operationId: meta.id, lane, kind: "run", outcome: "failed", leafId: current.lane.leafId, error: summarized.error };
		}
		const compactResult = summarized.result;
		const nextProgram: OperationProgram = { ...program, phase: phase.resumeAfter };
		yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "checkpoint", program: nextProgram }, lane: { ...current.lane, leafId: resultEntryId }, compactionEntry: { id: resultEntryId, parentId: current.lane.leafId ?? "", summary: compactResult.summary, retainedTail: compactResult.retainedTail as readonly AssistantMessage[], tokensBefore: compactResult.tokensBefore, usage: compactResult.usage as Usage | undefined, details: compactResult.details }, compactionUsage: compactResult.usage ? { id: crypto.randomUUID(), entryId: resultEntryId, usage: compactResult.usage as Usage } : undefined });
		return { operationId: meta.id, lane, kind: "run", outcome: "completed", leafId: resultEntryId };
	});
}

function runDeferredPollEffect(
	store: EffectOperationStore,
	effects: OperationEffects,
	lane: string,
	current: OperationSnapshot,
	meta: OperationMeta,
): Effect.Effect<OperationResult, unknown> {
	return Effect.gen(function* () {
		const state = current.state;
		const program = state?.program;
		if (!state || !program || program.kind !== "run" || program.phase.kind !== "deferred") {
			return yield* Effect.fail(new OperationInvariantViolation({ message: "deferred state missing" }));
		}
		const sourceEntry = state.latestMessage;
		const handle = sourceEntry?.role === "assistant" ? sourceEntry.deferred : undefined;
		if (!handle || !effects.fetchDeferred) {
			return { operationId: meta.id, lane, kind: "run", outcome: "completed", leafId: current.lane.leafId, finalMessage: sourceEntry ?? undefined };
		}
		const deferred = program.phase.deferred;
		const responseEntryId = deferred.status === "effect_pending" ? deferred.responseEntryId : crypto.randomUUID();
		const usageId = deferred.status === "effect_pending" ? deferred.usageId : crypto.randomUUID();
		const poll = deferred.status === "effect_pending" ? deferred.poll : deferred.poll + 1;
		const pendingDeferred = { status: "effect_pending" as const, stepId: deferred.stepId, sourceEntryId: deferred.sourceEntryId, poll, responseEntryId, usageId, configuration: deferred.configuration, streamOptions: deferred.streamOptions };
		const pendingProgram: OperationProgram = { ...program, phase: { kind: "deferred", deferred: pendingDeferred } };
		if (deferred.status === "suspended") {
			yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "effect_pending", responseEntryId, usageId, program: pendingProgram }, lane: current.lane });
		}
		const polled = yield* effects.fetchDeferred({ handle, poll });
		if (polled.pending) {
			const suspendedProgram: OperationProgram = { ...program, phase: { kind: "deferred", deferred: { status: "suspended", stepId: pendingDeferred.stepId, sourceEntryId: responseEntryId, poll, configuration: pendingDeferred.configuration, streamOptions: pendingDeferred.streamOptions } } };
			yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "checkpoint", responseEntryId, usageId, latestMessage: polled.message, program: suspendedProgram }, lane: { ...current.lane, leafId: responseEntryId }, settlement: { entryId: responseEntryId, message: polled.message, usageId, usage: polled.message.usage } });
			return { operationId: meta.id, lane, kind: "run", outcome: "completed", leafId: responseEntryId, finalMessage: polled.message };
		}
		const nextPhase: OperationProgram["phase"] = polled.message.stopReason === "toolUse"
			? { kind: "tools", batch: { assistantEntryId: responseEntryId, configuration: deferred.configuration, turnId: pendingDeferred.stepId, calls: polled.message.content.filter((item) => item.type === "toolCall").map((_, sourceIndex) => ({ status: "planned" as const, sourceIndex, resultEntryId: crypto.randomUUID() })) } }
			: { kind: "checkpoint", triggerEntryId: responseEntryId, continuation: { kind: "may_finish", includeFinalAssistant: true } };
		const nextProgram: OperationProgram = { ...program, phase: nextPhase };
		yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: { ...state, status: "checkpoint", responseEntryId, usageId, latestMessage: polled.message, program: nextProgram }, lane: { ...current.lane, leafId: responseEntryId }, settlement: { entryId: responseEntryId, message: polled.message, usageId, usage: polled.message.usage } });
		return { operationId: meta.id, lane, kind: "run", outcome: "completed", leafId: responseEntryId, finalMessage: polled.message };
	});
}

function makeKernel(store: EffectOperationStore, effects: OperationEffects, model: Model<Api>): OperationKernel {
	const lock = { value: false };

	const accept = (lane: string, prompt: readonly AgentMessage[], options?: { operationId?: string }) => withLaneLock(lock, Effect.gen(function* () {
		const current = yield* loadLane(store, lane);
		if (current.lane.currentOperationId) {
			return yield* Effect.fail(new OperationBusy({ lane, operationId: current.lane.currentOperationId, kind: current.state?.kind ?? "run" }));
		}
		const id = options?.operationId ?? crypto.randomUUID();
		const meta: OperationMeta = { id, lane, kind: "run", sourceLeafId: current.lane.leafId, prompt: [...prompt], startedAt: Date.now() };
		const state = { ...newState(id, lane, "run", "checkpoint"), program: newRunProgram() };
		yield* commitEffect(store, { meta, state, lane: { ...current.lane, currentOperationId: id } });
		return meta;
	}), () => { lock.value = false; });

	const acceptCompaction = (lane: string, customInstructions?: string, options?: { operationId?: string }) => withLaneLock(lock, Effect.gen(function* () {
		const current = yield* loadLane(store, lane);
		if (current.lane.currentOperationId) {
			return yield* Effect.fail(new OperationBusy({ lane, operationId: current.lane.currentOperationId, kind: current.state?.kind ?? "run" }));
		}
		if (current.lane.leafId === null) {
			return yield* Effect.fail(new NothingToCompact({ lane }));
		}
		const id = options?.operationId ?? crypto.randomUUID();
		const meta: OperationMeta = { id, lane, kind: "compaction", sourceLeafId: current.lane.leafId, prompt: [], startedAt: Date.now(), customInstructions };
		const state: OperationState = { ...newState(id, lane, "compaction", "checkpoint"), resultEntryId: crypto.randomUUID() };
		yield* commitEffect(store, { meta, state, lane: { ...current.lane, currentOperationId: id } });
		return meta;
	}), () => { lock.value = false; });

	const acceptNavigation = (
		lane: string,
		targetId: string | null,
		options?: { summarize?: boolean; label?: string; customInstructions?: string; operationId?: string },
	) => withLaneLock(lock, Effect.gen(function* () {
		const current = yield* loadLane(store, lane);
		if (current.lane.currentOperationId) {
			return yield* Effect.fail(new OperationBusy({ lane, operationId: current.lane.currentOperationId, kind: current.state?.kind ?? "run" }));
		}
		if (current.lane.leafId === null && targetId !== null) {
			return yield* Effect.fail(new InvalidNavigationTarget({ lane, targetId }));
		}
		if (targetId !== null && targetId !== current.lane.leafId) {
			return yield* Effect.fail(new InvalidNavigationTarget({ lane, targetId }));
		}
		const id = options?.operationId ?? crypto.randomUUID();
		const meta: OperationMeta = {
			id,
			lane,
			kind: "navigation",
			sourceLeafId: current.lane.leafId,
			prompt: [],
			startedAt: Date.now(),
			targetId,
			summarize: options?.summarize ?? false,
			label: options?.label,
			customInstructions: options?.customInstructions,
		};
		const state: OperationState = { ...newState(id, lane, "navigation", "checkpoint"), resultEntryId: crypto.randomUUID() };
		yield* commitEffect(store, { meta, state, lane: { ...current.lane, currentOperationId: id } });
		return meta;
	}), () => { lock.value = false; });

	const resume = (lane: string) => Effect.gen(function* () {
		const initial = yield* loadLane(store, lane);
		const guardedStore = withEffectCas(store, initial);
		if (
			initial.meta &&
			initial.state?.program?.phase.kind === "deferred" &&
			initial.state.program.control.status === "running"
		) {
			return yield* runDeferredPollEffect(guardedStore, effects, lane, initial, initial.meta!);
		}
		if (
			initial.meta &&
			initial.state?.program?.phase.kind === "tools" &&
			initial.state.program.control.status === "running"
		) {
			return yield* runToolBatchEffect(guardedStore, effects, lane, initial, initial.meta!);
		}
		if (
			initial.meta &&
			initial.state?.program?.phase.kind === "compaction" &&
			initial.state.program.control.status === "running"
		) {
			return yield* runInRunCompactionEffect(guardedStore, effects, model, lane, initial, initial.meta!);
		}
		const pendingContext = yield* withLaneLock(lock, Effect.gen(function* () {
			const current = yield* loadLane(store, lane);
			if (!current.meta || !current.state || !current.lane.currentOperationId) {
				return yield* Effect.fail(new OperationNotFound({ lane }));
			}
			if (current.state.status === "completed" || current.state.status === "aborted" || current.state.status === "failed") {
				return yield* Effect.fail(new OperationInvariantViolation({ message: "terminal operation still present" }));
			}
			if (current.state.control.status === "cancel_requested") {
				const result: OperationResult = {
					operationId: current.meta.id,
					lane,
					kind: current.meta.kind,
					outcome: "aborted",
					leafId: current.lane.leafId,
				};
				yield* commitEffect(guardedStore, { expectedOperationId: current.meta!.id, meta: undefined, state: undefined, lane: { ...current.lane, currentOperationId: null }, result });
				return { current, pending: null, responseEntryId: null, usageId: null, terminalResult: result };
			}
			const attempt = current.state.attempt + 1;
			const responseEntryId = crypto.randomUUID();
			const usageId = crypto.randomUUID();
			const pending: OperationState = { ...current.state, status: "effect_pending", attempt, responseEntryId, usageId };
			yield* commitEffect(guardedStore, { expectedOperationId: current.meta!.id, meta: current.meta, state: pending, lane: current.lane });
			return { current, pending, responseEntryId, usageId, terminalResult: null };
		}), () => { lock.value = false; });
		const { current, pending, responseEntryId, usageId, terminalResult } = pendingContext;
		const meta = current.meta;
		if (!meta) return yield* Effect.fail(new OperationInvariantViolation({ message: "operation metadata disappeared before dispatch" }));
		if (terminalResult) return terminalResult;
		if (meta.kind === "compaction") {
			const st = current.state;
			if (!st) return yield* Effect.fail(new OperationInvariantViolation({ message: "compaction state missing" }));
			return yield* runCompactionEffect(guardedStore, effects, lane, initial, meta, st);
		}
		if (meta.kind === "navigation") {
			return yield* runNavigationEffect(guardedStore, effects, lane, initial, meta);
		}
		return yield* withLaneLock(
			lock,
			runGenerationEffect(guardedStore, effects, model, lane, initial, meta, pending),
			() => { lock.value = false; },
		);
	});

	const abort = (lane: string) => withKernelLock(Effect.gen(function* () {
		const current = yield* loadLane(store, lane);
		if (!current.meta || !current.state || !current.lane.currentOperationId) {
			return yield* Effect.fail(new OperationNotFound({ lane }));
		}
		const meta = current.meta;
		const state = current.state;
		const drainSteer: AgentMessage[] = [];
		const drainFollowUp: AgentMessage[] = [];
		if (store.readQueueMessage) {
			for (const id of state.inbox.steer) {
				const reg = yield* store.readQueueMessage(id);
				if (reg) drainSteer.push(reg);
			}
			for (const id of state.inbox.followUp) {
				const reg = yield* store.readQueueMessage(id);
				if (reg) drainFollowUp.push(reg);
			}
		}
		const clearedState: OperationState = {
			...state,
			control: { status: "cancel_requested", requestedAt: Date.now(), drainedSteer: drainSteer, drainedFollowUp: drainFollowUp },
			inbox: { steer: [], followUp: [], writes: state.inbox.writes },
			...(state.program?.kind === "run"
				? {
						program: {
							...state.program,
							control: {
								status: "cancel_requested",
								requestedAt: Date.now(),
								drainedSteer: state.inbox.steer,
								drainedFollowUp: state.inbox.followUp,
							},
						},
					}
				: {}),
		};
		yield* commitEffect(store, { expectedOperationId: meta.id, meta, state: clearedState, lane: current.lane });
		if (effects.cancelDeferred && state.program?.kind === "run" && state.program.phase.kind === "deferred" && state.latestMessage?.deferred) {
			yield* effects.cancelDeferred(state.latestMessage.deferred);
		}
		return { runId: meta.id, steer: drainSteer, followUp: drainFollowUp };
	}), () => { lock.value = false; }).pipe(
		Effect.mapError((cause) =>
			cause instanceof OperationInvariantViolation || cause instanceof OperationNotFound
				? cause
				: new OperationInvariantViolation({ message: String(cause) }),
		),
	);

	const admit = (lane: string, kind: "steer" | "followUp", message: AgentMessage) => withLaneLock(lock, Effect.gen(function* () {
		const current = yield* loadLane(store, lane);
		if (!current.meta || !current.state || !current.lane.currentOperationId) {
			return yield* Effect.fail(new NoActiveRun({ lane }));
		}
		if (current.state.status === "completed" || current.state.status === "aborted" || current.state.status === "failed") {
			return yield* Effect.fail(new OperationInvariantViolation({ message: "terminal operation still present" }));
		}
		const entryId = crypto.randomUUID();
		const inbox = current.state.inbox;
		const nextInbox: Inbox = kind === "steer" ? { ...inbox, steer: [...inbox.steer, entryId] } : { ...inbox, followUp: [...inbox.followUp, entryId] };
		const nextState: OperationState = { ...current.state, inbox: nextInbox };
		yield* commitEffect(store, { expectedOperationId: current.meta!.id, meta: current.meta, state: nextState, lane: current.lane, queueAdmission: { kind, id: entryId, message } });
		return { entryId } satisfies QueueAdmitResult;
	}), () => { lock.value = false; });

	const nextRun = (lane: string, message: AgentMessage) => withLaneLock(lock, Effect.gen(function* () {
		const current = yield* loadLane(store, lane);
		const entryId = crypto.randomUUID();
		const nextLane: LaneState = { ...current.lane, pendingNextRun: [...current.lane.pendingNextRun, entryId] };
		yield* commitEffect(store, { meta: undefined, state: undefined, lane: nextLane, pendingEntry: { id: entryId, message } });
		return { entryId } satisfies QueueAdmitResult;
	}), () => { lock.value = false; });

	const cancelQueued = (lane: string, entryId: string) => withLaneLock(lock, Effect.gen(function* () {
		const current = yield* loadLane(store, lane);
		if (current.state && current.meta && current.lane.currentOperationId === current.meta.id) {
			const inbox = current.state.inbox;
			if (inbox.steer.includes(entryId) || inbox.followUp.includes(entryId)) {
				const nextInbox: Inbox = {
					steer: inbox.steer.filter((id) => id !== entryId),
					followUp: inbox.followUp.filter((id) => id !== entryId),
					writes: inbox.writes,
				};
				const nextState: OperationState = { ...current.state, inbox: nextInbox };
				yield* commitEffect(store, { expectedOperationId: current.meta!.id, meta: current.meta, state: nextState, lane: current.lane });
				return { outcome: "cancelled" } satisfies CancelResult;
			}
		}
		if (current.lane.pendingNextRun.includes(entryId)) {
			const nextLane: LaneState = { ...current.lane, pendingNextRun: current.lane.pendingNextRun.filter((id) => id !== entryId) };
			yield* commitEffect(store, { meta: undefined, state: undefined, lane: nextLane });
			return { outcome: "cancelled" } satisfies CancelResult;
		}
		return { outcome: "not_found" } satisfies CancelResult;
	}), () => { lock.value = false; });

	const readQueueMessage = (entryId: string) =>
		store.readQueueMessage
			? store.readQueueMessage(entryId)
			: Effect.succeed(undefined);

	return {
		accept,
		acceptCompaction,
		acceptNavigation,
		resume,
		abort,
		steer: (lane, message) => admit(lane, "steer", message),
		followUp: (lane, message) => admit(lane, "followUp", message),
		nextRun,
		cancelQueued,
		readQueueMessage,
	} satisfies OperationKernel;
}

export interface OperationKernel {
	readonly accept: (lane: string, prompt: readonly AgentMessage[], options?: { operationId?: string }) => Effect.Effect<OperationMeta, OperationBusy | OperationInvariantViolation | unknown>;
	readonly acceptCompaction: (lane: string, customInstructions?: string, options?: { operationId?: string }) => Effect.Effect<OperationMeta, NothingToCompact | OperationBusy | OperationInvariantViolation | unknown>;
	readonly acceptNavigation: (
		lane: string,
		targetId: string | null,
		options?: { summarize?: boolean; label?: string; customInstructions?: string; operationId?: string },
	) => Effect.Effect<OperationMeta, InvalidNavigationTarget | OperationBusy | OperationInvariantViolation | unknown>;
	readonly resume: (lane: string) => Effect.Effect<OperationResult, OperationInvariantViolation | OperationNotFound | unknown>;
	readonly abort: (lane: string) => Effect.Effect<AbortResult, OperationInvariantViolation | OperationNotFound | unknown>;
	readonly steer: (lane: string, message: AgentMessage) => Effect.Effect<QueueAdmitResult, NoActiveRun | OperationBusy | OperationInvariantViolation | unknown>;
	readonly followUp: (lane: string, message: AgentMessage) => Effect.Effect<QueueAdmitResult, NoActiveRun | OperationBusy | OperationInvariantViolation | unknown>;
	readonly nextRun: (lane: string, message: AgentMessage) => Effect.Effect<QueueAdmitResult, OperationInvariantViolation | unknown>;
	readonly cancelQueued: (lane: string, entryId: string) => Effect.Effect<CancelResult, OperationInvariantViolation | QueueItemNotFound | unknown>;
	readonly readQueueMessage: (entryId: string) => Effect.Effect<AgentMessage | undefined, OperationInvariantViolation | unknown>;
}

export const OperationKernelTag = Context.Service<OperationKernel>("tg-agent/OperationKernel");
export const OperationEffectsTag = Context.Service<OperationEffects>("tg-agent/OperationEffects");
export const OperationModelTag = Context.Service<Model<Api>>("tg-agent/OperationModel");

/** Effect-first operation layer; consumes an Effect operation store. */
export const makeEffectOperationLayer = (
	store: EffectOperationStore,
	effects: OperationEffects,
	model: Model<Api>,
) =>
	Layer.mergeAll(
		Layer.succeed(EffectOperationStoreService, EffectOperationStoreService.of(store)),
		Layer.succeed(OperationEffectsTag, effects),
		Layer.succeed(OperationModelTag, model),
		Layer.succeed(OperationKernelTag, makeKernel(store, effects, model)),
	);

/** Convenience Effect layer for tests that pre-build an in-memory operation store. */
export const makeInMemoryOperationLayer = (effects: OperationEffects, model: Model<Api>) =>
	makeEffectOperationLayer(new InMemoryOperationStore(), effects, model);

function withLaneLock<A, E>(
	lock: { value: boolean },
	effect: Effect.Effect<A, E>,
	release: () => void,
): Effect.Effect<A, E> {
	return Effect.gen(function* () {
		if (lock.value) return yield* Effect.fail(new OperationInvariantViolation({ message: "operation lane is already mutating" }) as unknown as E);
		lock.value = true;
		try {
			return yield* effect;
		} finally {
			release();
		}
	});
}

function withKernelLock<A, E>(
	effect: Effect.Effect<A, E>,
	release: () => void,
): Effect.Effect<A, E> {
	const lock = { value: false };
	return Effect.gen(function* () {
		if (lock.value) return yield* Effect.fail(new OperationInvariantViolation({ message: "operation lane is already mutating" }) as unknown as E);
		lock.value = true;
		try {
			return yield* effect;
		} finally {
			lock.value = false;
			release();
		}
	});
}

export const OperationKernelLayer = Layer.effect(
	OperationKernelTag,
	Effect.gen(function* () {
		const store = (yield* EffectOperationStoreService) as EffectOperationStore;
		return makeKernel(store, yield* OperationEffectsTag, yield* OperationModelTag);
	}),
);
