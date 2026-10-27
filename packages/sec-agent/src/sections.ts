import type { Context } from "@OnePanda-TgSec/chord";
import type { PromptInput, PromptSection, ToolRegistration } from "@OnePanda-TgSec/tg-gibraltar";
import { section } from "@OnePanda-TgSec/tg-gibraltar";
import type { SecAgentLane } from "./bootstrap.ts";
import {
	TG_SEC_FINDING_SEVERITIES,
	TG_SEC_FINDING_SEVERITY_LABELS,
	type TgSecFindingSeverity,
} from "./finding-vocabulary.ts";
import type { TgSecAgentRole } from "./role-policies.ts";
import { TgSecTaskScopeDoc } from "./task-scope.ts";

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

/** What each rubric level means; keyed by the vocabulary's severity names, one entry per level. */
const RUBRIC_DETAIL: Record<TgSecFindingSeverity, string> = {
	critical: "可直接造成目标大规模数据泄露、资金损失或整体接管（如生产库可拖库、认证 RCE、支付越权可转账）。",
	high: "单个真实账户/关键数据/核心服务的实际影响已证明（如越权读取他人订单、修改生产配置导致中断）。",
	medium: "受限或间接的实际影响已证明（如低权限数据可见、需用户交互配合的窃取）。",
	low: "影响轻微或范围受限，但已超出纯信息收集。",
};

/**
 * The fixed four-level rubric (设计文档 §评级): take the highest level the proven impact fits; no
 * skipping. The names and their order come from `finding-vocabulary.ts`, so the prompt and the write
 * validation cannot drift apart.
 */
const RUBRIC = [
	`评级采用固定四级 rubric：${TG_SEC_FINDING_SEVERITIES.map((level) => TG_SEC_FINDING_SEVERITY_LABELS[level]).join(" / ")}。`,
	...TG_SEC_FINDING_SEVERITIES.map((level) => `- ${TG_SEC_FINDING_SEVERITY_LABELS[level]}：${RUBRIC_DETAIL[level]}`),
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
		"- 离线爆破与字典攻击（hashcat/john 等）只对 fixture 哈希使用；大词表输出是过程数据，只记录命中结果与最小证明链。",
	].join("\n"),
	src: [
		"赛道：安全众测/漏洞挖掘。目标是厂商公开的 in-scope 资产。",
		"- 只允许验证性利用（PoC 级别证明），禁止实际拖库、篡改或影响可用性。",
		"- 业务变更护栏：任何改变 in-scope 资产状态的写操作都先停下说明，不作为验证手段。",
		"- 每个确认漏洞按四级 rubric 定级并记录复现链；越权/资金类证明只证明可达，不落地。",
	].join("\n"),
};

/**
 * The forensic tool names the `sec-tools` extension registers. Each is `deferred`, so none is offered to
 * the model until `tool_search` names it — that flag, not a per-lane list, is what hides the surface. The
 * set is the single source behind both the tool-surface section and {@link secLaneToolFilter}.
 */
const SEC_FORENSIC_TOOLS = [
	"http_request",
	"evidence_capture",
	"traffic_query",
	"finding_update",
	"report_generate",
] as const;

/** The shared body of the tool-surface section; each lane appends its own discipline line. */
const TOOL_SURFACE_CORE = [
	"工具面：以下 sec 取证工具默认 deferred，不随初始请求 offered；经 tool_search 命中后才加载为可调用。",
	"- http_request：发起一次请求，自动把请求/响应抓成一对内容寻址证据 blob；带 findingId 时绑定到漏洞主体。响应体不回显进 transcript，只回快照 id 与字节数。",
	"- evidence_capture：把调用方已持有的字节体（bash 管道、文件、手工 PoC 输出）冻结为证据快照，可选绑定 findingId，受 expectedVersion 乐观锁保护。",
	"- traffic_query：按 findingId 列出已入账快照的元数据，或按 snapshotId 读取某一侧 body（base64，只回给调用程序，不进 transcript）。",
	"- finding_update：登记或推进漏洞结论；首次写入需 lane/title/severity 并以 open 起步，状态迁移受校验，retest-pass/retest-fail 必须附新绑定的证据 snapshotId。",
	"- report_generate：把已登记发现按严重度渲染为确定性报告文档；正文只含元数据与 snapshotId 清单，不含证据正文。",
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

/** The root's plan discipline (`docs/sec-agent-design.md` 子代理与行动树: 主 agent 持计划). */
const PLAN_RULE = [
	"计划：主 agent 持计划。用 plan_update 写入完整步骤清单；每次调用追加一个不可变修订，WebUI 以最新修订投影 intents。",
	"- 计划变化用新修订表达，不能只留在对话里；步骤状态 open/active/done/dropped 随执行更新。",
	"- 子会话只执行被委派的意图并回传摘要；计划与终局判断留在主 agent。",
].join("\n");

/** The terminal declaration each lane may make; the host validates it, the model does not self-certify. */
const LANE_TERMINAL: Record<SecAgentLane, string> = {
	redteam:
		"终局：redteam 的终局是 getshell。用 terminal_declare 声明时须给出已 verified 的高/严重 finding 及其绑定证据；宿主校验不成立时记为 unverified，不改变 finding 状态。",
	ctf: "终局：CTF 的终局是 getflag。用 terminal_declare 提交 flag；宿主对照提交记录校验，不成立时记为 unverified。",
	src: "终局：SRC 的终局是 high_critical_finding。用 terminal_declare 声明时须给出已 verified 的高/严重 finding；宿主校验不成立时记为 unverified，不改变 finding 状态。",
};

/**
 * The role-specific discipline each forked child carries (`docs/sec-agent-optimization.md` 批7c).
 * The lane keeps conditioning the rules; the role narrows what the child is for and what its
 * evidence discipline must look like. Body text stays minimal: only what changes behaviour.
 */
const ROLE_RULES: Record<TgSecAgentRole, string> = {
	redteam: [
		"角色：红队执行。你直接操作授权靶标，发请求、取证据、写验证脚本。",
		"- 先立假设再验证：每个结论都要有证据快照支撑，未抓证的判断只记为待验证假设。",
		"- 验证性利用止于证明；能证明即可停手，不扩大影响面。",
	].join("\n"),
	binary: [
		"角色：二进制分析。你在 codemode 沙箱内分析样本、还原协议、提取特征。",
		"- 不做网络请求；需要线上证据时用 evidence_capture 冻结本地产物或已持有的字节体。",
		"- 每个样本结论绑定其证据快照 id；样本哈希与提取物一同入账。",
	].join("\n"),
	reporting: [
		"角色：报告编写。你只读取证材料与流量元数据，不发起新请求、不写 workspace。",
		"- 取证纪律：结论必须回溯到 evidence 快照 id；没有快照的观察写明“待验证”，不得当作已证明。",
		"- 评级引用 rubric 固定四级，按已证明的最高影响定级；报告只消费元数据，不回显证据正文。",
	].join("\n"),
};

/** The binary role's surface: evidence capture and the sandbox, never a wire request. */
const BINARY_TOOLS = [
	"工具面：本角色只有取证与沙箱工具，默认 deferred，经 tool_search 命中后才加载为可调用。",
	"- evidence_capture：把样本、管道输出或手工 PoC 的字节体冻结为证据快照，可绑定 findingId；正文不回显进 transcript。",
	"- finding_update：登记样本分析结论并推进状态；复测必须附新证据快照。",
	"- codemode：在 QuickJS 沙箱内运行分析脚本，不落盘、不发网络请求。",
	"- 本角色没有 http_request / traffic_query；需要线上流量时交由父会话或红队子会话取证。",
].join("\n");

/** The reporting role's surface: read the evidence index, never touch the target. */
const REPORTING_TOOLS = [
	"工具面：本角色只有只读工具，默认 deferred 的经 tool_search 命中后才加载为可调用。",
	"- traffic_query：按 findingId 列出已入账快照的元数据，或按 snapshotId 读取某一侧 body（base64，只回给调用程序，不进 transcript）。",
	"- report_generate：把已登记发现按严重度生成确定性报告文档；正文不含证据正文与时间戳。",
	"- read：读取报告模板与本地只读材料；没有写、bash、codemode 与任何发包能力。",
	"- 取证纪律：每个结论都要能回溯到 evidence 快照 id；未抓证的观察只是待验证假设，不计入评级。",
].join("\n");

/**
 * The sec tool names a lane surfaces. Every lane surfaces the full forensic surface; the gate
 * that keeps them out of the model's initial offer is each tool's `deferred` flag, not this list. A host
 * narrows a lane by passing the complement through `configure`'s `modelTools.remove` (or `tools`). This is
 * the lane→surface contract the tool-surface section and the deferred-set assertion both key off.
 */
export function secLaneToolFilter(_lane: SecAgentLane): readonly string[] {
	return SEC_FORENSIC_TOOLS;
}

/** The root's section map, in render order: preamble, lane rules, plan, terminal, tool surface, rubric. */
export function secLaneSections(lane: SecAgentLane): SecPromptSections {
	return {
		preamble: PREAMBLE,
		lane: LANE_RULES[lane],
		plan: PLAN_RULE,
		terminal: LANE_TERMINAL[lane],
		tools: LANE_TOOLS[lane],
		rubric: RUBRIC,
	};
}

/**
 * A forked child's section map: the lane rules it inherits, its role's discipline and tool surface,
 * and the shared rubric. Key order is the render order; `role` sits between `lane` and `tools`.
 */
export function secRoleSections(role: TgSecAgentRole, lane: SecAgentLane): SecPromptSections {
	return {
		preamble: PREAMBLE,
		lane: LANE_RULES[lane],
		role: ROLE_RULES[role],
		tools: role === "redteam" ? LANE_TOOLS[lane] : role === "binary" ? BINARY_TOOLS : REPORTING_TOOLS,
		rubric: RUBRIC,
	};
}

/**
 * Sections that follow each conversation's `tg.sec.task-scope`: the root renders the host lane's
 * map; a forked child renders its role's map for the lane stored at fork. Gibraltar diffs the
 * rendered map against the transcript's shown sections, so a fork patches only what differs.
 *
 * The section objects are fixed for the extension, so the root simply renders no `role` section.
 * Every render reads the scope document through `input.read`, a committed read of this
 * conversation; a root has no scope document and therefore keeps the host map.
 */
export function secScopePromptSections(hostLane: SecAgentLane): readonly PromptSection[] {
	const keys = ["preamble", "lane", "plan", "role", "terminal", "tools", "rubric"] as const;
	const mapFor = async (input: PromptInput, context: Context): Promise<SecPromptSections> => {
		const scope = await input.read.snapshot(TgSecTaskScopeDoc, input.conversationId, context);
		return scope === undefined ? secLaneSections(hostLane) : secRoleSections(scope.role, scope.lane);
	};
	return keys.map((key) =>
		section(
			key,
			async (input: PromptInput, context: Context) => (await mapFor(input, context))[key],
			key === "preamble" ? { tag: false } : undefined,
		),
	);
}

/** The lane's section map as gibraltar prompt sections: `preamble` renders without a tag. */
export function secLanePromptSections(lane: SecAgentLane): readonly PromptSection[] {
	return secPromptSections(secLaneSections(lane));
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
