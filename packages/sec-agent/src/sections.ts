import type { PromptInput, PromptSection, ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { section } from "@OnePanda-TgSec/tg-gibraltar";
import type { SecAgentLane } from "./bootstrap.ts";

/**
 * Ordered section map, the same carrier the legacy prompt builder used
 * (`scripts/legacy/sec-agent/src/core/system-prompt.ts`): insertion order is render order,
 * `preamble` first and unwrapped, every other section wrapped as `<key>\n…\n</key>`.
 */
export type SecPromptSections = Record<string, string>;

/** Join a section map into the full system prompt text, in insertion order. */
export function renderSecSections(sections: SecPromptSections): string {
	const parts: string[] = [];
	for (const [key, content] of Object.entries(sections)) {
		parts.push(key === "preamble" ? content : `<${key}>\n${content}\n</${key}>`);
	}
	return parts.join("\n\n");
}

/**
 * Diff the sections a transcript currently carries against the desired ones; `null` removes a
 * section. Returns `undefined` when nothing changed — the patch is a diff, never a rebuild, so an
 * unchanged prompt costs the model no new tokens.
 */
export function diffSections(
	previous: Record<string, string | null>,
	current: SecPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [key, text] of Object.entries(current)) {
		if (previous[key] !== text) patch[key] = text;
	}
	for (const key of Object.keys(previous)) {
		if (current[key] === undefined) patch[key] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

/** The fixed four-level rubric (设计文档 §评级): take the highest level the proven impact fits; no skipping. */
const RUBRIC = [
	"评级采用固定四级 rubric：严重 / 高 / 中 / 低。",
	"- 严重：可直接造成目标大规模数据泄露、资金损失或整体接管（如生产库可拖库、认证 RCE、支付越权可转账）。",
	"- 高：单个真实账户/关键数据/核心服务的实际影响已证明（如越权读取他人订单、修改生产配置导致中断）。",
	"- 中：受限或间接的实际影响已证明（如低权限数据可见、需用户交互配合的窃取）。",
	"- 低：影响轻微或范围受限，但已超出纯信息收集。",
	"按**已证明**的最高影响定级，禁止跳级夸大；未验证的猜测只能作为待验证假设记录，不得计入评级。",
].join("\n");

const PREAMBLE = [
	"你是 TianGong 安全 agent，运行在 gibraltar harness 上，为专业安全人员服务。",
	"你在受审计的权限链下工作：每一次工具调用都经过 tg-sec-guard 判定；被拦截时如实向操作者说明原因，不尝试绕过。",
].join("\n");

/** The per-lane rule section bodies (`docs/sec-agent-design.md` 赛道预设); the tool面 and scope stay in the guard. */
const LANE_RULES: Record<SecAgentLane, string> = {
	redteam: [
		"赛道：红蓝对抗。目标是甲方指定的靶标资产，默认视为生产资产。",
		"- 一切写操作、持久化、业务变更都必须先确认在授权范围内，并预期被强制人工 ask。",
		"- 横向移动与凭据使用只针对授权清单内的目标主机；对无关主机连接会被 scope 拦截。",
	].join("\n"),
	ctf: [
		"赛道：夺旗赛。目标是出题方搭建的 fixture，不是真实用户资产。",
		"- 证明型破坏（读取 flag 链路所需的数据证明）可放行；对 fixture 的持久化仍需人工确认。",
		"- 业务变更护栏豁免：fixture 无真实业务；目标破坏类护栏不豁免，防止把 CTF 习惯带进实战。",
	].join("\n"),
	src: [
		"赛道：安全众测/漏洞挖掘。目标是厂商公开的 in-scope 资产。",
		"- 只允许验证性利用（PoC 级别证明），禁止实际拖库、篡改或影响可用性。",
		"- 每个确认漏洞按四级 rubric 定级并记录复现链；越权/资金类证明只证明可达，不落地。",
	].join("\n"),
};

/**
 * The forensic tool names the `sec-tools` extension registers. Each is `deferred`, so none is offered to
 * the model until `tool_search` names it — that flag, not a per-lane list, is what hides the surface. The
 * set is the single source behind both the tool-surface section and {@link secLaneToolFilter}.
 */
const SEC_FORENSIC_TOOLS = ["http_request", "evidence_capture", "traffic_query"] as const;

/** The shared body of the tool-surface section; each lane appends its own discipline line. */
const TOOL_SURFACE_CORE = [
	"工具面：以下 sec 取证工具默认 deferred，不随初始请求 offered；经 tool_search 命中后才加载为可调用。",
	"- http_request：发起一次请求，自动把请求/响应抓成一对内容寻址证据 blob；带 findingId 时绑定到漏洞主体。响应体不回显进 transcript，只回快照 id 与字节数。",
	"- evidence_capture：把调用方已持有的字节体（bash 管道、文件、手工 PoC 输出）冻结为证据快照，可选绑定 findingId，受 expectedVersion 乐观锁保护。",
	"- traffic_query：按 findingId 列出已入账快照的元数据，或按 snapshotId 读取某一侧 body（base64，只回给调用程序，不进 transcript）。",
	"- 取证纪律：每个结论都要能回溯到 evidence 快照 id；未抓证的观察只是待验证假设，不计入评级。",
];

/** The per-lane tool-surface section bodies (设计文档 工具面 + 赛道预设). */
const LANE_TOOLS: Record<SecAgentLane, string> = {
	redteam: [
		...TOOL_SURFACE_CORE,
		"- 红队：http_request 的目标 host 由 scope 强制判定，越界连接必被强制人工 ask，放行不等于在授权内；写类证据一律按生产变更对待。",
	].join("\n"),
	ctf: [
		...TOOL_SURFACE_CORE,
		"- CTF：证据面用于固化 getflag 取证链；爆破/大词表类流量不作为需入账的证据，只记录证明 flag 获取所需的最小请求。",
	].join("\n"),
	src: [
		...TOOL_SURFACE_CORE,
		"- 众测：http_request 只发验证性 PoC；证据快照用于证明可达，不落地实际拖库、篡改或影响可用性的数据。",
	].join("\n"),
};

/**
 * The sec tool names a lane surfaces. Every lane surfaces the full forensic triad in this batch; the gate
 * that keeps them out of the model's initial offer is each tool's `deferred` flag, not this list. A host
 * narrows a lane by passing the complement through `configure`'s `modelTools.remove` (or `tools`). This is
 * the lane→surface contract the tool-surface section and the deferred-set assertion both key off.
 */
export function secLaneToolFilter(_lane: SecAgentLane): readonly string[] {
	return SEC_FORENSIC_TOOLS;
}

/** The lane's section map, in render order: preamble, lane rules, tool surface, rubric. */
export function secLaneSections(lane: SecAgentLane): SecPromptSections {
	return {
		preamble: PREAMBLE,
		lane: LANE_RULES[lane],
		tools: LANE_TOOLS[lane],
		rubric: RUBRIC,
	};
}

/**
 * The section map as gibraltar prompt sections: `preamble` renders without a tag (legacy
 * convention), every other key keeps the default `<key>` wrap. A render reads the map at call
 * time, so a host that mutates the map between turns changes the next request, not history.
 */
export function secPromptSections<Tool extends ToolRegistration = ToolRegistration>(
	sections: SecPromptSections,
): readonly PromptSection<Tool>[] {
	const rendered: PromptSection<Tool>[] = [];
	for (const [key, content] of Object.entries(sections)) {
		const value = content;
		const render = (_input: PromptInput<Tool>) => value;
		rendered.push(key === "preamble" ? section<Tool>(key, render, { tag: false }) : section<Tool>(key, render));
	}
	return rendered;
}

/** Convenience: the lane's sections as `Extension["sections"]` content. */
export function secLanePromptSections(lane: SecAgentLane): readonly PromptSection[] {
	return secPromptSections(secLaneSections(lane));
}
