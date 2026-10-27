import { describe, expect, it } from "vitest";
import type { SecAgentLane } from "../src/bootstrap.ts";
import type { TgSecAgentRole } from "../src/role-policies.ts";
import {
	diffSections,
	renderSecSections,
	type SecPromptSections,
	secLanePromptSections,
	secLaneSections,
	secRoleSections,
} from "../src/sections.ts";

describe("sec sections", () => {
	it("renders in insertion order with the preamble unwrapped and every other key tag-wrapped", () => {
		const sections: SecPromptSections = {
			preamble: "first",
			lane: "second",
			tools: "third",
			rubric: "fourth",
		};
		expect(renderSecSections(sections)).toBe(
			["first", "<lane>\nsecond\n</lane>", "<tools>\nthird\n</tools>", "<rubric>\nfourth\n</rubric>"].join("\n\n"),
		);
	});

	it("keeps a fixed key set per lane: preamble, lane rules, plan, terminal, tool surface, rubric", () => {
		const redteam = secLaneSections("redteam");
		const ctf = secLaneSections("ctf");
		const src = secLaneSections("src");
		expect(Object.keys(redteam)).toEqual(["preamble", "lane", "plan", "terminal", "tools", "rubric"]);
		expect(Object.keys(ctf)).toEqual(Object.keys(redteam));
		expect(Object.keys(src)).toEqual(Object.keys(redteam));
		expect(redteam.preamble).toBe(ctf.preamble);
		expect(redteam.rubric).toBe(src.rubric);
		expect(redteam.lane).not.toBe(ctf.lane);
		expect(ctf.lane).toContain("豁免");
		expect(redteam.lane).not.toContain("豁免");
		expect(redteam.tools).not.toBe(ctf.tools);
		expect(redteam.tools).toContain("http_request");
		expect(redteam.tools).toContain("scope");
		expect(ctf.tools).toContain("getflag");
		expect(src.tools).toContain("PoC");
	});

	it("carries the four fixed rubric levels in one section", () => {
		const rubric = secLaneSections("src").rubric;
		for (const level of ["严重", "高", "中", "低"]) expect(rubric).toContain(level);
		expect(rubric).toContain("禁止跳级");
	});

	it("adds a role section for a child and narrows the tool surface by role", () => {
		for (const lane of ["redteam", "ctf", "src"] satisfies SecAgentLane[]) {
			const root = secLaneSections(lane);
			const redteam = secRoleSections("redteam", lane);
			expect(Object.keys(redteam)).toEqual(["preamble", "lane", "role", "tools", "rubric"]);
			expect(redteam.lane).toBe(root.lane);
			expect(redteam.tools).toBe(root.tools);
			expect(redteam.rubric).toBe(root.rubric);

			const binary = secRoleSections("binary", lane);
			expect(binary.tools).not.toBe(redteam.tools);
			expect(binary.tools).toContain("evidence_capture");
			expect(binary.tools).toContain("没有 http_request");
			expect(binary.tools).not.toContain("- http_request：");

			const reporting = secRoleSections("reporting", lane);
			expect(reporting.tools).toContain("traffic_query");
			expect(reporting.tools).not.toContain("- http_request：");
			expect(reporting.tools).not.toContain("evidence_capture");
		}
	});

	it("gives each role its own discipline body", () => {
		const bodies = new Set(
			(["redteam", "binary", "reporting"] satisfies TgSecAgentRole[]).map(
				(role) => secRoleSections(role, "redteam").role,
			),
		);
		expect(bodies.size).toBe(3);

		const reporting = secRoleSections("reporting", "src").role;
		expect(reporting).toContain("只读");
		expect(reporting).toContain("evidence 快照 id");
		expect(reporting).toContain("rubric");

		const binary = secRoleSections("binary", "redteam").role;
		expect(binary).toContain("codemode");
		expect(binary).toContain("evidence_capture");
	});

	it("carries the lane guardrail hints into children", () => {
		expect(secRoleSections("binary", "ctf").lane).toContain("hashcat");
		expect(secRoleSections("reporting", "ctf").lane).toContain("hashcat");
		expect(secRoleSections("redteam", "src").lane).toContain("业务变更护栏");
		expect(secRoleSections("redteam", "redteam").lane).not.toContain("业务变更护栏");
	});

	it("diffs into a patch: changed keys carry new text, dropped keys become null, unchanged keys stay out", () => {
		const current = secLaneSections("redteam");
		expect(diffSections({ ...current }, current)).toBeUndefined();

		const previous: Record<string, string | null> = {
			preamble: current.preamble,
			lane: "the old ctf lane text",
			rubric: current.rubric,
			stale: "gone in redteam",
		};
		const patch = diffSections(previous, current);
		expect(patch).toBeDefined();
		expect(patch?.lane).toBe(current.lane);
		expect(patch?.stale).toBeNull();
		expect("preamble" in (patch ?? {})).toBe(false);
		expect("rubric" in (patch ?? {})).toBe(false);
	});

	it("switching lanes patches the lane, terminal, and tool-surface sections only", () => {
		const redteam = secLaneSections("redteam");
		const ctf = secLaneSections("ctf");
		const wrapped = (sections: SecPromptSections): Record<string, string> => {
			const out: Record<string, string> = {};
			for (const [key, content] of Object.entries(sections))
				out[key] = key === "preamble" ? content : `<${key}>\n${content}\n</${key}>`;
			return out;
		};
		const patch = diffSections(wrapped(redteam), wrapped(ctf));
		expect(Object.keys(patch ?? {}).sort()).toEqual(["lane", "terminal", "tools"]);
	});

	it("exposes the map as gibraltar prompt sections: preamble untagged, the rest default-tagged", () => {
		const sections = secLanePromptSections("ctf");
		expect(sections.map((entry) => entry.key)).toEqual(["preamble", "lane", "plan", "terminal", "tools", "rubric"]);
		expect(sections[0]?.tag).toBe(false);
		expect(sections[1]?.tag).toBeUndefined();
		expect(sections[2]?.tag).toBeUndefined();
		expect(sections[3]?.tag).toBeUndefined();
		expect(sections[4]?.tag).toBeUndefined();
		expect(sections[5]?.tag).toBeUndefined();
	});
});
