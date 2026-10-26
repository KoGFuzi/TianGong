import type { JsonValue } from "@OnePanda-TgSec/chord";
import {
	SEC_RCE_NODE_KINDS,
	SEC_SEVERITY_ORDER,
	SEC_SEVERITY_SCORE,
	type SecFinding,
	type SecFrontier,
	type SecGraph,
	type SecGraphEdge,
	type SecGraphIntent,
	type SecGraphNode,
	type SecGraphStats,
	type SecNodeKind,
	type SecRcePath,
	type SecSeverity,
	secKindForKey,
} from "./contract.ts";

/** Lifecycle of one delegated child conversation, as the action tree records it. */
export type SecProjectionActionStatus = "open" | "done" | "failed";

/** One delegated conversation the projection turns into a node, an edge and an intent. */
export type SecProjectionAction = {
	readonly conversationId: number;
	readonly parentConversationId: number;
	readonly ownerTaskId: number;
	readonly at: number;
	readonly intent: string;
	readonly openedAt: number;
	readonly status: SecProjectionActionStatus;
	readonly summaryRef: string;
};

export type SecProjectionEvidenceRole = "baseline" | "proof" | "verification" | "supporting";

/** One evidence binding, metadata only: a capture body never enters the projection. */
export type SecProjectionEvidenceBinding = {
	readonly snapshotId: string;
	readonly role: SecProjectionEvidenceRole;
	readonly note: string;
	readonly capturedAt: number;
	readonly method: string;
	readonly url: string;
	readonly status: number;
};

/** One evidence subject (a finding id) with the snapshots bound to it. */
export type SecProjectionEvidenceSubject = {
	readonly subjectId: string;
	readonly version: number;
	readonly bindings: readonly SecProjectionEvidenceBinding[];
};

/** Everything the projection reads; the host assembles it from the action tree and evidence store. */
export type SecProjectionInput = {
	readonly project: string;
	readonly target: string;
	readonly rootConversationId: number;
	readonly actions: readonly SecProjectionAction[];
	readonly evidence: readonly SecProjectionEvidenceSubject[];
	readonly now: number;
};

const MAX_TITLE = 120;
const MAX_DETAIL = 2000;
const MAX_PATH_DEPTH = 8;
const MAX_PATHS_PER_SOURCE = 4096;

/** Root key: the one target the campaign starts from. */
export function rootTargetKey(project: string): string {
	const slug = project.trim() === "" ? "campaign" : project.trim();
	return `target:${slug}`;
}

/** Action key for one delegated conversation; the prefix is what the contract's key inference reads. */
export function actionNodeKey(kind: SecNodeKind, conversationId: number): string {
	return `${kind}:action-${conversationId}`;
}

/**
 * Project the campaign onto the contract graph. The projection is a pure function of its input: the
 * same action tree and evidence version always produce the same graph, which is what lets the
 * projector diff successive reads into node/edge/finding frames.
 */
export function projectSecGraph(input: SecProjectionInput): SecGraph {
	const rootKey = rootTargetKey(input.project);
	const nodes: SecGraphNode[] = [];
	const edges: SecGraphEdge[] = [];
	const intents: SecGraphIntent[] = [];
	const actionsByConversation = new Map<number, SecGraphNode>();

	nodes.push({
		id: rootKey,
		key: rootKey,
		type: "target",
		title: clip(input.target.trim() === "" ? input.project : input.target.trim(), MAX_TITLE),
		detail: { project: input.project, target: input.target } satisfies JsonValue,
		severity: "info",
		is_rce: false,
		risk_score: riskScore("info", "target", false),
		tags: ["entry", "campaign"],
		status: "open",
		created_at: input.now,
		updated_at: input.now,
	});

	const ordered = [...input.actions].sort((a, b) => a.openedAt - b.openedAt || a.conversationId - b.conversationId);
	for (const action of ordered) {
		const parsed = actionKind(action.intent);
		const kind = parsed.kind === "goal" ? "danger" : parsed.kind;
		const key = actionNodeKey(kind, action.conversationId);
		const severity = actionSeverity(kind);
		const node: SecGraphNode = {
			id: key,
			key,
			type: kind,
			title: clip(parsed.label, MAX_TITLE),
			detail: {
				intent: clip(action.intent, MAX_DETAIL),
				ownerTaskId: action.ownerTaskId,
				summaryRef: clip(action.summaryRef, MAX_DETAIL),
				status: action.status,
			} satisfies JsonValue,
			severity,
			is_rce: false,
			risk_score: riskScore(severity, kind, false),
			tags: [
				"action",
				`conversation:${action.conversationId}`,
				`task:${action.ownerTaskId}`,
				...(parsed.kind === "goal" ? ["goal-intent"] : []),
				...(action.summaryRef === "" ? [] : ["summarized"]),
			],
			status: action.status,
			created_at: action.openedAt,
			updated_at: action.openedAt,
		};
		nodes.push(node);
		actionsByConversation.set(action.conversationId, node);
	}

	for (const action of ordered) {
		const node = actionsByConversation.get(action.conversationId);
		if (node === undefined) continue;
		const parent =
			action.parentConversationId === input.rootConversationId
				? rootKey
				: (actionsByConversation.get(action.parentConversationId)?.key ?? rootKey);
		edges.push(containsEdge(parent, node.key, action.status, action.ownerTaskId));
		intents.push(intentForAction(action, parent));
	}

	for (const subject of input.evidence) {
		const key = evidenceNodeKey(subject.subjectId);
		const createdAt = earliestCapture(subject) ?? input.now;
		nodes.push({
			id: key,
			key,
			type: "vuln",
			title: clip(subject.subjectId, MAX_TITLE),
			detail: {
				subjectId: subject.subjectId,
				version: subject.version,
				snapshots: subject.bindings.map((binding) => ({
					snapshotId: binding.snapshotId,
					role: binding.role,
					note: clip(binding.note, 300),
					method: binding.method,
					url: clip(binding.url, 300),
					status: binding.status,
					capturedAt: binding.capturedAt,
				})),
			} satisfies JsonValue,
			severity: "info",
			is_rce: false,
			risk_score: riskScore("info", "vuln", false),
			tags: [
				"evidence",
				"unrated",
				`subject:${subject.subjectId}`,
				...new Set(subject.bindings.map((binding) => `role:${binding.role}`)),
			],
			status: "open",
			created_at: createdAt,
			updated_at: input.now,
		});
		edges.push({
			id: `leads-to:${rootKey}->${key}`,
			from: rootKey,
			to: key,
			relation: "LEADS_TO",
			weight: 0.3,
			rationale: `evidence subject ${subject.subjectId} at version ${subject.version}`,
			on_rce_path: false,
		});
	}

	const findings = input.evidence.map((subject) => findingForSubject(subject, input.now));
	const marked = markRcePath(nodes, edges, findings);
	const rcePath = marked.path;
	const stats = computeStats(nodes, edges, findings, intents);
	const frontier = computeFrontier(intents);
	return { nodes, edges: marked.edges, findings, intents, frontier, rce_path: rcePath, stats };
}

function actionKind(intent: string): { kind: SecNodeKind; label: string } {
	const trimmed = intent.trim();
	const keyed = secKindForKey(trimmed);
	if (keyed !== undefined && keyed !== "target") {
		const colon = trimmed.indexOf(":");
		const label = trimmed.slice(colon + 1).trim();
		return { kind: keyed, label: label === "" ? trimmed : label };
	}
	return { kind: "info", label: trimmed === "" ? "delegated action" : trimmed };
}

function actionSeverity(kind: SecNodeKind): SecSeverity {
	if (kind === "goal") return "high";
	if (kind === "vuln" || kind === "danger" || kind === "credential" || kind === "foothold") return "medium";
	return "info";
}

/** A delegated action proves the conversation ran, not that the exploit landed; never mark RCE. */
function riskScore(severity: SecSeverity, kind: SecNodeKind, isRce: boolean): number {
	let score = SEC_SEVERITY_SCORE[severity];
	if (isRce || SEC_RCE_NODE_KINDS.has(kind)) score = Math.max(score, 90) + 6;
	if (kind === "vuln" || kind === "danger") score += 4;
	if (kind === "honeypot") score = Math.min(score, 15);
	return Math.round(Math.min(score, 100) * 10) / 10;
}

function containsEdge(from: string, to: string, status: SecProjectionActionStatus, ownerTaskId: number): SecGraphEdge {
	const weight = status === "done" ? 1 : status === "failed" ? 0.25 : 0.5;
	return {
		id: `contains:${from}->${to}`,
		from,
		to,
		relation: "CONTAINS",
		weight,
		rationale: `delegated through task ${ownerTaskId}`,
		on_rce_path: false,
	};
}

function intentForAction(action: SecProjectionAction, parentKey: string): SecGraphIntent {
	const status = action.status === "done" ? "verified" : action.status === "failed" ? "disproved" : "open";
	const estSuccess = action.status === "done" ? 1 : action.status === "failed" ? 0.05 : 0.5;
	return {
		id: `intent:conv-${action.conversationId}`,
		from: [parentKey],
		description: clip(action.intent.trim() === "" ? "delegated action" : action.intent, MAX_DETAIL),
		rationale: `conversation ${action.conversationId}, task ${action.ownerTaskId}`,
		est_success: estSuccess,
		status,
		strategy_key: `conv-${action.conversationId}`,
		priority: action.status === "open" ? 1 : 0,
		...(action.summaryRef === "" ? {} : { result_summary: clip(action.summaryRef, MAX_DETAIL) }),
	};
}

/** A subject id may hold any character; the node key keeps a readable stem and a short hash. */
export function evidenceNodeKey(subjectId: string): string {
	const stem = subjectId
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	const readable = stem === "" ? "subject" : stem;
	return `vuln:evidence-${readable}-${shortHash(subjectId)}`;
}

function shortHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function earliestCapture(subject: SecProjectionEvidenceSubject): number | undefined {
	let earliest: number | undefined;
	for (const binding of subject.bindings) {
		if (binding.capturedAt <= 0) continue;
		if (earliest === undefined || binding.capturedAt < earliest) earliest = binding.capturedAt;
	}
	return earliest;
}

function evidenceSummary(subject: SecProjectionEvidenceSubject): string {
	if (subject.bindings.length === 0) return "no snapshots bound";
	return clip(
		subject.bindings
			.map((binding) => {
				const request = `${binding.method || "?"} ${binding.url || "(no url)"}`;
				const note = binding.note === "" ? "" : ` - ${binding.note}`;
				return `[${binding.role}] ${request} -> ${binding.status}${note}`;
			})
			.join("\n"),
		MAX_DETAIL,
	);
}

function findingForSubject(subject: SecProjectionEvidenceSubject, now: number): SecFinding {
	return {
		id: subject.subjectId,
		node_key: evidenceNodeKey(subject.subjectId),
		severity: "info",
		category: "evidence",
		title: clip(subject.subjectId, MAX_TITLE),
		description: `${subject.bindings.length} snapshot(s) bound at evidence version ${subject.version}; severity is unrated until a proof is verified`,
		evidence: evidenceSummary(subject),
		critical: false,
		created_at: earliestCapture(subject) ?? now,
		verification_status: "pending",
	};
}

function closeableVerified(key: string, findings: readonly SecFinding[]): boolean {
	return findings.some(
		(finding) =>
			finding.node_key === key &&
			finding.verification_status === "verified" &&
			(finding.critical || SEC_SEVERITY_ORDER[finding.severity] >= SEC_SEVERITY_ORDER.high),
	);
}

function sinkPriority(node: SecGraphNode, findings: readonly SecFinding[]): number {
	const tags = new Set(node.tags.map((tag) => tag.toLowerCase()));
	if (node.type === "goal" && node.key.startsWith("goal:shell")) return 4;
	if (node.type === "foothold" && (node.is_rce || tags.has("getshell"))) return 3;
	if ((node.type === "vuln" || node.type === "danger") && closeableVerified(node.key, findings)) return 3;
	if (node.type === "vuln" && node.is_rce) return 2;
	if (node.type === "foothold") return 1;
	return 0;
}

function isSinkFindable(node: SecGraphNode): boolean {
	return node.type === "danger" || node.type === "vuln";
}

type AttackEdge = { to: string; weight: number };

function attackAdjacency(nodes: readonly SecGraphNode[], edges: readonly SecGraphEdge[]): Map<string, AttackEdge[]> {
	const byKey = new Map(nodes.map((node) => [node.key, node]));
	const adjacency = new Map<string, AttackEdge[]>();
	for (const edge of edges) {
		if (edge.relation === "PIVOTS_TO") continue;
		const from = byKey.get(edge.from);
		const to = byKey.get(edge.to);
		if (from === undefined || to === undefined) continue;
		if (from.type === "target" && (to.type === "goal" || to.key.startsWith("goal:") || to.key.startsWith("flag:"))) {
			continue;
		}
		const weight = Math.max(0.01, Math.min(1, edge.weight));
		const list = adjacency.get(edge.from) ?? [];
		list.push({ to: edge.to, weight });
		adjacency.set(edge.from, list);
	}
	return adjacency;
}

function pathLikelihood(path: readonly string[], weights: ReadonlyMap<string, number>): number {
	if (path.length <= 1) return path.length === 0 ? 0 : 1;
	let likelihood = 1;
	for (let index = 0; index < path.length - 1; index += 1) {
		const weight = weights.get(edgePair(path[index]!, path[index + 1]!));
		if (weight === undefined) return 0;
		likelihood *= weight;
	}
	return likelihood;
}

function edgePair(from: string, to: string): string {
	return `${from}\u0000${to}`;
}

/**
 * Every simple path from each source to a sink, capped so a pathological graph cannot stall the
 * projector. The reference picks the longest, most likely chain within the highest sink tier; the
 * same ordering is applied here.
 */
function findPaths(
	sources: readonly string[],
	sinkKeys: ReadonlySet<string>,
	adjacency: ReadonlyMap<string, AttackEdge[]>,
	maxDepth: number,
): string[][] {
	const found: string[][] = [];
	for (const source of sources) {
		const stack: { path: string[]; visited: Set<string> }[] = [{ path: [source], visited: new Set([source]) }];
		while (stack.length > 0 && found.length < MAX_PATHS_PER_SOURCE) {
			const current = stack.pop()!;
			const tail = current.path[current.path.length - 1]!;
			if (current.path.length > 1 && sinkKeys.has(tail)) {
				found.push(current.path);
				continue;
			}
			if (current.path.length >= maxDepth) continue;
			for (const next of adjacency.get(tail) ?? []) {
				if (current.visited.has(next.to)) continue;
				const visited = new Set(current.visited);
				visited.add(next.to);
				stack.push({ path: [...current.path, next.to], visited });
			}
		}
	}
	return found;
}

function betterPath(candidate: string[], incumbent: string[], weights: ReadonlyMap<string, number>): boolean {
	if (incumbent.length === 0) return true;
	if (candidate.length !== incumbent.length) return candidate.length > incumbent.length;
	return pathLikelihood(candidate, weights) > pathLikelihood(incumbent, weights);
}

function markRcePath(
	nodes: readonly SecGraphNode[],
	edges: readonly SecGraphEdge[],
	findings: readonly SecFinding[],
): { edges: SecGraphEdge[]; path: SecRcePath } {
	const adjacency = attackAdjacency(nodes, edges);
	const weights = new Map<string, number>();
	for (const [from, list] of adjacency) {
		for (const edge of list) weights.set(edgePair(from, edge.to), edge.weight);
	}

	const priorities = new Map<string, number>();
	for (const node of nodes) priorities.set(node.key, sinkPriority(node, findings));
	const sinks = nodes.filter((node) => (priorities.get(node.key) ?? 0) > 0).map((node) => node.key);
	const frontierMode = sinks.length === 0;
	let effectiveSinks = sinks;
	if (frontierMode) {
		const ranked = nodes
			.filter(isSinkFindable)
			.slice()
			.sort((a, b) => b.risk_score - a.risk_score || a.key.localeCompare(b.key));
		effectiveSinks = ranked.length === 0 ? [] : [ranked[0]!.key];
	}
	const sources = nodes.filter((node) => node.type === "target").map((node) => node.key);
	const sourceList =
		sources.length === 0 ? nodes.filter((node) => !hasIncoming(node.key, edges)).map((node) => node.key) : sources;
	const sinkSet = new Set(effectiveSinks);
	const allPaths = findPaths(sourceList, sinkSet, adjacency, MAX_PATH_DEPTH);

	const bestBySource = new Map<string, string[]>();
	for (const path of allPaths) {
		const source = path[0]!;
		const incumbent = bestBySource.get(source) ?? [];
		const candidatePriority = priorities.get(path[path.length - 1]!) ?? 0;
		const incumbentPriority = incumbent.length === 0 ? -1 : (priorities.get(incumbent[incumbent.length - 1]!) ?? 0);
		if (
			candidatePriority > incumbentPriority ||
			(candidatePriority === incumbentPriority && betterPath(path, incumbent, weights))
		) {
			bestBySource.set(source, path);
		}
	}

	const paths: string[][] = [];
	const seen = new Set<string>();
	for (const path of bestBySource.values()) {
		const signature = path.join("\u0000");
		if (seen.has(signature)) continue;
		seen.add(signature);
		paths.push(path);
	}
	let best: string[] = [];
	for (const path of paths) if (betterPath(path, best, weights)) best = path;
	const likelihood = best.length === 0 ? 0 : Math.round(pathLikelihood(best, weights) * 10000) / 10000;

	const pairs = new Set<string>();
	for (const path of paths) {
		for (let index = 0; index < path.length - 1; index += 1) {
			pairs.add(edgePair(path[index]!, path[index + 1]!));
		}
	}
	return {
		edges: edges.map((edge) => ({
			...edge,
			on_rce_path: pairs.has(edgePair(edge.from, edge.to)),
		})),
		path: { path: best, paths, likelihood, frontier_mode: frontierMode },
	};
}

function hasIncoming(key: string, edges: readonly SecGraphEdge[]): boolean {
	return edges.some((edge) => edge.to === key);
}

function computeFrontier(intents: readonly SecGraphIntent[]): SecFrontier {
	const byStatus: Record<string, number> = {};
	const strategies = new Set<string>();
	for (const intent of intents) {
		byStatus[intent.status] = (byStatus[intent.status] ?? 0) + 1;
		if (intent.strategy_key !== undefined) strategies.add(intent.strategy_key);
	}
	return {
		open: (byStatus.open ?? 0) + (byStatus.active ?? 0),
		strategies: strategies.size,
		by_status: byStatus,
	};
}

function computeStats(
	nodes: readonly SecGraphNode[],
	edges: readonly SecGraphEdge[],
	findings: readonly SecFinding[],
	intents: readonly SecGraphIntent[],
): SecGraphStats {
	const frontier = computeFrontier(intents);
	const landed = nodes.filter((node) => isLandedShell(node));
	const hosts = new Set<string>();
	for (const node of landed) {
		const host = hostOf(node);
		if (host !== "") hosts.add(host);
	}
	const pivotEdges = edges.filter((edge) => edge.relation === "PIVOTS_TO").length;
	const severity = (level: SecSeverity): number => findings.filter((finding) => finding.severity === level).length;
	return {
		nodes: nodes.length,
		services: nodes.filter((node) => node.type === "service").length,
		edges: edges.length,
		findings: findings.length,
		high: severity("high"),
		medium: severity("medium"),
		low: severity("low") + severity("info"),
		critical: severity("critical"),
		has_shell: landed.length > 0,
		frontier_open: frontier.open,
		frontier_strategies: frontier.strategies,
		lateral_active: pivotEdges > 0 || hosts.size >= 2,
		pivot_edges: pivotEdges,
		hosts_footed: hosts.size,
	};
}

function isLandedShell(node: SecGraphNode): boolean {
	if (node.type !== "foothold" && node.type !== "goal") return false;
	const tags = new Set(node.tags.map((tag) => tag.toLowerCase()));
	return (
		node.is_rce || tags.has("getshell") || node.key.startsWith("goal:shell") || node.key.startsWith("foothold:shell")
	);
}

function hostOf(node: SecGraphNode): string {
	for (const tag of node.tags) {
		if (tag.toLowerCase().startsWith("host:")) return tag.slice(5).trim().toLowerCase();
	}
	const matched = /@([A-Za-z0-9][A-Za-z0-9.-]*)$/.exec(node.key);
	return matched === null ? "" : matched[1]!.toLowerCase();
}

function clip(text: string, max: number): string {
	const value = text.trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
