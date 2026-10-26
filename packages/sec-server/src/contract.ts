import type { JsonValue } from "@OnePanda-TgSec/chord";

/**
 * The wire contract the campaign WebUI speaks. The literals are the StrikeAgent protocol's, kept
 * verbatim so a client written against that contract can read this projection; the projection and
 * server behind them are a TianGong implementation (`docs/sec-agent-design.md` 批6).
 */
export const SEC_PROTOCOL_VERSION = 1;

export const SEC_NODE_KINDS = [
	"target",
	"info",
	"service",
	"danger",
	"vuln",
	"credential",
	"foothold",
	"honeypot",
	"goal",
] as const;

export type SecNodeKind = (typeof SEC_NODE_KINDS)[number];

export const SEC_RELATIONS = ["LEADS_TO", "EXPLOITS", "ESCALATES_TO", "PIVOTS_TO", "CONTAINS"] as const;

export type SecRelation = (typeof SEC_RELATIONS)[number];

export const SEC_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export type SecSeverity = (typeof SEC_SEVERITIES)[number];

export const SEC_INTENT_STATUSES = ["open", "active", "verified", "disproved", "deferred"] as const;

export type SecIntentStatus = (typeof SEC_INTENT_STATUSES)[number];

export const SEC_VERIFICATION_STATUSES = ["pending", "verified", "rejected", "excluded"] as const;

export type SecVerificationStatus = (typeof SEC_VERIFICATION_STATUSES)[number];

/** Numeric rank for severity floors and ordered display. */
export const SEC_SEVERITY_ORDER: Readonly<Record<SecSeverity, number>> = {
	info: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

/** The base risk score each severity starts from, before type and RCE modifiers. */
export const SEC_SEVERITY_SCORE: Readonly<Record<SecSeverity, number>> = {
	info: 5,
	low: 20,
	medium: 45,
	high: 72,
	critical: 92,
};

/** Node kinds whose presence means the campaign reached code execution or a session. */
export const SEC_RCE_NODE_KINDS: ReadonlySet<SecNodeKind> = new Set(["foothold", "goal"]);

/** Key prefixes the contract uses to type a node; the first match wins. */
export const SEC_NODE_PREFIXES: readonly (readonly [string, SecNodeKind])[] = [
	["target:", "target"],
	["svc:", "service"],
	["service:", "service"],
	["danger:", "danger"],
	["vuln:", "vuln"],
	["cred:", "credential"],
	["credential:", "credential"],
	["foothold:", "foothold"],
	["honeypot:", "honeypot"],
	["goal:", "goal"],
];

export function secKindForKey(key: string): SecNodeKind | undefined {
	const lower = key.trim().toLowerCase();
	for (const [prefix, kind] of SEC_NODE_PREFIXES) {
		if (lower.startsWith(prefix)) return kind;
	}
	return undefined;
}

export function isSecNodeKind(value: string): value is SecNodeKind {
	return (SEC_NODE_KINDS as readonly string[]).includes(value);
}

export function isSecRelation(value: string): value is SecRelation {
	return (SEC_RELATIONS as readonly string[]).includes(value);
}

export function isSecSeverity(value: string): value is SecSeverity {
	return (SEC_SEVERITIES as readonly string[]).includes(value);
}

export type SecGraphNode = {
	id: string;
	key: string;
	type: SecNodeKind;
	title: string;
	detail: JsonValue;
	severity: SecSeverity;
	is_rce: boolean;
	risk_score: number;
	tags: string[];
	status: string;
	created_at?: number;
	updated_at?: number;
};

/** Edge endpoints are node **keys**, as in the reference graph contract. */
export type SecGraphEdge = {
	id: string;
	from: string;
	to: string;
	relation: SecRelation;
	weight: number;
	rationale: string;
	on_rce_path: boolean;
};

export type SecFinding = {
	id: string;
	node_key: string;
	severity: SecSeverity;
	category: string;
	title: string;
	description: string;
	evidence: string;
	critical: boolean;
	created_at: number;
	verification_status: SecVerificationStatus;
};

export type SecGraphIntent = {
	id: string;
	from: string[];
	description: string;
	rationale: string;
	est_success: number;
	status: SecIntentStatus;
	strategy_key?: string;
	priority?: number;
	result_summary?: string;
};

export type SecRcePath = {
	path: string[];
	paths: string[][];
	likelihood: number;
	frontier_mode: boolean;
};

export type SecFrontier = {
	open: number;
	strategies: number;
	by_status: Record<string, number>;
};

export type SecGraphStats = {
	nodes: number;
	services: number;
	edges: number;
	findings: number;
	high: number;
	medium: number;
	low: number;
	critical: number;
	has_shell: boolean;
	frontier_open: number;
	frontier_strategies: number;
	lateral_active: boolean;
	pivot_edges: number;
	hosts_footed: number;
};

export type SecGraph = {
	nodes: SecGraphNode[];
	edges: SecGraphEdge[];
	findings: SecFinding[];
	intents: SecGraphIntent[];
	frontier: SecFrontier;
	rce_path: SecRcePath;
	stats: SecGraphStats;
};

/** The event names the projection emits; the reference client switches on these. */
export const SEC_EVENT_TYPES = [
	"node",
	"edge",
	"finding",
	"intent",
	"rce_path",
	"steer",
	"log",
	"status",
	"tool",
	"tool_result",
	"thought",
	"memory",
] as const;

export type SecEventType = (typeof SEC_EVENT_TYPES)[number];

/** One projected event, shaped like the reference `RTEvent`. */
export type SecEventFrame = {
	type: SecEventType;
	ts: number;
	payload: SecEventPayload;
};

export type SecSteerPayload = {
	content: string;
	queued: boolean;
	from: "chat" | "user" | "supervisor";
};

export type SecLogPayload = {
	level: "info" | "warn" | "error";
	message: string;
};

export type SecStatusPayload = {
	status: string;
	turn: number;
	running: boolean;
	queued: number;
};

export type SecToolPayload = {
	callId: string;
	name: string;
	status: "start" | "end";
	args?: JsonValue;
	ok?: boolean;
	durationMs?: number;
};

export type SecThoughtPayload = {
	text: string;
};

export type SecMemoryPayload = {
	text: string;
	kind?: string;
};

export type SecEventPayload =
	| SecGraphNode
	| SecGraphEdge
	| SecFinding
	| SecGraphIntent
	| SecRcePath
	| SecSteerPayload
	| SecLogPayload
	| SecStatusPayload
	| SecToolPayload
	| SecThoughtPayload
	| SecMemoryPayload;

/** The first frame on every connection: the whole graph plus the run state it was read with. */
export type SecSnapshotFrame = {
	type: "snapshot";
	ts: number;
	payload: SecGraph;
	running: boolean;
	queued: number;
};

export type SecPongFrame = {
	type: "pong";
	ts: number;
};

export type SecServerFrame = SecSnapshotFrame | SecEventFrame | SecPongFrame;

/** Frames a browser client sends; anything else is ignored. */
export type SecClientFrame = { type: "steer"; content: string } | { type: "refresh" } | { type: "ping" };

export function isSecSnapshotFrame(frame: SecServerFrame): frame is SecSnapshotFrame {
	return frame.type === "snapshot";
}

export function isSecEventFrame(frame: SecServerFrame): frame is SecEventFrame {
	return frame.type !== "snapshot" && frame.type !== "pong";
}
