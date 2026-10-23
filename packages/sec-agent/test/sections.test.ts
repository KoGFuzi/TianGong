import { describe, expect, it } from "vitest";
import {
	diffSections,
	renderSecSections,
	type SecPromptSections,
	secLanePromptSections,
	secLaneSections,
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

	it("keeps a fixed key set per lane: preamble, lane rules, tool surface, rubric — and lane-specific bodies", () => {
		const redteam = secLaneSections("redteam");
		const ctf = secLaneSections("ctf");
		const src = secLaneSections("src");
		expect(Object.keys(redteam)).toEqual(["preamble", "lane", "tools", "rubric"]);
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

	it("switching lanes patches the lane and tool-surface sections only", () => {
		const redteam = secLaneSections("redteam");
		const ctf = secLaneSections("ctf");
		const wrapped = (sections: SecPromptSections): Record<string, string> => {
			const out: Record<string, string> = {};
			for (const [key, content] of Object.entries(sections))
				out[key] = key === "preamble" ? content : `<${key}>\n${content}\n</${key}>`;
			return out;
		};
		const patch = diffSections(wrapped(redteam), wrapped(ctf));
		expect(Object.keys(patch ?? {}).sort()).toEqual(["lane", "tools"]);
	});

	it("exposes the map as gibraltar prompt sections: preamble untagged, the rest default-tagged", () => {
		const sections = secLanePromptSections("ctf");
		expect(sections.map((entry) => entry.key)).toEqual(["preamble", "lane", "tools", "rubric"]);
		expect(sections[0]?.tag).toBe(false);
		expect(sections[1]?.tag).toBeUndefined();
		expect(sections[2]?.tag).toBeUndefined();
		expect(sections[3]?.tag).toBeUndefined();
	});
});
