/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	EventStream,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	type SystemMessage,
	type ToolResultMessage,
	type ToolStateChanges,
	toToolDeclaration,
	validateToolArguments,
} from "@OnePanda-TgSec/tg-ai";
import type { TelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { evaluatePermission, permissionGrantKey, toolResource } from "./permission.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import { type AgentSpanStarter, agentSpanStarter, traceToolCall, turnStopReason } from "./telemetry.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const initialMessages = declareToolChanges(context, prompts);
	const newMessages: AgentMessage[] = [...initialMessages];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...initialMessages],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of initialMessages) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Error class name for a failed assistant message. Prefers the provider diagnostic's error name,
 * which is what the request span records, and falls back to the generic `Error`.
 */
function failureName(message: AssistantMessage): string {
	for (const diagnostic of message.diagnostics ?? []) {
		const name = diagnostic.error?.name;
		if (name) return name;
	}
	return "Error";
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let explicitContinuation = false;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			let preparedMessages: AgentMessage[] = [];
			if (lastCompletedTurn) {
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					preparedMessages = nextTurnSnapshot.messages ?? [];
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				await emit({ type: "turn_start" });
			}

			// The turn span covers this iteration's assistant response and the tool calls it issued.
			// `prepareNextTurn` above and `finishTurn` below stay outside it.
			const turn = await agentSpanStarter(config.telemetryContext)(
				"tg.span.agent.turn",
				{ provider: config.model.provider, model: config.model.id },
				async (turnSpan, toolStarter) => {
					// Process prepared and queued messages before the next assistant response.
					for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];

					const requestUpdate = await config.prepareRequest?.(
						{
							context: currentContext,
							model: config.model,
							thinkingLevel: config.reasoning ?? "off",
						},
						signal,
					);
					if (requestUpdate) {
						currentContext = requestUpdate.context ?? currentContext;
						config = {
							...config,
							model: requestUpdate.model ?? config.model,
							reasoning:
								requestUpdate.thinkingLevel === undefined
									? config.reasoning
									: requestUpdate.thinkingLevel === "off"
										? undefined
										: requestUpdate.thinkingLevel,
						};
					}

					// Stream assistant response. The turn span becomes the parent of the provider
					// request spans the stream function opens.
					const message = await streamAssistantResponse(
						currentContext,
						{ ...config, telemetryContext: turnSpan },
						signal,
						emit,
						streamFunction,
					);
					newMessages.push(message);

					const failed = message.stopReason === "error" || message.stopReason === "aborted";
					const toolCalls = message.content.filter((c) => c.type === "toolCall");
					const toolResults: ToolResultMessage[] = [];
					let hasMore = false;
					if (!failed && toolCalls.length > 0) {
						// A "length" stop means the output was cut off by the token limit, so
						// every tool call in the message may carry truncated arguments. Fail
						// them all instead of executing potentially borked calls.
						const executedToolBatch =
							message.stopReason === "length"
								? await failToolCallsFromTruncatedMessage(toolCalls, emit, toolStarter)
								: await executeToolCalls(currentContext, message, config, signal, emit, toolStarter);
						toolResults.push(...executedToolBatch.messages);
						hasMore = !executedToolBatch.terminate;

						for (const result of toolResults) {
							currentContext.messages.push(result);
							newMessages.push(result);
						}
					}

					const stopReason = turnStopReason(message.stopReason);
					turnSpan.setAttributes({
						toolCallCount: toolCalls.length,
						...(stopReason === undefined ? {} : { stopReason }),
					});
					if (failed) {
						turnSpan.setStatus({
							status: "error",
							error: { name: failureName(message), message: message.errorMessage ?? "" },
						});
					}
					return { message, toolResults, hasMoreToolCalls: hasMore, failed };
				},
			);

			hasMoreToolCalls = turn.hasMoreToolCalls;
			lastCompletedTurn = {
				message: turn.message,
				toolResults: turn.toolResults,
				context: currentContext,
				newMessages,
			};
			if (turn.failed) {
				await config.finishTurn?.(lastCompletedTurn, signal);
				await emit({ type: "turn_end", message: turn.message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const decision = await config.finishTurn?.(lastCompletedTurn, signal);
			await emit({ type: "turn_end", message: turn.message, toolResults: turn.toolResults });

			if (decision?.action === "end") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			explicitContinuation = decision?.action === "continue";
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			if (turn.hasMoreToolCalls || pendingMessages.length > 0) {
				explicitContinuation = false;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			explicitContinuation = false;
			pendingMessages = followUpMessages;
			continue;
		}

		// No natural request was selected, so fulfill the continuation decision with one context-only turn.
		if (explicitContinuation) {
			explicitContinuation = false;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Declare tool loadout changes to the model.
 *
 * `context.tools` is what the runtime can execute; the transcript's system messages declare
 * what the model may call. Before each request the difference becomes `toolsAdded` and
 * `toolsRemoved` on a system message. When a pending system message exists, its tool fields
 * are treated as intent and replaced with the delta between the committed transcript and
 * the executable set, so replay always yields exactly `context.tools`. Otherwise a new
 * system message is inserted before the first non-system pending message.
 */
function declareToolChanges(context: AgentContext, pendingMessages: AgentMessage[]): AgentMessage[] {
	let systemIndex = -1;
	for (let i = pendingMessages.length - 1; i >= 0; i--) {
		if (pendingMessages[i].role === "system") {
			systemIndex = i;
			break;
		}
	}
	const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
	const baseline = pending
		? pendingMessages.map((message, index) =>
				index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
			)
		: pendingMessages;
	const changes = getToolStateChanges(
		getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(toToolDeclaration),
	);
	const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

	if (pending) {
		// Keep the caller's message object when it already declares no tool changes.
		if (unchanged && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) return pendingMessages;
		return baseline.map((message, index) => (index === systemIndex ? withToolChanges(pending, changes) : message));
	}
	if (unchanged) return pendingMessages;
	const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
	const insertIndex = pendingMessages.findIndex((message) => message.role !== "system");
	const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
	return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** Copy a system message with its tool fields replaced by `changes`; empty lists omit the field. */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	const llmContext = normalizeContext({ messages: llmMessages });

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});
	// Record the requested level, whichever stream function answered.
	const result = async () => Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
	toolStarter: AgentSpanStarter,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized = await traceToolCall(
			toolStarter,
			toolCall.name,
			async (): Promise<FinalizedToolCallOutcome> => ({
				toolCall,
				result: createErrorToolResult(
					`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
				),
				isError: true,
			}),
			(outcome) => outcome.isError,
		);
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	toolStarter: AgentSpanStarter,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit, toolStarter);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit, toolStarter);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	toolStarter: AgentSpanStarter,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const finalized = await traceToolCall(
			toolStarter,
			toolCall.name,
			async (): Promise<FinalizedToolCallOutcome> => {
				const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
				if (preparation.kind === "immediate") {
					return {
						toolCall,
						result: preparation.result,
						isError: preparation.isError,
					};
				}
				const executed = await executePreparedToolCall(
					preparation,
					signal,
					emitToolExecutionUpdate(toolCall, emit),
				);
				return await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
				);
			},
			(outcome) => outcome.isError,
		);

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	toolStarter: AgentSpanStarter,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = await traceToolCall(
				toolStarter,
				toolCall.name,
				async (): Promise<FinalizedToolCallOutcome> => ({
					toolCall,
					result: preparation.result,
					isError: preparation.isError,
				}),
				(outcome) => outcome.isError,
			);
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const finalized = await traceToolCall(
				toolStarter,
				toolCall.name,
				async (): Promise<FinalizedToolCallOutcome> => {
					if (signal?.aborted) {
						return {
							toolCall,
							result: createErrorToolResult("Operation aborted"),
							isError: true,
						};
					}
					const executed = await executePreparedToolCall(
						preparation,
						signal,
						emitToolExecutionUpdate(toolCall, emit),
					);
					return await finalizeExecutedToolCall(
						currentContext,
						assistantMessage,
						preparation,
						executed,
						config,
						signal,
					);
				},
				(outcome) => outcome.isError,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** The `beforeToolCall` and `afterToolCall` hooks of {@link AgentLoopConfig}. */
export type ToolCallHooks = Pick<
	AgentLoopConfig,
	"beforeToolCall" | "afterToolCall" | "permissionRules" | "onPermissionAsk" | "permissionGrants"
>;

type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

/**
 * Evaluate the declarative permission policy for one tool call, after `beforeToolCall` abstained.
 *
 * Returns an error result when the call must not run, or `undefined` when it may proceed. Deny and
 * ask-denied outcomes reuse {@link createErrorToolResult}, the exact path a `{ block: true }` hook
 * return takes, so the model sees the same refusal semantics regardless of who refused.
 *
 * Failure mode: an `ask` hit with no `onPermissionAsk` handler configured is blocked. That is the
 * one fail-closed point in the design — an explicit ask rule with nobody listening must not be
 * silently downgraded to allow.
 */
async function evaluateToolPermission(
	tool: AgentTool<any>,
	args: unknown,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<any> | undefined> {
	const rules = config.permissionRules;
	if (!rules || rules.length === 0) return undefined;

	const resource = toolResource(tool.name);
	// A session-scoped "always" grant outranks the rule list: explicit human approval beats
	// declared rules, including deny.
	if (config.permissionGrants?.has(permissionGrantKey("execute", resource))) return undefined;
	const decision = evaluatePermission(rules, resource);
	if (decision === "allow") return undefined;

	if (decision === "deny") {
		return createErrorToolResult(`Permission denied: ${resource} is blocked by a permission rule`);
	}

	if (!config.onPermissionAsk) {
		return createErrorToolResult(
			`Permission denied: ${resource} requires approval but no onPermissionAsk handler is configured`,
		);
	}
	let reply: "allow" | "deny" | "always";
	try {
		reply = await config.onPermissionAsk({ action: "execute", resource, toolName: tool.name, args }, signal);
	} catch (error) {
		return createErrorToolResult(
			`Permission denied: approval for ${resource} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (reply === "deny") {
		return createErrorToolResult(`Permission denied: approval for ${resource} was declined`);
	}
	if (reply === "always") {
		// Keyed on the exact resource of this call, not the rule's pattern: "always" for one tool
		// must not widen to every tool a wildcard would match.
		config.permissionGrants?.add(permissionGrantKey("execute", resource));
	}
	return undefined;
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		// The hook abstained (undefined, {}, or { block: false }), so the declarative policy
		// decides. Deny and ask-denied outcomes reuse the same error result as a hook block.
		const permissionBlocked = await evaluateToolPermission(tool, validatedArgs, config, signal);
		if (permissionBlocked) {
			return {
				kind: "immediate",
				result: permissionBlocked,
				isError: true,
			};
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: AgentContext;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
	/**
	 * Parent context for this call's `tg.span.agent.tool` span. Nested callers pass the enclosing
	 * tool span so the child nests under it; omit it to record nothing.
	 */
	telemetryContext?: TelemetryContext;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`.
 */
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	return await traceToolCall(
		agentSpanStarter(options.telemetryContext),
		toolCall.name,
		async (): Promise<AgentToolCallOutcome> => {
			const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, options.tools);
			if (preparation.kind === "immediate") {
				return { toolCall, result: preparation.result, isError: preparation.isError };
			}
			const executed = await executePreparedToolCall(preparation, signal, options.onUpdate ?? (() => {}));
			return await finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
		},
		(outcome) => outcome.isError,
	);
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(Promise.resolve(onUpdate(partialResult)));
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: result.isError === true };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				// Structured content not replaced along with the content may no longer match it.
				const structuredContent =
					afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				if (structuredContent === undefined) delete result.structuredContent;
				else result.structuredContent = structuredContent;
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
