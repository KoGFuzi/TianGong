import type { JsonValue } from "@OnePanda-TgSec/chord";
import type { AgentEvent } from "@OnePanda-TgSec/tg-gibraltar";
import type {
	SecEventFrame,
	SecFinding,
	SecGraph,
	SecGraphEdge,
	SecGraphIntent,
	SecGraphNode,
	SecLogPayload,
	SecServerFrame,
	SecStatusPayload,
	SecThoughtPayload,
} from "./contract.ts";
import { projectSecGraph, type SecProjectionInput } from "./projection.ts";

export type SecRunState = {
	running: boolean;
	queued: number;
	turn: number;
};

export function initialRunState(): SecRunState {
	return { running: false, queued: 0, turn: 0 };
}

function snapshotFrame(graph: SecGraph, state: SecRunState, now: number): SecServerFrame {
	return {
		type: "snapshot",
		ts: now,
		payload: graph,
		running: state.running,
		queued: state.queued,
	};
}

function statusFrame(state: SecRunState, now: number): SecEventFrame {
	const payload: SecStatusPayload = {
		status: state.running ? "running" : "idle",
		turn: state.turn,
		running: state.running,
		queued: state.queued,
	};
	return { type: "status", ts: now, payload };
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function lostIds<T extends { id: string }>(previous: readonly T[], next: readonly T[]): boolean {
	if (next.length < previous.length) return true;
	const present = new Set(next.map((item) => item.id));
	return previous.some((item) => !present.has(item.id));
}

/**
 * Holds the last projected graph and turns a fresh projection into the frames that changed. The
 * first projection is a snapshot; a projection that drops an id resynchronizes with a snapshot
 * rather than leaving the client with a stale node; every other change is itemized.
 */
export class SecGraphProjector {
	private graph: SecGraph | undefined;
	private readonly frameListeners = new Set<(frame: SecServerFrame) => void>();
	readonly run: SecRunState;

	constructor(run: SecRunState = initialRunState()) {
		this.run = run;
	}

	current(): SecGraph | undefined {
		return this.graph;
	}

	subscribe(listener: (frame: SecServerFrame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	/** Push one frame to every subscriber; a failing subscriber never stops the others. */
	publish(frame: SecServerFrame): void {
		for (const listener of [...this.frameListeners]) {
			try {
				listener(frame);
			} catch {
				// A broken client socket is dropped by the transport, not by the projector.
			}
		}
	}

	/** Project `input` and return the frames that describe the change since the last projection. */
	update(input: SecProjectionInput): readonly SecServerFrame[] {
		const next = projectSecGraph(input);
		const previous = this.graph;
		this.graph = next;
		if (previous === undefined) return [snapshotFrame(next, this.run, input.now)];
		if (
			lostIds(previous.nodes, next.nodes) ||
			lostIds(previous.edges, next.edges) ||
			lostIds(previous.findings, next.findings) ||
			lostIds(previous.intents, next.intents)
		) {
			return [snapshotFrame(next, this.run, input.now)];
		}
		const frames: SecServerFrame[] = [];
		diffItems("node", previous.nodes, next.nodes, input.now, frames);
		diffItems("edge", previous.edges, next.edges, input.now, frames);
		diffItems("finding", previous.findings, next.findings, input.now, frames);
		diffItems("intent", previous.intents, next.intents, input.now, frames);
		if (!sameJson(previous.rce_path, next.rce_path)) {
			frames.push({ type: "rce_path", ts: input.now, payload: next.rce_path });
		}
		return frames;
	}
}

function diffItems<T extends SecGraphNode | SecGraphEdge | SecFinding | SecGraphIntent>(
	type: "node" | "edge" | "finding" | "intent",
	previous: readonly T[],
	next: readonly T[],
	now: number,
	out: SecServerFrame[],
): void {
	const before = new Map(previous.map((item) => [item.id, item]));
	for (const item of next) {
		if (sameJson(before.get(item.id), item)) continue;
		out.push({ type, ts: now, payload: item });
	}
}

/**
 * Translate harness agent events into contract frames. The graph itself is refreshed separately
 * from the host's projection source; this class only carries run state and the timeline.
 */
export class SecRunProjector {
	readonly state: SecRunState;

	constructor(state: SecRunState = initialRunState()) {
		this.state = state;
	}

	/** Adopt the attach-time snapshot so the first status frame is not a guess. */
	adopt(event: Extract<AgentEvent, { type: "snapshot" }>): void {
		this.state.running = event.run !== undefined;
		this.state.queued = event.inbox.length;
	}

	apply(events: readonly AgentEvent[], now: number): readonly SecServerFrame[] {
		const frames: SecServerFrame[] = [];
		let statusChanged = false;
		for (const event of events) {
			switch (event.type) {
				case "snapshot":
					this.adopt(event);
					statusChanged = true;
					break;
				case "run_start":
					this.state.running = true;
					statusChanged = true;
					break;
				case "run_end":
					this.state.running = false;
					statusChanged = true;
					break;
				case "turn_start":
					this.state.turn += 1;
					statusChanged = true;
					break;
				case "turn_end":
					statusChanged = true;
					break;
				case "inbox_update":
					this.state.queued = event.items.length;
					statusChanged = true;
					break;
				case "tool_execution_start":
					frames.push({
						type: "tool",
						ts: now,
						payload: {
							callId: event.toolCallId,
							name: event.toolName,
							status: "start",
							args: summarizeJson(event.args),
						},
					});
					break;
				case "tool_execution_end": {
					const message = event.entry?.model?.[0];
					const result = message?.role === "toolResult" ? message : undefined;
					frames.push({
						type: "tool_result",
						ts: now,
						payload: {
							callId: event.toolCallId,
							name: event.toolName,
							status: "end",
							ok: result !== undefined && !result.isError,
							...(result?.durationMs === undefined ? {} : { durationMs: result.durationMs }),
						},
					});
					break;
				}
				case "message_end": {
					const message = event.entry.model?.[0];
					if (message?.role === "assistant") {
						const text = message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("")
							.trim();
						if (text !== "") {
							const payload: SecThoughtPayload = { text: text.length > 4000 ? `${text.slice(0, 3999)}…` : text };
							frames.push({ type: "thought", ts: now, payload });
						}
					} else if (event.entry.kind === "sec.steer" && message?.role === "user") {
						const text = typeof message.content === "string" ? message.content : contentText(message.content);
						if (text.trim() !== "") {
							frames.push({
								type: "steer",
								ts: now,
								payload: { content: text.trim(), queued: false, from: "user" },
							});
						}
					}
					break;
				}
				case "auto_retry_start":
					frames.push(logFrame("warn", `provider retry ${event.attempt}: ${event.errorMessage}`, now));
					break;
				case "auto_retry_end":
					frames.push(logFrame("info", `provider retry ${event.attempt} ended`, now));
					break;
				case "deferred_poll":
					frames.push(logFrame("info", "provider is deferred; the harness will poll again", now));
					break;
				case "task_failed":
					frames.push(logFrame("error", `task ${event.kind} failed: ${event.message}`, now));
					break;
				case "compaction_start":
					frames.push(logFrame("info", `compaction started (${event.reason})`, now));
					break;
				case "compaction_end":
					frames.push(
						event.error === undefined
							? logFrame("info", `compaction finished (${event.reason})`, now)
							: logFrame("error", `compaction failed (${event.reason}): ${event.error}`, now),
					);
					break;
				case "submission":
					if (event.record.type === "input" && event.record.status === "unanswered") {
						frames.push(logFrame("warn", `submission unanswered: ${event.record.reason}`, now));
					}
					break;
				case "message_start":
				case "message_update":
				case "entry_appended":
				case "agent_changed":
				case "usage_changed":
					break;
			}
		}
		if (statusChanged) frames.push(statusFrame(this.state, now));
		return frames;
	}
}

function logFrame(level: SecLogPayload["level"], message: string, now: number): SecEventFrame {
	return { type: "log", ts: now, payload: { level, message } };
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

const BODY_KEYS = new Set([
	"requestBase64",
	"responseBase64",
	"body",
	"bodyBase64",
	"contentBase64",
	"requestBytes",
	"responseBytes",
	"bytes",
]);

/**
 * A tool call's arguments can carry an evidence body (base64 request/response). Those bodies are
 * content-addressed and must never reach the transcript or the browser, so the summary replaces
 * any body-shaped key with a byte count and caps depth and string length.
 */
function summarizeJson(value: JsonValue, depth = 0): JsonValue {
	if (depth > 4) return "[depth limit]";
	if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 299)}…` : value;
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const items = value.slice(0, 20).map((item) => summarizeJson(item, depth + 1));
		if (value.length > 20) items.push(`[${value.length - 20} more]`);
		return items;
	}
	const out: { [key: string]: JsonValue } = {};
	let count = 0;
	for (const [key, item] of Object.entries(value)) {
		if (count >= 40) {
			out["…"] = "[key limit]";
			break;
		}
		count += 1;
		out[key] = BODY_KEYS.has(key)
			? typeof item === "string"
				? `[omitted ${Math.floor((item.length * 3) / 4)} bytes]`
				: "[omitted]"
			: summarizeJson(item, depth + 1);
	}
	return out;
}
