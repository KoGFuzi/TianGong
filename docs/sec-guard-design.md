# tg-sec-guard 权限模块工程文档

状态：设计定稿，待实施。实施侧 Fedora/qoderclicn。本文档与代码不一致时代码是错的——但实施前
必须先读真实签名核对本文档的 API 形状，发现出入以代码为准并回本文档勘误（房规：probe before
assert）。

## 背景与目标

sec-agent 的权限关注点在既有代码里散落各处：gibraltar 内**没有任何** approval/permission 机制
（唯一拦截点是 `ToolHooks.beforeTool` 的 `{ block }`，harness/types.ts:775-792，执行于
harness/tool.ts:142 与 :516）。旧 `tg-agent-core` 曾带一份 `permission.ts`（allow/deny/ask +
grant 缓存）但**全仓产品层零接线**（接线复盘 §5-4 实测：`permissionRules`/`onPermissionAsk`/
`permissionGrants` 除包内自用外零引用——权限层在旧 loop 侧本来就是死面）。2026-10-22 该包已删除，
快照留存 `scripts/legacy/agent-core/src/permission.ts`（连同 `test/permission.test.ts` 的可执行
语义）。用户定调：**收敛进独立 package，但既有件原地保留、不为统筹而统筹**——图纸只读不搬迁，
env 抽象留在 gibraltar，tg-sec-guard 只做编排、策略、证明、留痕四件事。

图纸的四条求值语义必须在 `scripts/legacy/agent-core/src/permission.ts` 就地可对照，本包按四级
模式重写求值器但**语义承接**：① first-match-wins（先声明优先，例外在前、通则在后）；② 无匹配
→ allow（fail-open）；③ 命中 ask 但无 ask 通道时 fail-closed（阻断而非放行）；④ `always`
授权按**精确 resource** 记录、不按规则 pattern 记录（防一次授权放大成模式级长期放行）——本包
的 grants 同样遵守，且危险集强制 ask **不受任何 grant 影响**。

应用场景：政务红蓝对抗、公安对抗赛。工具不开源、默认专业人士使用 ⇒ 默认宽松，危险指令强制
人工。

设计参照（只借鉴思路，**禁止复制源码**——ARTEX 与 StrikeAgent 均为 AGPL）：

- pi-1.3.0/packages/evals：信任边界收敛于单入口生命周期 + 分层隔离 + 探测式验证（降权后真读
  保护文件，读得动就 throw，evals/src/harness.ts:154-188）+ fail-closed
- StrikeAgent exec/guard.py：命令文本 scope 解析算法（连接目标与 payload 数据分离）
- ARTEX intercept：priority 降序首命中规则表、deny 优先于 allow

## 已定案决策（实施中不得翻案）

1. **独立包** `@OnePanda-TgSec/tg-sec-guard`，sec-agent 与将来的 sec-server sidecar 共用同一条
   策略链。
2. **四级权限模式**：
   | 模式 | 常规指令 | 危险指令集 |
   | --- | --- | --- |
   | `strict` | 每条 → 人工审批 | 同左（已全人工） |
   | `judge-auto` | judge 初审：allow 自动执行，判不下/可疑 → 人工 | 绕过 judge，直降人工 |
   | `auto` | 系统自动批准 | 降级人工 |
   | `yolo` | 模型自设计/自执行/自审批 | 降级人工 |
3. **危险指令集强制人工**：L2/L3/L4 命中危险集一律绕过本层判定直降人工；`always` 授权与模式
   等级**均不可豁免**。
4. **硬 deny 凌驾四级之上**：平台自保护（loopback/本机网卡/网关/docker 网桥）与本机自毁
   （`rm -rf /`、`mkfs`、`dd of=/dev`、fork bomb、shutdown）在任何模式直接拒绝，不进人工通道。
   批0.5a 实测边界：`node:os` 无可移植的默认网关查询 API，故本批硬 deny 覆盖 loopback
   （hostname + v4/v6）、本机网卡地址（`networkInterfaces()` 枚举）、docker 网桥；
   **默认网关判定顺延到批1**，由 scope 注册表承载（`hard-deny.ts:32-52`）。
5. **优先序**：硬 deny 高于 scope 外强制 ask（与危险集强制 ask 同级），两者都高于模式分派
   （strict/judge/auto/yolo），后者高于默认 allow。forced ask 都不接受 grants/模式豁免。
6. **judge 只是 `judge-auto` 的模式组件**，不是全局层；其余模式的判定路径全程确定性，零 LLM
   调用。
7. **TLD 黑名单机制保留、seed 清空**（公安演练靶标即政务域）；唯一许可来源是 scope 注册，
   deny 原语留作越界否决，deny 优先于 allow。
8. **L2/L3/L4 要求 ask 通道有人值守**：yolo ≠ 无人值守，危险指令会挂起会话等人工。
9. **模式作用域 = 会话级可热切换**（持久文档承载，切换动作落审计 span）；campaign 默认模式
   随 scope 注册指定。

## 非目标（明确不做）

- 不搬迁 `permission.ts`（包已删除，快照在 `scripts/legacy/agent-core/src/permission.ts`）：它是
  只读图纸，本包按四级模式重写求值器并承接上文四条语义。`scripts/legacy/**` 不参与编译、不受
  房规与格式检查管辖、**任何包不得 import**，只作对照阅读。
- 不做第三方 executable-tool API。
- 不做类型化 subagent 角色目录（会话级委派，见运行模型既定文档）。
- judge 不做多模型合议，不复读工具输出全文（只吃工具名+参数摘要，控制注入面）。
- 参数级 resource 不进入规则表语法：规则表维持 `tool:<name>` 粒度（宽松默认下的粗粒度兜底），
  参数级判定全部在危险集/scope 解析层完成。

## 包定位与边界

新包 `@OnePanda-TgSec/tg-sec-guard`。依赖方向（AGENTS.md 边界图同步；**边不由
`boundary.test.ts` 机械保证**——该测试只证 chord 是叶子，见文末房规清单）：

```text
gibraltar ──▶ sec-guard ◀── sec-agent（批3 建包后才真实存在；后续 sec-server 同边）
telemetry ──▶ sec-guard
ai ─────────▶ sec-guard
chord ──────▶ sec-guard
```

批0.5a 实测依赖：gibraltar（钩子/文档/工具类型）、telemetry（审计 span）、
**chord**（`src` 里 `import type { Context }`，不声明就是谎报依赖图）、
**tg-ai**（本批**已声明未使用**，批2 judge 落地才引用）。gibraltar **不反向依赖** sec-guard；
sec-guard 以 extension 形态被宿主 registry.install。vendored 两包（codemode/mcp）维持零边。

## 核心概念与 API 目标形状

以下为**目标形状**，实施前逐一与 gibraltar 真实类型核对。

### 模式状态

```ts
export type TgSecPermissionMode = "strict" | "judge-auto" | "auto" | "yolo";
```

- 会话级持久文档 `tg.sec.mode`（用 gibraltar `defineDoc` 的 **session 作用域**重载，
  documents.ts:39）。批0.5a 勘误：原文的 "rewindable" 是 conversation 文档概念，session 作用域
  文档不涉 rewind，措辞作废。
- 热切换 = 写文档 + 落审计 span **`tg.span.sec.mode`**（含 from/to/操作者）。批0.5a 勘误：原
  命名 `mode_switch` 违反 telemetry 自身的命名不变量 `packages/telemetry/test/spans.test.ts:4`
  （`/^tg\.span\.[a-z][a-z0-9.]*$/`，不接受下划线），且现有词表一律是 `tg.span.<layer>.<event>`
  两段式（`provider.acquire`、`agent.turn`）——按代码现实收敛为 `tg.span.sec.mode`。
- campaign 默认值来自 scope 注册（操作者侧 `.tiangong/` 配置，不做仓库可控文件）。

### 决策与求值

```ts
export type TgSecDecision =
	| { effect: "allow" }
	| { effect: "deny"; reason: string; hard: boolean }
	| { effect: "ask"; reason: string; forced: boolean };

export type TgSecGuard = {
	// 组装为 gibraltar ToolHooks.beforeTool；ask 由宿主 UI 通道兑现，guard 只发决策与等待
	beforeTool: /* ToolHooks["beforeTool"] 形状 */;
	attest(ctx: TgSecAttestContext): Promise<void>; // fail-closed：任一探针失败即 throw
	switchMode(mode: TgSecPermissionMode, actor: string): Promise<void>;
};
```

求值顺序（短路）：

0. **入口硬约束**：每个 tool call 必进本链——包括 resume/崩溃恢复态、无 placement、无关联
   assistant 消息的调用（接线复盘 P1-5 的教训：桥接层当时"未命中即 return undefined"，让恢复态
   调用绕过权限与 block 钩子）。gibraltar 原生 `beforeTool` 每 call 必问，本包不得在任何分支
   提前 return 跳过。**已核实（批0.5a）**：`harness/tool.ts` 的 beforeTool 循环把钩子抛错转成
   `block`（catch → `block = errorMessage(error)`，非 abort 信号路径），因此模式文档读到非法值
   时抛错即 fail-closed，不构成旁路——本包的 attestation 探针 5 依赖这一事实。
1. **硬 deny** → `deny, hard: true`（无 ask 通道，模型看到的就是 block 错误）。硬 deny 先于
   scope 判定：scope 内目标也不允许触发平台自保护/本机自毁。
2. **scope 判定**（bash/网络类工具，见下节解析器）：目标主机不在 scope 注册表 →
   `ask, forced: true`（scope 是唯一许可来源，与危险集同级，不受 grants/模式豁免）；在表内 →
   继续。
3. **危险集命中** → `ask, forced: true`（不接受 always 豁免；grants 查询跳过此项）。
4. **模式分派**：`strict` → ask；`judge-auto` → judge；**grants 查询只发生在 `auto`/`yolo` 分支
   内部**（命中 → allow）→ allow。批0.5a 曾把 grants 放成模式分派前的全局前置，导致 strict 下
   一次 `always` 就把 L1 降成 L3——已定为缺陷并修正：**strict 与 judge-auto 永久无视 grants**
   （依据是四级定义本身，不是实现便利）。
5. judge（仅 judge-auto）：输入 = 工具名 + 参数摘要 + 当前 scope 上下文；输出严格 JSON
   `{decision: "allow"|"ask", comment}`；解析失败/超时/判不下 → **ask**（judge 无 deny 权，
   deny 只能来自硬 deny 与规则表）。两轴提示（可逆性×作用对象）借鉴 ARTEX
   intercept/prompt.go 的思路重写，不复制其 prompt 文本。
6. 每次判定（含放行）落 `tg.span.sec.guard`：mode、命中层、decision、reason、参数摘要哈希。
   批0.5a 实现收敛（已核实为正确取舍，取代原文）：span 属性一律低基数封闭枚举——
   `mode` / `layer`(`hard-deny|scope|danger|grants|mode`) / `effect` / `forced` /
   `rule`（硬 deny 规则名枚举），参数只记 `argsDigest`（单向摘要、`sensitive: true`）。
   **`decision.reason` 是自由文本，不进 span**——否则命令原文会泄进遥测。审计所需的人读文本
   走 durable 记录与 ask 通道，不走 span。

### 危险集（参数级，命令文本解析）

两类，命中即强制 ask：

- **目标破坏类**（全赛道生效，CTF 不豁免）：`DROP/TRUNCATE/DELETE FROM/ALTER ... DROP`、
  `LOAD DATA INFILE`、`INTO OUTFILE/DUMPFILE`、sqlmap `--os-shell/--os-cmd/--file-write`、
  URL 参数 `action=delete` 类、Redis `FLUSHALL/FLUSHDB`、Mongo `dropDatabase`。
- **持久化类**：crontab 写入、useradd/adduser、authorized_keys 追加、schtasks、
  systemd unit 落盘。

行为规格参照 StrikeAgent guard.py `_TARGET_DESTRUCTIVE`（L162-182）与业务变更护栏，**按行为
重写正则，不复制其模式串清单文本**。

### scope 命令解析器（TS 重写 guard.py 算法）

bash 类工具调用过 scope 判定前的主机抽取，行为规格：

- **值是数据、不参与主机解析**的 flag：`-d --data --data-raw --data-binary --data-ascii
  --data-urlencode --form-string -F --form -H --header -b --cookie --cookie-jar -A
  --user-agent -e --referer --json --url-query --mail-from --mail-rcpt --aws-sigv4
  --oauth2-bearer -x --proxy --socks5 --socks5-hostname -o -D -L -R`。
- **值是连接目标**的 flag：`-u --url --host`（ffuf/sqlmap 的 -u；curl 的 -u user:pass 无主机，
  天然不误报）。
- **包装器跳过**：`env sudo nohup stdbuf nice setsid time proxychains proxychains4 sshpass`，
  `timeout <dur>` 跳两个 token，行首 `VAR=val` 赋值跳过。
- **递归**：`sh -c '...'` 子命令值递归解析（depth < 2）；解释器（python/ruby/node/perl/php）
  的 `-c/-e/-r` 是脚本体**整体跳过**，只扫其中回环 URL。
- URL 只取 authority（SSRF/重定向 payload 不误伤）；裸 IP/域名须整 token 匹配，域名须真实
  TLD 且非文件扩展名。
- 抽取结果与 scope 注册表比对：未注册主机 → 按当前模式分派（strict/ask，auto/yolo 下 scope
  外目标同样降级 ask——**scope 是唯一许可来源**，这条不受宽松默认影响）。

### 拦截规则表

- DB 行式可编辑（SQLite，随 campaign project 隔离），字段：`priority, pattern(tool:<name>
  粒度), effect(allow|deny|ask), enabled`。
- priority 降序首命中；**deny 优先于 allow** 的全局语义由求值顺序保证（硬 deny 与规则 deny
  先于 allow 短路）。
- 默认规则集为空 = 宽松姿态；规则由操作者按战役写入，不随仓库分发。

### attestation（探测式边界证明，fail-closed）

三个触发点：harness open、会话 resume、fork 子会话创建。探针集（每条策略落地时必须自带对应
探针）：

1. 读一个应被拒的路径，断言 EACCES（受限 ExecutionEnv 生效）。
2. 构造 scope 外目标的假 beforeTool 调用，断言决策非 allow。
3. 构造危险集命中样本，断言 `ask, forced: true` 且 grants 豁免不生效。
4. 核验实际注册工具集 == 赛道预设声明集（对齐 evals 的扩展对账）。
5. 核验模式文档可读且值为四模式之一。
6. 构造**无 placement / 恢复态**的工具调用样本，断言仍进链（复盘 P1-5 回归：不得出现
   "未命中即 return undefined"式的旁路）。
7. 断言 ask 通道缺失时 forced ask 表现为 fail-closed 阻断（图纸语义③），而不是放行。

任一失败 → `attest` throw，宿主拒绝开工。探针即回归测试，先进 `test/` 先红后绿。

### 边界装配（宿主侧配合项，文档约束而非本包代码）

- `HarnessOptions.env` 注入受限 ExecutionEnv：文件操作圈定 workspace。
- bash 类工具子进程 env 擦洗成显式白名单；API key 只存 tg-ai credential store，**永不进工具
  进程环境**（对齐 evals InMemoryCredentialStore 模式）。
- 本地执行降权到专用低权用户；远程目标操作走 tg-env SSH 通道。

## 测试与验收

- 全部用 faux provider，不花真 token；judge 测试用 stub judge 函数注入。
- 验收 = attestation 探针全绿 + 模式矩阵测试（4 模式 × {常规, 危险集, 硬 deny, scope 外} 共
  16 格，逐格断言决策）+ scope 解析器对照用例（guard.py 行为规格的 ≥20 条样本，含误报回归：
  curl `-u user:pass`、`-d` 内嵌 URL、`sh -c` 嵌套、proxychains 包装）。
- `bun run check` + `bun run test packages/sec-guard` 全绿。

## 批次落点

**前置（批0，见 sec-agent-design.md）**：`packages/agent` 与旧 `packages/sec-agent` 的删除、
`scripts/legacy/` 留存、AGENTS.md 边界图与工具链排除必须先提交成干净 baseline，本包批次才开工
——当前 Fedora 工作树这些改动均未提交。

- **批0.5**（本批即本包骨架）：package 落地、边界图更新、`tg.sec.mode` 文档、四级模式机、
  attestation 框架 + 探针 1/4/5/7、审计 span。
- **批1**：scope 命令解析器 + scope 注册判定 + 探针 2/6。
- **批2**：拦截规则表 + 危险集 + judge（judge-auto 组件）+ 探针 3 + 16 格模式矩阵。

## 房规遵从清单

- 包名 `@OnePanda-TgSec/tg-sec-guard`；导出类型 `TgSec*`；持久 kind `tg.sec.*`；span
  `tg.span.sec.*`；env var `TG_SEC_*`。
- erasable TS（无 enum/namespace/parameter properties）；相对导入带 `.ts` 扩展名；tabs
  width 3；biome 格式化。
- 新包进 AGENTS.md 边界图（`gibraltar ──▶ sec-guard`、`telemetry ──▶ sec-guard`、
  `sec-guard ──▶ sec-agent`）、根 package.json 构建序；`bun install` 重生成 bun.lock。
  **依赖边要落成真断言**：`check:house-standard` 不校验依赖边、`boundary.test.ts` 只证明 chord
  是叶子（接线复盘 P3-5 实测），新边需自行补逐包 package.json/tsconfig paths 的断言，并在
  `packages/sec-guard/tsconfig.build.json` 显式写 paths。
- CHANGELOG.md 从 `## [Unreleased]` 起步。
- commit 信息格式：`feat(sec-guard): ...`——注意房规 scope 列表当前无 sec-guard/sec-server，
  落地时同步扩 AGENTS.md 的格式说明。
- v1 freeze：本包全生命周期在开发分支，不进 v1。
