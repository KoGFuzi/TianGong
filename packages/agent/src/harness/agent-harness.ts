import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	Usage,
} from "@onepanda-tiangongsec/tg-ai";
import type { AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import type { CompactionSettings } from "./compaction/compaction.ts";
import { type Result as ResultValue, TaggedError } from "./result.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	JsonValue,
	ProvisionedEntry,
	Register,
	Session,
	SessionError,
	SessionTree,
} from "./session/index.ts";
import { NOOP_TELEMETRY_CONTEXT } from "@onepanda-tiangongsec/tg-telemetry";
import type { TelemetryContext } from "./telemetry.ts";
import { startHarnessSpan } from "./telemetry.ts";
import type { AgentHarnessResources, PromptTemplate, Skill } from "./types.ts";
import { Effect, Ref } from "effect";
import { HarnessStateTag, harnessLayerFromOptions, makeHarnessLayer, runHarness } from "./effect.ts";
import { buildSessionContext } from "./session/context.ts";
import {
	InvalidNavigationTarget,
	OperationBusy,
	OperationInvariantViolation,
	OperationKernelTag,
	OperationNotFound,
	QueueItemNotFound,
	effectSessionOperationStore,
	makeEffectOperationLayer,
} from "./operation.ts";
import { HarnessEventBus } from "./events.ts";
import { HarnessHookRegistry } from "./hooks.ts";

/** Type-level: convert a method that returns `Effect<A, E>` into a method that returns `Promise<A>`.
 * Non-Effect-returning methods are left unchanged. Properties are preserved. */
type EffectToPromise<T> = T extends Effect.Effect<infer A, infer _E, infer _R>
	? Promise<A>
	: T extends Effect.Effect<infer A, infer _E>
	? Promise<A>
	: T;

/** Mapped type that converts every method's Effect return to a Promise return. */
type UnwrapEffects<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R
		? (...args: A) => UnwrapEffectsReturn<R>
		: T[K];
};
type UnwrapEffectsReturn<R> = R extends Effect.Effect<infer A, infer _E, infer _R>
	? Promise<A>
	: R extends Effect.Effect<infer A, infer _E>
	? Promise<A>
	: R;

const promiseSessionCache = new WeakMap<object, object>();

function sessionToPromise<T extends object>(session: T): UnwrapEffects<T> {
	const cached = promiseSessionCache.get(session);
	if (cached) return cached as UnwrapEffects<T>;
	const proxy = new Proxy(session, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const result = (value as (...a: unknown[]) => unknown).apply(target, args);
				if (Effect.isEffect(result)) {
					return Effect.runPromise(result as Effect.Effect<unknown, unknown, never>);
				}
				return result;
			};
		},
	});
	promiseSessionCache.set(session, proxy);
	return proxy as UnwrapEffects<T>;
}

export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}> {}
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
export class InvalidMessage extends TaggedError("InvalidMessage")<{ lane: string; reason: string; message: string }> {}
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
export class UnknownQueueItem extends TaggedError("UnknownQueueItem")<{
	lane: string;
	entryId: string;
	message: string;
}> {}
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
export class InvalidLane extends TaggedError("InvalidLane")<{ lane: string; reason: string; message: string }> {}
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
export class Closed extends TaggedError("Closed")<{ message: string }> {}

export class HarnessFault extends Error {
	override readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

export class HarnessNotImplemented extends Error {
	readonly operation: string;

	constructor(operation: string) {
		super(`AgentHarness.${operation} is not implemented yet`);
		this.name = "HarnessNotImplemented";
		this.operation = operation;
	}
}

export interface OperationError {
	code: string;
	message: string;
}

export type RunOutcome =
	| { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "aborted"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "failed"; leafId: string; error: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage }
	| { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle };

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError };

export type NavigationOutcome =
	| { kind: "completed"; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError };

export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed | HarnessFault;
export type CompactionRejected = LaneBusy | NothingToCompact | Closed | HarnessFault;
export type NavigationRejected = LaneBusy | UnknownTarget | Closed | HarnessFault;
export type ResumeRejected = LaneBusy | NothingToResume | MissingIdentities | Closed | HarnessFault;
export type QueueRejected = NoActiveRun | InvalidMessage | Closed | HarnessFault | LaneBusy;
export type CancelQueuedRejected = UnknownQueueItem | Closed | HarnessFault;
export type AbortRejected = NoActiveOperation | Closed | HarnessFault;

export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
export type CompactionResult = ResultValue<{ runId: string } & CompactionOutcome, CompactionRejected>;
export type NavigationResult = ResultValue<{ runId: string } & NavigationOutcome, NavigationRejected>;
export type QueueResult = ResultValue<{ entryId: string }, QueueRejected>;
export type CancelQueuedResult = ResultValue<
	{ outcome: "cancelled" | "already_consumed" | "already_cleared" },
	CancelQueuedRejected
>;
export type RecordUsageResult = ResultValue<void, Closed>;
export type AbortResult = ResultValue<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	AbortRejected
>;

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);
export type ResumeResult = ResultValue<ResumeOutcome, ResumeRejected>;
export type CreateLaneResult = ResultValue<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	customInstructions?: string;
	label?: string;
}

export interface SuspendedOperation {
	lane: string;
	kind: "run" | "compaction" | "navigation";
	id: string;
	startedAt: number;
	reason: "crash" | "deferred";
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: LaneInfo["operation"];
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: { id: string; entry: ProvisionedEntry }[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type ActionInfo =
	| { kind: "append_entry"; entryType: Entry["type"]; entryId: string }
	| { kind: "append_record"; recordType: string }
	| { kind: "move_lane"; to: string | null }
	| { kind: "set_fact"; fact: "name" | "label" }
	| { kind: "try_finish_run"; outcome: "completed" | "failed" }
	| { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
	| { kind: "commit_follow_up" }
	| { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
	| { kind: "apply_pending_write"; entryId: string }
	| { kind: "stream_assistant"; step: "assistant" | "compaction" | "branch_summary"; attempt: number }
	| { kind: "execute_tool"; toolCallId: string; toolName: string }
	| { kind: "fetch_deferred" | "cancel_deferred"; provider: string; id: string }
	| { kind: "hook"; name: HookName }
	| { kind: "sleep"; delayMs: number };

export type HookName =
	| "before_run"
	| "before_resume"
	| "before_run_end"
	| "transform_context"
	| "before_request"
	| "before_payload"
	| "after_response"
	| "before_tool"
	| "after_tool"
	| "before_compaction"
	| "before_navigation";

export interface Hooks {
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>, options?: { id?: string }): () => void;
}

export interface Events {
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
}

class UnavailableRegistry implements Hooks, Events {
	private readonly operation: string;
	private readonly isClosed: () => boolean;

	constructor(operation: string, isClosed: () => boolean) {
		this.operation = operation;
		this.isClosed = isClosed;
	}

	on(
		_name: HookName | string,
		_handler: (event: unknown) => unknown | Promise<unknown>,
		_options?: { id?: string },
	): () => void {
		throw this.isClosed() ? new HarnessClosed() : new HarnessNotImplemented(this.operation);
	}
}

export type HarnessTool = AgentTool & { replay?: "never" | "safe" };
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type StreamOptions = SimpleStreamOptions;
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

export interface AgentHarnessOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: HarnessTool[];
	toolContext?: object | (() => object | Promise<object>);
	systemPrompt?: string | (() => string | Promise<string>);
	resources?: Resources;
	streamOptions?: StreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	context?: TelemetryContext;
	/** Internal lane selector used by lane-scoped facades. */
	laneName?: string;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: (event: unknown) => void): void;
	unsubscribe(): void;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	abort(): Promise<AbortResult>;
	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api>>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

export class AgentHarness implements AgentLane {
	private readonly laneName: string;
	private readonly constructionOptions: AgentHarnessOptions;
	get name(): string { return this.laneName; }
	readonly session: SessionTree;
	readonly hooks: HarnessHookRegistry;
	readonly events: HarnessEventBus;
	private readonly durableSession: UnwrapEffects<Session>;
	private model: Model<Api>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private tools: HarnessTool[];
	private resources: Resources;
	private streamOptions: StreamOptions;
	private retryPolicy: RetryPolicy;
	private compactionSettings: CompactionSettings;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private closed = false;
	private readonly telemetryContext: TelemetryContext;
	private readonly effectLayer: ReturnType<typeof makeHarnessLayer>;
	private readonly operationLayer: ReturnType<typeof makeEffectOperationLayer>;
	private readonly effectOperationStore: import("./operation.ts").EffectOperationStore;
	private readonly entryProjectors?: Record<string, EntryProjector>;

	private constructor(options: AgentHarnessOptions) {
		this.constructionOptions = options;
		this.laneName = options.laneName ?? "main";
		this.entryProjectors = options.entryProjectors;
		this.durableSession = sessionToPromise(options.session);
		const mainView = options.session.view(this.laneName);
		this.session = mainView === options.session ? options.session : (this.durableSession as unknown as SessionTree);
		this.telemetryContext = options.context ?? NOOP_TELEMETRY_CONTEXT;
		this.hooks = new HarnessHookRegistry(() => new HarnessClosed());
		this.events = new HarnessEventBus(() => new HarnessClosed());
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		this.tools = [...(options.tools ?? [])];
		this.resources = {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		};
		this.streamOptions = { ...(options.streamOptions ?? {}) };
		this.retryPolicy = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 };
		this.compactionSettings = options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
		this.effectLayer = makeHarnessLayer({
			session: options.session,
			models: options.models,
			model: options.model,
			tools: this.tools,
			resources: this.resources,
			thinkingLevel: this.thinkingLevel,
			activeToolNames: this.activeToolNames,
			streamOptions: this.streamOptions,
			retryPolicy: this.retryPolicy,
			compaction: this.compactionSettings,
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
		});
		const effectSession = options.session;
		const self = this;
		this.effectOperationStore = effectSessionOperationStore(effectSession);
		this.operationLayer = makeEffectOperationLayer(
			this.effectOperationStore,
			{
				prepareMessages: ({ lane, prompt }) =>
					Effect.tryPromise({
						try: async () => {
							const entries = await Effect.runPromise(effectSession.findEntries({ order: "oldestFirst" }));
							const context = buildSessionContext(entries as never);
							const projected = self.entryProjectors
								? await Promise.all(entries.filter((e) => e.type === "custom").map((entry) => self.entryProjectors![entry.customType]?.(entry) ?? []))
								: [];
							return [...context.messages, ...projected.flatMap((m) => m ?? []), ...prompt] as readonly AgentMessage[];
						},
						catch: (cause) => cause,
					}),
				generate: ({ model, messages }) =>
					Effect.tryPromise({
						try: async () => {
							const response = await options.models.completeSimple(
								model,
								{ messages: [...messages] as Message[] },
								this.streamOptions,
							);
							return { message: response, usage: response.usage };
						},
						catch: (cause) => cause,
					}),
				summarize: (preparation, customInstructions) =>
					Effect.tryPromise({
						try: async () => {
							const { compact } = await import("./compaction/compaction.ts");
							const summary = await compact(
								preparation,
								options.models,
								options.model,
								customInstructions,
								undefined,
								this.thinkingLevel,
								this.retryPolicy,
							);
							if (!summary.ok) {
								return { ok: false as const, error: { code: "compaction", message: summary.error.message } };
							}
							return { ok: true as const, result: summary.value };
						},
						catch: (cause) => cause,
					}),
				summarizeBranch: (entries, tokenBudget) =>
					Effect.tryPromise({
						try: async () => {
							const { generateBranchSummary } = await import("./compaction/branch-summarization.ts");
							const arr = [...entries.values()];
							const out = await generateBranchSummary(arr, {
								models: options.models,
								model: options.model,
								signal: new AbortController().signal,
								reserveTokens: Math.max(0, (options.model.contextWindow || 128000) - tokenBudget),
							});
							if (!out.ok) return { error: { code: "branch_summary", message: out.error.message } };
							return { summary: out.value.summary };
						},
						catch: (cause) => cause,
					}),
				executeTool: ({ toolCallId, name, args }) =>
					Effect.tryPromise({
						try: async () => {
							const tool = this.tools.find((t: HarnessTool) => t.name === name);
							if (!tool) {
								return { result: { content: [{ type: "text", text: `Tool not registered: ${name}` }], details: {} }, isError: true };
							}
							const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
							const result = await tool.execute(toolCallId, prepared as never, undefined, undefined);
							return { result, isError: false };
						},
						catch: (cause) => cause,
					}),
				toolReplay: (name) => this.tools.find((tool: HarnessTool) => tool.name === name)?.replay,
				fetchDeferred: ({ handle }) =>
					Effect.tryPromise({
						try: async () => {
							const message = await options.models.fetchDeferred(options.model, handle as DeferredHandle, { wait: 0 });
							return { message, pending: message.stopReason === "deferred" };
						},
						catch: (cause) => cause,
					}),
				cancelDeferred: (handle) =>
					Effect.tryPromise({
						try: async () => {
							await options.models.cancelDeferred(options.model, handle as DeferredHandle);
						},
						catch: (cause) => cause,
					}),
			},
			options.model,
		);
	}

	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		return runHarness(AgentHarness.createEffect(options), harnessLayerFromOptions(options));
	}

	/** Effect v4 entry point. Promise APIs below are compatibility adapters. */
	static readonly createEffect = (options: AgentHarnessOptions) =>
		Effect.tryPromise({
			try: async () => {
				return { harness: new AgentHarness(options), suspended: [] };
			},
			catch: (error) => error,
		});

	readonly closeEffect = Effect.sync(() => {
		this.closed = true;
		this.hooks.close();
		this.events.close();
	});

	private unavailable<T>(operation: string): Promise<T> {
		// skill/promptFromTemplate/watch/watchSession require event-system plumbing
		// (TypedEmitter/subscribe) that is deferred to a future phase.
		return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
	}

	async getLeafId(): Promise<string | null> {
		return this.durableSession.getLeafId();
	}

	async prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	async prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const prompt = typeof input === "string"
			? [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() } satisfies AgentMessage]
			: Array.isArray(input)
				? input
				: [input];
		if (prompt.length === 0) {
			return { ok: false, error: new InvalidMessage({ lane: this.name, reason: "prompt must contain at least one message", message: "Invalid prompt" }) };
		}
		const operationId = crypto.randomUUID();
		try {
			const sessionId = (await this.durableSession.getMetadata()).id;
			return await startHarnessSpan(this.telemetryContext, "pi.harness.run", {
				"pi.session.id": sessionId,
				"pi.lane.name": this.name,
				"pi.operation.id": operationId,
				"pi.operation.recovery": false,
				"pi.operation.kind": "run",
			}, async (span) => {
				await this.hooks.run("before_run", { lane: this.name, prompt: structuredClone(prompt) });
				this.events.emit({ type: "run_start", lane: this.name, runId: operationId });
				const result = await Effect.runPromise(
					Effect.provide(Effect.service(OperationKernelTag).pipe(
						Effect.flatMap((kernel) => Effect.flatMap(kernel.accept(this.name, prompt, { operationId }), () => kernel.resume(this.name))),
					), this.operationLayer) as Effect.Effect<import("./operation.ts").OperationResult, unknown, never>,
				);
				span.setAttributes({ "pi.operation.outcome": result.outcome === "declined" ? "failed" : result.outcome });
				this.events.emit({
					type: "run_end",
					lane: this.name,
					runId: result.operationId,
					outcome: result.outcome === "declined" ? "failed" : result.outcome,
					leafId: result.leafId ?? "",
				});
				if (result.outcome === "completed" && result.finalMessage) {
					return { ok: true, value: { runId: result.operationId, kind: "completed", leafId: result.leafId ?? "", finalEntryId: result.leafId ?? "", finalMessage: result.finalMessage } };
				}
				return { ok: true, value: { runId: result.operationId, kind: "failed", leafId: result.leafId ?? "", error: result.error ?? { code: "operation_failed", message: "Operation failed" } } };
			});
		} catch (error) {
			if ((error as Error & { _tag?: string })._tag === "OperationBusy") {
				const busy = error as unknown as { operationId: string; kind: "run" | "compaction" | "navigation" };
				return { ok: false, error: new LaneBusy({ lane: this.name, operationId: busy.operationId, operationKind: busy.kind, message: "Lane is busy" }) };
			}
			throw error;
		}
	}
	async skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const skill = this.resources.skills?.find((s) => s.name === name);
		if (!skill) return { ok: false, error: new UnknownSkill({ name, message: `Skill not found: ${name}` }) };
		const { formatSkillInvocation } = await import("./skills.ts");
		const skillText = formatSkillInvocation(skill, additionalInstructions);
		return this.prompt(skillText);
	}
	async promptFromTemplate(name: string, args?: string[]): Promise<RunResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const template = this.resources.promptTemplates?.find((t) => t.name === name);
		if (!template) return { ok: false, error: new UnknownTemplate({ name, message: `Template not found: ${name}` }) };
		const { formatPromptTemplateInvocation } = await import("./prompt-templates.ts");
		const text = formatPromptTemplateInvocation(template, args);
		return this.prompt(text);
	}
	async compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		try {
			const operationId = crypto.randomUUID();
			const sessionId = (await this.durableSession.getMetadata()).id;
			const meta = await startHarnessSpan(this.telemetryContext, "pi.harness.compaction", {
				"pi.session.id": sessionId,
				"pi.lane.name": this.name,
				"pi.operation.id": operationId,
				"pi.operation.recovery": false,
				"pi.operation.kind": "compaction",
			}, async (span) => {
				await this.hooks.run("before_compaction", { lane: this.name, customInstructions: _options?.customInstructions });
				this.events.emit({ type: "compaction_start", lane: this.name, runId: operationId, reason: "manual" });
				const outcome = await Effect.runPromise(
					Effect.provide(Effect.service(OperationKernelTag).pipe(
						Effect.flatMap((k) => Effect.flatMap(k.acceptCompaction(this.name, _options?.customInstructions, { operationId }), () => k.resume(this.name))),
					), this.operationLayer) as Effect.Effect<import("./operation.ts").OperationResult, unknown, never>,
				);
				span.setAttributes({ "pi.operation.outcome": outcome.outcome });
				return outcome;
			});
			if (meta.outcome === "completed") {
				const entry = meta.leafId ? await this.session.getEntry(meta.leafId) : undefined;
				this.events.emit({ type: "compaction_end", lane: this.name, runId: meta.operationId, reason: "manual", outcome: "completed", entry });
				return { ok: true, value: { runId: meta.operationId, kind: "completed", leafId: meta.leafId ?? "", entry: entry as unknown as CompactionEntry } };
			}
			if (meta.outcome === "declined") {
				return { ok: true, value: { runId: meta.operationId, kind: "declined", leafId: meta.leafId ?? "" } };
			}
			if (meta.outcome === "failed") {
				return { ok: true, value: { runId: meta.operationId, kind: "failed", leafId: meta.leafId ?? "", error: meta.error ?? { code: "compact_failed", message: "Compaction failed" } } };
			}
			return { ok: true, value: { runId: meta.operationId, kind: "aborted", leafId: meta.leafId ?? "" } };
		} catch (e) {
			if (e instanceof NothingToCompact) return { ok: false, error: new NothingToCompact({ lane: this.name, message: "Nothing to compact" }) };
			if (e instanceof OperationBusy) return { ok: false, error: new LaneBusy({ lane: this.name, operationId: e.operationId, operationKind: e.kind, message: "Lane is busy" }) };
			return { ok: false, error: new HarnessFault((e as Error).message ?? String(e), e) };
		}
	}
	async navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		try {
			const operationId = crypto.randomUUID();
			const sessionId = (await this.durableSession.getMetadata()).id;
			const meta = await startHarnessSpan(this.telemetryContext, "pi.harness.navigation", {
				"pi.session.id": sessionId,
				"pi.lane.name": this.name,
				"pi.operation.id": operationId,
				"pi.operation.recovery": false,
				"pi.operation.kind": "navigation",
			}, async (span) => {
				await this.hooks.run("before_navigation", { lane: this.name, targetId: _targetId, options: _options });
				this.events.emit({ type: "navigation_start", lane: this.name, runId: operationId, targetId: _targetId });
				const outcome = await Effect.runPromise(
					Effect.provide(Effect.service(OperationKernelTag).pipe(
						Effect.flatMap((k) => Effect.flatMap(k.acceptNavigation(this.name, _targetId, { summarize: _options?.summarize, label: _options?.label, customInstructions: _options?.customInstructions, operationId }), () => k.resume(this.name))),
					), this.operationLayer) as Effect.Effect<import("./operation.ts").OperationResult, unknown, never>,
				);
				span.setAttributes({ "pi.operation.outcome": outcome.outcome });
				return outcome;
			});
			if (meta.outcome === "completed") {
				const summaryEntry = meta.leafId ? await this.session.getEntry(meta.leafId) : undefined;
				this.events.emit({ type: "navigation_end", lane: this.name, runId: meta.operationId, targetId: _targetId, outcome: "completed", newLeafId: meta.leafId });
				return { ok: true, value: { runId: meta.operationId, kind: "completed", newLeafId: meta.leafId ?? null, summaryEntry: summaryEntry as BranchSummaryEntry | undefined } };
			}
			if (meta.outcome === "declined") {
				return { ok: true, value: { runId: meta.operationId, kind: "declined", leafId: meta.leafId ?? null } };
			}
			if (meta.outcome === "failed") {
				return { ok: true, value: { runId: meta.operationId, kind: "failed", leafId: meta.leafId ?? null, error: meta.error ?? { code: "navigation_failed", message: "Navigation failed" } } };
			}
			return { ok: true, value: { runId: meta.operationId, kind: "aborted", leafId: meta.leafId ?? null } };
		} catch (e) {
			if ((e as Error & { _tag?: string })._tag === "InvalidNavigationTarget") return { ok: false, error: new UnknownTarget({ targetId: _targetId ?? "", message: "Invalid target" }) };
			if (e instanceof OperationBusy) {
				const busy = e as unknown as { operationId: string; kind: "run" | "compaction" | "navigation" };
				return { ok: false, error: new LaneBusy({ lane: this.name, operationId: busy.operationId, operationKind: busy.kind, message: "Lane is busy" }) };
			}
			return { ok: false, error: new HarnessFault((e as Error).message ?? String(e), e) };
		}
	}
	async resume(): Promise<ResumeResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		try {
			const result = await Effect.runPromise(
				Effect.provide(Effect.service(OperationKernelTag).pipe(
					Effect.flatMap((k) => k.resume(this.name)),
				), this.operationLayer) as Effect.Effect<import("./operation.ts").OperationResult, unknown, never>,
			);
			const operation = result.kind as "run" | "compaction" | "navigation";
			return { ok: true, value: { operation, runId: result.operationId, kind: result.outcome as "aborted" | "completed" | "failed" } as ResumeOutcome };
		} catch (e) {
			if (e instanceof OperationNotFound) return { ok: false, error: new NothingToResume({ lane: this.name, message: "Nothing to resume" }) };
			return { ok: false, error: new HarnessFault((e as Error).message ?? String(e), e) };
		}
	}
	async abort(): Promise<AbortResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		try {
			const result = await Effect.runPromise(
				Effect.provide(Effect.service(OperationKernelTag).pipe(
					Effect.flatMap((k) => k.abort(this.name)),
				), this.operationLayer) as Effect.Effect<import("./operation.ts").AbortResult, unknown, never>,
			);
			return { ok: true, value: { runId: result.runId, steer: [...result.steer], followUp: [...result.followUp] } };
		} catch (e) {
			if (e instanceof OperationNotFound) return { ok: false, error: new NoActiveOperation({ lane: this.name, message: e.message }) };
			if (e instanceof OperationInvariantViolation) return { ok: false, error: new HarnessFault(e.message, e) };
			if (e instanceof HarnessClosed) return { ok: false, error: new Closed({ message: e.message }) };
			return { ok: false, error: new HarnessFault(String(e), e) };
		}
	}
	async steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async steer(_message: AgentMessage): Promise<QueueResult>;
	async steer(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const message: AgentMessage = typeof _input === "string"
			? { role: "user", content: [{ type: "text", text: _input }, ...(_images ?? [])], timestamp: Date.now() }
			: _input;
		try {
			const result = await Effect.runPromise(
				Effect.provide(Effect.service(OperationKernelTag).pipe(
					Effect.flatMap((k) => k.steer(this.name, message)),
				), this.operationLayer) as Effect.Effect<import("./operation.ts").QueueAdmitResult, unknown, never>,
			);
			return { ok: true, value: { entryId: result.entryId } };
		} catch (e) {
			if ((e as Error & { _tag?: string })._tag === "NoActiveRun") return { ok: false, error: new NoActiveRun({ lane: this.name, message: "No active run" }) };
			if (e instanceof OperationBusy) {
				const busy = e as unknown as { operationId: string; kind: "run" | "compaction" | "navigation" };
				return { ok: false, error: new LaneBusy({ lane: this.name, operationId: busy.operationId, operationKind: busy.kind, message: "Lane is busy" }) };
			}
			return { ok: false, error: new HarnessFault((e as Error).message ?? String(e), e) };
		}
	}
	async followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async followUp(_message: AgentMessage): Promise<QueueResult>;
	async followUp(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const message: AgentMessage = typeof _input === "string"
			? { role: "user", content: [{ type: "text", text: _input }, ...(_images ?? [])], timestamp: Date.now() }
			: _input;
		try {
			const result = await Effect.runPromise(
				Effect.provide(Effect.service(OperationKernelTag).pipe(
					Effect.flatMap((k) => k.followUp(this.name, message)),
				), this.operationLayer) as Effect.Effect<import("./operation.ts").QueueAdmitResult, unknown, never>,
			);
			return { ok: true, value: { entryId: result.entryId } };
		} catch (e) {
			if ((e as Error & { _tag?: string })._tag === "NoActiveRun") return { ok: false, error: new NoActiveRun({ lane: this.name, message: "No active run" }) };
			if (e instanceof OperationBusy) {
				const busy = e as unknown as { operationId: string; kind: "run" | "compaction" | "navigation" };
				return { ok: false, error: new LaneBusy({ lane: this.name, operationId: busy.operationId, operationKind: busy.kind, message: "Lane is busy" }) };
			}
			return { ok: false, error: new HarnessFault((e as Error).message ?? String(e), e) };
		}
	}
	async nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(_message: AgentMessage): Promise<QueueResult>;
	async nextRun(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const message: AgentMessage = typeof _input === "string"
			? { role: "user", content: [{ type: "text", text: _input }, ...(_images ?? [])], timestamp: Date.now() }
			: _input;
		try {
			const result = await Effect.runPromise(
				Effect.provide(Effect.service(OperationKernelTag).pipe(
					Effect.flatMap((k) => k.nextRun(this.name, message)),
				), this.operationLayer) as Effect.Effect<import("./operation.ts").QueueAdmitResult, unknown, never>,
			);
			return { ok: true, value: { entryId: result.entryId } };
		} catch (e) {
			return { ok: false, error: new HarnessFault((e as Error).message ?? String(e), e) };
		}
	}
	async cancelQueued(_entryId: string): Promise<CancelQueuedResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		try {
			const result = await Effect.runPromise(
				Effect.provide(Effect.service(OperationKernelTag).pipe(
					Effect.flatMap((k) => k.cancelQueued(this.name, _entryId)),
				), this.operationLayer) as Effect.Effect<import("./operation.ts").CancelResult, unknown, never>,
			);
			const outcome = result.outcome === "not_found" ? "already_consumed" : result.outcome;
			return { ok: true, value: { outcome } };
		} catch (e) {
			return { ok: false, error: new HarnessFault((e as Error).message ?? String(e), e) };
		}
	}
	async recordUsage(_usage: Usage, _options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		const entryId = _options?.entryId ?? (await this.getLeafId());
		if (!entryId) return { ok: false, error: new Closed({ message: "No leaf for usage record" }) };
		try {
			await this.durableSession.appendRecord({
				id: crypto.randomUUID(),
				lane: this.name,
				type: "usage",
				usage: _usage,
				cause: "adjustment",
				entryId,
				details: _options?.details,
			});
			return { ok: true, value: undefined };
		} catch (e) {
			return { ok: false, error: new Closed({ message: (e as Error).message ?? String(e) }) };
		}
	}
	async waitForIdle(): Promise<void> {
		if (this.closed) throw new Closed({ message: "AgentHarness is closed" });
		for (;;) {
			const ops = await this.durableSession.findOpenOperations(this.name);
			if (ops.length === 0) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
	}
	async runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		if (this.closed) throw new Closed({ message: "AgentHarness is closed" });
		await this.waitForIdle();
		await callback();
	}
	async peekAction(): Promise<ActionInfo | undefined> {
		if (this.closed) return undefined;
		const ops = await this.durableSession.findOpenOperations(this.name);
		if (ops.length === 0) return undefined;
		const kind = ops[0]!.intent.kind;
		return {
			kind: "stream_assistant",
			step: kind === "compaction" ? "compaction" : kind === "navigation" ? "branch_summary" : "assistant",
			attempt: 1,
		};
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		if (this.closed) return undefined;
		try {
			await this.resume();
		} catch {
			// ignore OperationNotFound or other recoverable errors
		}
		return undefined;
	}
	async runToCompletion(): Promise<void> {
		if (this.closed) throw new Closed({ message: "AgentHarness is closed" }) ?? undefined;
		// Manual drive: keep calling resume/abort until the lane is idle.
		for (let i = 0; i < 1000; i++) {
			const ops = await this.durableSession.findOpenOperations(this.name);
			if (ops.length === 0) return;
			try {
				await Effect.runPromise(
					Effect.provide(Effect.service(OperationKernelTag).pipe(
						Effect.flatMap((k) => k.resume(this.name)),
					), this.operationLayer) as Effect.Effect<import("./operation.ts").OperationResult, unknown, never>,
				);
			} catch (e) {
				// OperationNotFound means the operation finished and cleared its registers
				if ((e as Error & { _tag?: string })._tag === "OperationNotFound") continue;
				throw e;
			}
		}
	}
	async getModel(): Promise<Model<Api>> {
		return runHarness(Effect.gen(function* () {
			const state = yield* Effect.service(HarnessStateTag);
			return (yield* Ref.get(state)).model;
		}), this.effectLayer);
	}
	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
		await runHarness(Effect.gen(function* () {
			const state = yield* Effect.service(HarnessStateTag);
			yield* Ref.update(state, (current) => ({ ...current, model }));
		}), this.effectLayer);
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return runHarness(Effect.gen(function* () {
			const state = yield* Effect.service(HarnessStateTag);
			return (yield* Ref.get(state)).thinkingLevel;
		}), this.effectLayer);
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.thinkingLevel = level;
		await runHarness(Effect.gen(function* () {
			const state = yield* Effect.service(HarnessStateTag);
			yield* Ref.update(state, (current) => ({ ...current, thinkingLevel: level }));
		}), this.effectLayer);
	}
	async getActiveTools(): Promise<string[]> {
		return runHarness(Effect.gen(function* () {
			const state = yield* Effect.service(HarnessStateTag);
			return [...(yield* Ref.get(state)).activeToolNames];
		}), this.effectLayer);
	}
	async setActiveTools(names: string[]): Promise<void> {
		this.activeToolNames = [...names];
		await runHarness(Effect.gen(function* () {
			const state = yield* Effect.service(HarnessStateTag);
			yield* Ref.update(state, (current) => ({ ...current, activeToolNames: [...names] }));
		}), this.effectLayer);
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		if (this.closed) throw new HarnessClosed();
		const watch = this.events.watch(() => this.createLaneSnapshot());
		const snapshot = await this.createLaneSnapshot();
		return {
			get snapshot() { return snapshot; },
			start: watch.start,
			unsubscribe: watch.unsubscribe,
		};
	}

	async lane(name: string): Promise<AgentLane | undefined> {
		if (this.closed) throw new HarnessClosed();
		if (name === "main") return this;
		const lanes = await this.durableSession.getLanes();
		if (!lanes.some((lane: { lane: string }) => lane.lane === name)) return undefined;
		if (name === this.name) return this;
		return new AgentHarness({ ...this.constructionOptions, laneName: name });
	}
	async createLane(name: string, at: string | null): Promise<CreateLaneResult> {
		if (this.closed) return { ok: false, error: new Closed({ message: "AgentHarness is closed" }) };
		try {
			await this.durableSession.createLane(name, at);
			return { ok: true, value: await this.lane(name) ?? this };
		} catch (e) {
			return { ok: false, error: new InvalidLane({ lane: name, reason: String(e), message: "Create lane failed" }) };
		}
	}
	async lanes(): Promise<LaneInfo[]> {
		if (this.closed) throw new HarnessClosed();
		const pointers = await this.durableSession.getLanes();
		const results: LaneInfo[] = [];
		for (const p of pointers) {
			const ops = await this.durableSession.findOpenOperations(p.lane);
			results.push({
				name: p.lane,
				leafId: p.leafId,
				operation:
					ops.length > 0
						? (() => {
								const op = ops[0];
								if (!op) return null;
								return {
									id: op.id,
									kind: op.intent.kind,
									status: "running",
								} as const;
							})()
						: null,
			});
		}
		return results;
	}
	async getTools(): Promise<HarnessTool[]> {
		return [...this.tools];
	}
	async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		this.tools = [...tools];
		this.activeToolNames = [...(activeNames ?? tools.map((tool) => tool.name))];
	}
	async getResources(): Promise<Resources> {
		return {
			skills: this.resources.skills ? [...this.resources.skills] : undefined,
			promptTemplates: this.resources.promptTemplates ? [...this.resources.promptTemplates] : undefined,
		};
	}
	async setResources(resources: Resources): Promise<void> {
		this.resources = {
			skills: resources.skills ? [...resources.skills] : undefined,
			promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
		};
	}
	async getStreamOptions(): Promise<StreamOptions> {
		return { ...this.streamOptions };
	}
	async setStreamOptions(options: StreamOptions): Promise<void> {
		this.streamOptions = { ...options };
	}
	async getRetryPolicy(): Promise<RetryPolicy> {
		return { ...this.retryPolicy };
	}
	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		this.retryPolicy = { ...policy };
	}
	async getCompactionSettings(): Promise<CompactionSettings> {
		return { ...this.compactionSettings };
	}
	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.compactionSettings = { ...settings };
	}
	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringMode = mode;
	}
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
	}
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		if (this.closed) throw new HarnessClosed();
		const snapshot = { lanes: await this.lanes(), faulted: false } satisfies SessionSnapshot;
		const watch = this.events.watch(() => ({ lanes: this.lanes(), faulted: false }));
		return {
			get snapshot() { return snapshot; },
			start: watch.start,
			unsubscribe: watch.unsubscribe,
		};
	}

	private async createLaneSnapshot(): Promise<LaneSnapshot> {
		const current = await Effect.runPromise(this.effectOperationStore.load(this.name));
		const transcript = current.lane.leafId === null
			? []
			: await this.durableSession.findEntriesOnBranch({
				start: current.lane.leafId,
				order: "oldestFirst",
			});
		const operation = current.meta && current.state
			? {
					id: current.meta.id,
					kind: current.meta.kind,
					status: current.state.control.status === "cancel_requested" ? "aborting" as const : "running" as const,
				}
			: null;
		const readMessages = async (ids: readonly string[]): Promise<QueuedItem[]> => {
			const items: QueuedItem[] = [];
			for (const id of ids) {
				const register = await this.durableSession.getRegister("pending.entry", id);
				const message = register?.value as AgentMessage | undefined;
				if (message) items.push({ entryId: id, message });
			}
			return items;
		};
		const queues = {
			steer: await readMessages(current.state?.inbox.steer ?? []),
			followUp: await readMessages(current.state?.inbox.followUp ?? []),
			nextRun: await readMessages(current.lane.pendingNextRun),
		};
		return {
			lane: this.name,
			transcript,
			leafId: current.lane.leafId,
			operation,
			queues,
			pendingWrites: [],
			faulted: false,
		};
	}
	async close(): Promise<void> {
		await runHarness(this.closeEffect, this.effectLayer);
	}
}
