import { describe, expect, test } from "vitest";
import { SEC_SEVERITY_SCORE } from "../src/contract.ts";
import {
	actionNodeKey,
	evidenceNodeKey,
	projectSecGraph,
	rootTargetKey,
	type SecProjectionAction,
	type SecProjectionEvidenceSubject,
	type SecProjectionInput,
} from "../src/projection.ts";

const ROOT = 1;

function input(
	overrides: Partial<Pick<SecProjectionInput, "project" | "target" | "actions" | "evidence" | "now">> = {},
): SecProjectionInput {
	return {
		project: "demo",
		target: "https://demo.local",
		rootConversationId: ROOT,
		actions: [],
		evidence: [],
		now: 1000,
		...overrides,
	};
}

function action(overrides: Partial<SecProjectionAction> = {}): SecProjectionAction {
	return {
		conversationId: 2,
		parentConversationId: ROOT,
		ownerTaskId: 11,
		at: 20,
		intent: "service: 8080/http nginx",
		openedAt: 20,
		status: "done",
		summaryRef: "",
		...overrides,
	};
}

function evidence(overrides: Partial<SecProjectionEvidenceSubject> = {}): SecProjectionEvidenceSubject {
	return {
		subjectId: "finding-1",
		version: 3,
		bindings: [
			{
				snapshotId: "snap-1",
				role: "proof",
				note: "admin panel",
				capturedAt: 50,
				method: "GET",
				url: "https://demo.local/admin",
				status: 200,
			},
		],
		...overrides,
	};
}

describe("projectSecGraph", () => {
	test("projects the campaign root as the only node when there is no action", () => {
		const graph = projectSecGraph(input());

		expect(graph.nodes).toEqual([
			{
				id: "target:demo",
				key: "target:demo",
				type: "target",
				title: "https://demo.local",
				detail: { project: "demo", target: "https://demo.local" },
				severity: "info",
				is_rce: false,
				risk_score: SEC_SEVERITY_SCORE.info,
				tags: ["entry", "campaign"],
				status: "open",
				created_at: 1000,
				updated_at: 1000,
			},
		]);
		expect(graph.edges).toEqual([]);
		expect(graph.findings).toEqual([]);
		expect(graph.intents).toEqual([]);
		expect(graph.frontier).toEqual({ open: 0, strategies: 0, by_status: {} });
		expect(graph.rce_path).toEqual({ path: [], paths: [], likelihood: 0, frontier_mode: true });
		expect(graph.stats).toMatchObject({
			nodes: 1,
			services: 0,
			edges: 0,
			findings: 0,
			has_shell: false,
			frontier_open: 0,
			frontier_strategies: 0,
			lateral_active: false,
			pivot_edges: 0,
			hosts_footed: 0,
		});
	});

	test("names the root after the project when the target is blank", () => {
		const graph = projectSecGraph(input({ project: "  ", target: "  " }));
		expect(graph.nodes[0]?.key).toBe("target:campaign");
		expect(graph.nodes[0]?.title).toBe("");
	});

	test("infers node kinds from intent prefixes and links every action to its parent", () => {
		const graph = projectSecGraph(
			input({
				actions: [
					action({ conversationId: 2, intent: "service: 8080/http nginx", openedAt: 20 }),
					action({
						conversationId: 3,
						parentConversationId: 2,
						intent: "vuln: CVE-2024-1234 path traversal",
						openedAt: 30,
						status: "open",
						ownerTaskId: 12,
					}),
					action({ conversationId: 4, intent: "goal: shell on web01", openedAt: 40, status: "failed" }),
					action({ conversationId: 5, intent: "scan ports", openedAt: 10, status: "open", ownerTaskId: 14 }),
				],
			}),
		);

		const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
		expect([...byKey.keys()]).toEqual([
			rootTargetKey("demo"),
			actionNodeKey("info", 5),
			actionNodeKey("service", 2),
			actionNodeKey("vuln", 3),
			actionNodeKey("danger", 4),
		]);

		expect(byKey.get(actionNodeKey("info", 5))).toMatchObject({
			type: "info",
			title: "scan ports",
			severity: "info",
			risk_score: SEC_SEVERITY_SCORE.info,
		});
		expect(byKey.get(actionNodeKey("service", 2))).toMatchObject({
			type: "service",
			title: "8080/http nginx",
			severity: "info",
			status: "done",
			detail: { intent: "service: 8080/http nginx", ownerTaskId: 11, summaryRef: "", status: "done" },
		});
		expect(byKey.get(actionNodeKey("vuln", 3))).toMatchObject({
			type: "vuln",
			title: "CVE-2024-1234 path traversal",
			severity: "medium",
			risk_score: SEC_SEVERITY_SCORE.medium + 4,
		});
		expect(byKey.get(actionNodeKey("danger", 4))).toMatchObject({
			type: "danger",
			title: "shell on web01",
			severity: "medium",
			status: "failed",
		});
		expect(byKey.get(actionNodeKey("danger", 4))?.tags).toContain("goal-intent");

		const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
		expect(edges.get(`contains:target:demo->${actionNodeKey("service", 2)}`)).toMatchObject({
			relation: "CONTAINS",
			from: "target:demo",
			to: actionNodeKey("service", 2),
			weight: 1,
			on_rce_path: false,
		});
		expect(edges.get(`contains:${actionNodeKey("service", 2)}->${actionNodeKey("vuln", 3)}`)).toMatchObject({
			from: actionNodeKey("service", 2),
			to: actionNodeKey("vuln", 3),
			weight: 0.5,
		});
		expect(edges.get(`contains:target:demo->${actionNodeKey("danger", 4)}`)?.weight).toBe(0.25);
		expect(edges.size).toBe(4);

		const intents = new Map(graph.intents.map((intent) => [intent.id, intent]));
		expect(intents.get("intent:conv-5")).toEqual({
			id: "intent:conv-5",
			from: ["target:demo"],
			description: "scan ports",
			rationale: "conversation 5, task 14",
			est_success: 0.5,
			status: "open",
			strategy_key: "conv-5",
			priority: 1,
		});
		expect(intents.get("intent:conv-2")).toMatchObject({
			from: ["target:demo"],
			status: "verified",
			est_success: 1,
			priority: 0,
		});
		expect(intents.get("intent:conv-3")).toMatchObject({ from: [actionNodeKey("service", 2)], status: "open" });
		expect(intents.get("intent:conv-4")).toMatchObject({ status: "disproved", est_success: 0.05 });

		expect(graph.frontier).toEqual({ open: 2, strategies: 4, by_status: { open: 2, verified: 1, disproved: 1 } });
		expect(graph.stats).toMatchObject({
			nodes: 5,
			services: 1,
			edges: 4,
			findings: 0,
			has_shell: false,
			frontier_open: 2,
			frontier_strategies: 4,
		});
	});

	test("projects evidence subjects as findings with metadata only", () => {
		const graph = projectSecGraph(input({ evidence: [evidence()] }));

		const key = evidenceNodeKey("finding-1");
		const node = graph.nodes.find((candidate) => candidate.key === key);
		expect(node).toMatchObject({
			id: key,
			key,
			type: "vuln",
			title: "finding-1",
			severity: "info",
			risk_score: SEC_SEVERITY_SCORE.info + 4,
			status: "open",
			created_at: 50,
			updated_at: 1000,
		});
		expect(node?.tags).toEqual(["evidence", "unrated", "subject:finding-1", "role:proof"]);
		expect(node?.detail).toEqual({
			subjectId: "finding-1",
			version: 3,
			snapshots: [
				{
					snapshotId: "snap-1",
					role: "proof",
					note: "admin panel",
					method: "GET",
					url: "https://demo.local/admin",
					status: 200,
					capturedAt: 50,
				},
			],
		});

		expect(graph.findings).toEqual([
			{
				id: "finding-1",
				node_key: key,
				severity: "info",
				category: "evidence",
				title: "finding-1",
				description: "1 snapshot(s) bound at evidence version 3; severity is unrated until a proof is verified",
				evidence: "[proof] GET https://demo.local/admin -> 200 - admin panel",
				critical: false,
				created_at: 50,
				verification_status: "pending",
			},
		]);

		expect(graph.edges).toEqual([
			{
				id: `leads-to:target:demo->${key}`,
				from: "target:demo",
				to: key,
				relation: "LEADS_TO",
				weight: 0.3,
				rationale: "evidence subject finding-1 at version 3",
				on_rce_path: true,
			},
		]);
		expect(graph.stats).toMatchObject({ nodes: 2, edges: 1, findings: 1, low: 1, medium: 0, high: 0 });
	});

	test("maps a failed action intent to a disproved intent and open actions to the frontier", () => {
		const graph = projectSecGraph(
			input({
				actions: [
					action({ conversationId: 2, intent: "credential: admin:admin", status: "failed" }),
					action({ conversationId: 3, intent: "foothold: shell", status: "open" }),
				],
			}),
		);

		expect(graph.intents.map((intent) => intent.status)).toEqual(["disproved", "open"]);
		expect(graph.frontier).toEqual({ open: 1, strategies: 2, by_status: { disproved: 1, open: 1 } });
	});

	test("caps a honeypot's risk below its nominal severity", () => {
		const graph = projectSecGraph(input({ actions: [action({ intent: "honeypot: fake ssh" })] }));
		const node = graph.nodes.find((candidate) => candidate.type === "honeypot");
		expect(node).toMatchObject({ severity: "info", risk_score: 5, is_rce: false });
	});

	test("treats a foothold action as an RCE sink and marks the path", () => {
		const graph = projectSecGraph(
			input({ actions: [action({ intent: "foothold: shell on web01", status: "done" })] }),
		);

		const foothold = graph.nodes.find((candidate) => candidate.type === "foothold");
		expect(foothold).toMatchObject({ is_rce: false, severity: "medium", risk_score: 96 });

		expect(graph.rce_path.frontier_mode).toBe(false);
		expect(graph.rce_path.path).toEqual(["target:demo", foothold?.key]);
		expect(graph.rce_path.paths).toEqual([["target:demo", foothold?.key]]);
		expect(graph.rce_path.likelihood).toBe(1);
		expect(graph.edges.find((edge) => edge.to === foothold?.key)?.on_rce_path).toBe(true);
	});

	test("falls back to frontier mode when no sink exists yet", () => {
		const graph = projectSecGraph(
			input({
				actions: [
					action({ intent: "info: banner grab" }),
					action({ conversationId: 3, intent: "honeypot: decoy" }),
				],
			}),
		);

		expect(graph.rce_path).toEqual({ path: [], paths: [], likelihood: 0, frontier_mode: true });
		expect(graph.edges.every((edge) => !edge.on_rce_path)).toBe(true);
	});

	test("is deterministic for the same action tree and evidence version", () => {
		const source = input({ actions: [action(), action({ conversationId: 3, parentConversationId: 2 })] });
		expect(projectSecGraph(source)).toEqual(projectSecGraph(source));
	});

	test("clips an oversized intent title", () => {
		const intent = `info: ${"a".repeat(400)}`;
		const graph = projectSecGraph(input({ actions: [action({ intent })] }));
		const node = graph.nodes.find((candidate) => candidate.type === "info");
		expect(node?.title).toHaveLength(120);
		expect(node?.title.endsWith("…")).toBe(true);
	});
});
