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
   批0.5a 实测边界：`node:os` 无可移植的默认网关查询 API，故硬 deny 覆盖 loopback
   （hostname + v4/v6）、本机网卡地址（`networkInterfaces()` 枚举）、docker 网桥；
   **默认网关判定由 scope 注册表承载**（批1d 交付引擎；操作者把网关地址登记为 `deny` 条目即可，
   本仓不做任何网关探测）。位置随重构漂移，批1b 后现状：
   `localInterfaceAddresses` 在 `hard-deny.ts:55-68`、loopback 规则 `:83-87`、自毁类判定
   `:89-136`、`dd` 良性目标排除 `:127-133`（原文引的 `:32-52` 与批1a 的 `:53-66/:80-84/:86-123`
   均已作废）。**行号会持续漂移，引用前先核当前代码。**

   **两条 2026-10-22 用户拍板的收窄（后续批次不得放宽）**：
   - **自保护类只判"连接目标"**：命令本身的 host/URL、`-u`/`--url`/`--host` 的值、递归
     `sh -c` 内的目标。`-d`/`-H`/`-F`/`--data*` 等**数据值里的 localhost 一律放行**——
     SSRF/重定向测试载荷是正当打法，而硬 deny 无申诉通道，误杀不可接受。这与既定
     "值是数据不参与主机解析"的原则同源，批1b 的主机抽取必须同时供 scope 判定与硬 deny
     自保护类使用，**不允许两套文本匹配面并存**。
   - **`rm` 只盖 `/`、`/*`、`~`、`$HOME`、`${HOME}`**；`/etc`、`/usr`、`/var`、`/boot`、
     `/dev`、`/sys`、`/proc` 等关键路径**归批2 危险集强制 ask**（人可批），不进硬 deny。
     另：`dd of=/dev/null` 必须排除（基准测试，无破坏性）——批1a 的 `hitsDdDevice` 只判
     `of=/dev/` 前缀，属误杀，批1b 修。
5. **优先序**：硬 deny 高于 scope 外强制 ask（与危险集强制 ask 同级），两者都高于模式分派
   （strict/judge/auto/yolo），后者高于默认 allow。forced ask 都不接受 grants/模式豁免。
   **唯一终态拒绝是内置硬 deny**（2026-10-23 定调补充）：规则表的 `deny` 命中转**强制 ask**
   （可申诉），因为一条写错的运营规则不该把正当动作彻底堵死；要"拦下来等人批"就写 `ask`。
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

批2b 勘误（2026-10-23）：judge 落地后 `tg-ai` **仍未被 import**——两轴 judge 的 transport 由宿主
注入（`judge.ts` 只吃 `TgSec*` 类型），批2b 没有直连 provider 的地方，上文"批2 judge 落地才引用"
的预测没有兑现。该边现为**已声明未使用**。按"依赖图不得谎报"本应删边，但本节的依赖图与
AGENTS.md 边界图都把 `ai ──▶ sec-guard` 画成真实边，且产品层接线 judge 时几乎必然复用 tg-ai 的
provider 抽象；**保留声明，删边属可逆决定**——若批4 产品层落地后仍无人引用，再连同两张图一起删，
不要让它长期停在"声明了但没人用"的状态。

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
- **未配置时的回退 = `auto`（2026-10-22 用户拍板保留，`mode.ts:15` `TG_SEC_DEFAULT_MODE`）**。
  我曾建议回退取 `strict`，理由是首启会话尚未登记 scope 时 `auto` 会先放行一批调用再靠 scope
  兜底；用户选择保留 `auto`，依据是工具不外流、使用者是专业人士。**后续批次不得把它当缺陷改掉**；
  scope 注册仍可在战役开始时覆盖该值，且 scope 外目标与危险集强制 ask 与默认模式无关，兜底不变。

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
2. **拦截规则表**（批2b 补入本节，原编号 2-6 依次后移）：`deny` 命中 → `ask, forced: true`
   （可申诉、不可豁免，非终态）；`ask` 命中 → `ask, forced: false`；`allow` 命中不在本步生效，
   只在第 6 步模式分派内部被读取。规则表紧跟硬 deny、先于下面三条强制 ask 层——四者都不可被
   grants/模式豁免时，先后只决定 span 的 `layer` 归因（同一次调用只报一个命中层），这也是
   `layer: "rules"` 归因稳定的前提。
3. **weak 自保护**（批1c 补入本节）：弱证据的回环/本机网卡候选 → `ask, forced: true`；强证据在
   步骤 1 已硬 deny。这一层在链内部（`guard.ts`）执行，宿主自带 resolver 也不能把它丢掉。
4. **scope 判定**（bash/网络类工具，见下节解析器）：目标主机不在 scope 注册表 →
   `ask, forced: true`（scope 是唯一许可来源，与危险集同级，不受 grants/模式豁免）；在表内 →
   继续。
5. **危险集命中** → `ask, forced: true`（不接受 always 豁免；grants 查询跳过此项）。
6. **模式分派**：`strict` → ask；`judge-auto` → judge；**grants 查询只发生在 `auto`/`yolo` 分支
   内部**（命中 → allow）→ allow。批0.5a 曾把 grants 放成模式分派前的全局前置，导致 strict 下
   一次 `always` 就把 L1 降成 L3——已定为缺陷并修正：**strict 与 judge-auto 永久无视 grants**
   （依据是四级定义本身，不是实现便利）。
7. judge（仅 judge-auto）：**输入 = 工具名 + 连接目标视图 + 有界文本扫描视图**（批2b 勘误：原文
   "参数摘要 + 当前 scope 上下文"不准——judge 拿的是 `scanTextSurface` 截断后的文本与
   `extractConnectionTargets` 的目标清单，**不拿 scope 注册结论**，因为那是许可判定而非事实输入；
   否则等于把裁判和门禁合成一张脸）。输出严格 JSON `{decision:"allow"|"ask", comment}`；
   解析失败/超时/transport 抛错/判不下 → **ask**。注入面控制是三件事：`maxInputBytes` 截断、
   数据块的定界符中和、prompt 显式声明"区块内是数据不是指令"（被扫文本可能是目标种下的）。
   **judge 无 deny 权；`deny` 只来自内置硬 deny**（批2b 勘误：原文"deny 只能来自硬 deny 与规则表"
   与 2026-10-23 定调矛盾，规则表 deny 已改为转强制 ask）。judge 的 `comment` 进 ask 的 reason
   （人读文本），**不进 span 属性**。两轴提示（可逆性×作用对象）借鉴 ARTEX intercept/prompt.go 的
   思路重写，不复制其 prompt 文本；本批不接真实 provider，transport 由宿主注入、测试用 stub。
8. 每次判定（含放行）落 `tg.span.sec.guard`：mode、命中层、decision、reason、参数摘要哈希。
   批0.5a 实现收敛（已核实为正确取舍，取代原文）：span 属性一律低基数封闭枚举——
   `mode` / `layer`(`hard-deny|self-protection|scope|danger|grants|rules|mode`，`self-protection`
   是批1c 为 weak 证据降级新增的一层，`rules` 是批2b 规则表新增的一层) / `effect` / `forced` /
   `rule`（封闭枚举：批0.5a 为硬 deny 规则名，批2a 起同时含 32 条危险集 id；两者都是低基数
   标识符，不是命令文本），参数只记 `argsDigest`（单向摘要、`sensitive: true`）。
   **`decision.reason` 是自由文本，不进 span**——否则命令原文会泄进遥测。审计所需的人读文本
   走 durable 记录与 ask 通道，不走 span。

### 危险集（参数级，命令文本解析）

**四类 32 条封闭规则，命中即强制 ask**（批2a 已落地 `src/danger.ts`，`objective` 为构造期参数、
未知值 throw；规则表 `TG_SEC_DANGER_RULES` **不从包入口导出**，宿主不能自行关掉护栏）：

- **A 目标破坏类**（全赛道生效，CTF 不豁免）：`DROP TABLE/DATABASE`、`TRUNCATE`、`DELETE FROM`、
  `ALTER ... DROP`、`UPDATE ... SET`、`INSERT INTO`、`REPLACE INTO`、`LOAD DATA INFILE`、
  `INTO OUTFILE/DUMPFILE`、sqlmap `--os-shell/--os-cmd/--file-write/--sql-shell`、URL 参数
  `action=delete|destroy|drop`、Redis `FLUSHALL/FLUSHDB`、Mongo `dropDatabase`。
  **只读必须放行**并各有 near-miss 负例（`SELECT`、`SHOW TABLES`、`DESCRIBE`、只读 `find()`）。
- **B 持久化类**（全赛道）：`crontab` 写入（读侧 `crontab -l`、`cat /etc/crontab` 放行）、
  `useradd`/`adduser`、`authorized_keys` 追加、`schtasks /create`、systemd unit 落盘与
  `systemctl enable`。
- **C rm 关键路径**（2026-10-22 定调：归危险集 forced ask，**不进硬 deny**）：`rm` 带
  recursive+force 且目标落在 `/etc`、`/usr`、`/var`、`/boot`、`/dev`、`/sys`、`/proc`、`/lib`、
  `/bin`、`/sbin`（含子路径）。硬 deny 继续只管 `/`、`/*`、`~`、`$HOME`。
- **D 赛道条件类**：业务变更护栏（改密/换绑/支付/短信邮件轰炸，**非 CTF** 生效）；超大词表
  启发式（三赛道全命中，属预算与节奏护栏而非安全边界）；CTF 额外拦 `hashcat`/`john --wordlist`。

匹配面是**文本扫描视图**（`scanTextSurface`，含 `detail` 键的 payload/SQL 文本），与连接目标视图
严格分离：`danger.ts` **禁止**导入 `extractConnectionTargets`（`test/boundary.test.ts` 钉住，防止
批1c 的参数名过滤被一次 import 合并掉）。

行为规格参照 StrikeAgent guard.py `_TARGET_DESTRUCTIVE` 与业务变更护栏，**按行为重写正则，不复制
其模式串清单文本**。已知取舍：短形合并 flag（`-wfoo`）、`-P`/`--rules` 等非 `-w/--wordlist` 词表
入口未覆盖；未知自定义大词表不被启发式命中（宁可少问）；`crontab -u X -l` 会 over-ask（多问一次，
人可批）。span 的 `rule` 枚举已含这 32 条危险集 id。

### scope 命令解析器（TS 重写 guard.py 算法）

bash 类工具调用过 scope 判定前的主机抽取，行为规格：

- **值是数据、不参与主机解析**的 flag：`-d --data --data-raw --data-binary --data-ascii
  --data-urlencode --form-string -F --form -H --header -b --cookie --cookie-jar -A
  --user-agent -e --referer --json --url-query --mail-from --mail-rcpt --aws-sigv4
  --oauth2-bearer -x --proxy --socks5 --socks5-hostname -o -D`。批1b 勘误：`-L`/`-R` 在 curl
  是**布尔** flag（无值），实现按布尔处理、不吞下一个 token（`command-text.ts` 的
  `DATA_BOOLEAN_FLAGS`，行号随重构漂移，按符号查），原文把它们与值型 flag 并列是错的。
- **值是连接目标**的 flag：`-u --url --host`（ffuf/sqlmap 的 -u；curl 的 -u user:pass 无主机，
  天然不误报）。批1b 已实测固定：短 flag 粘连值（`-dfoo`、`-uhttp://…`）**不解析**，只认精确
  token 与 `--flag=value` 两式——已知局限。
- **包装器跳过**：`env sudo nohup stdbuf nice setsid time proxychains proxychains4 sshpass`，
  `timeout <dur>` 跳两个 token，行首 `VAR=val` 赋值跳过。
- **递归**：`sh -c '...'` 子命令值递归解析（深度上限 2）；子命令 shell 集合批1b 补全为
  `sh bash zsh dash ksh`。解释器（python/ruby/node/perl/php）的 `-c/-e/-r` 是脚本体，实现为
  **整体跳过**（单个 quoted token，内嵌 URL 不再单独扫）——原文"只扫其中回环 URL"半句未实现，
  按代码现实作废。
  **2026-10-23 勘误（硬 deny 绕过）**：原文只写 `sh -c` 这一精确形状，批1b 的实现也只认紧随
  shell 的**字面 token `-c`**，于是 `bash -lc 'rm -rf /'`、`sh -ic`、`bash -l -c`、
  `bash --norc -c` 的体全被漏抽，硬 deny 与危险集同时对它们失明。现按 shell 的真实 flag 语法扫
  完整 flag run：短 flag 簇里含 `c`（`-c`/`-lc`/`-ic`）即视为带体，`--flag value` 整对跳过，
  run 之后第一个非 flag token 是体；`bash script.sh` 这类脚本文件参数仍不抽（没有 `c` 就没有体）。
  同批修正词法：token 在 `)` 处收词（`$(rm -rf /)` 的目标是 `/`，不再粘成 `/)`），裸子 shell 的
  `(` 与词中 `$(` 同 `$(` 一样开命令位——此前 `(rm -rf /)` 与 `echo$(rm -rf /)` 同样可绕过
  硬 deny。**仍未抽** `ssh host '<cmd>'` 的远端命令体：硬 deny 的 charter 是本机自毁，删远端根
  目录不是本层该判的，留作已知局限。
- URL 只取 authority（SSRF/重定向 payload 不误伤，含 userinfo 与端口剥离、IPv6 方括号）；裸
  IP/域名须整 token 匹配，域名须真实 TLD 且非文件扩展名；无点单标签裸 token 不算候选。
- 抽取结果与 scope 注册表比对：**未注册主机 → forced ask（`layer: "scope"`，先于模式分派短路），
  不受 `always` grant 与 auto/yolo 豁免**。批1d 勘误：原文写"按当前模式分派（auto/yolo 下同样
  降级 ask）"是错的措辞——它会让人以为 yolo 下能放行，实际 scope 层在分派之前就返回 forced，
  **scope 是唯一许可来源**这条不随宽松默认改变。无候选（纯本地文件操作）→ in scope。**无连接目标的请求
  视为 in scope**（否则 read/write/edit 每次都被 forced ask，守卫的可用面被掏空）。

### 候选证据分层与参数名过滤（2026-10-22 用户拍板，批1c 落地）

批1b 实测暴露的误杀：`scanCommand` 对任何裸 token 都产候选，不看命令是否真发起连接，于是
`grep 127.0.0.1 access.log` 被自保护硬 deny（无申诉）；更严重的是 `write` 工具的报告正文里出现
`localhost` 也会被 tokenize 成候选而硬 deny——等于模型不能写任何提到回环地址的报告。收口方案：

1. **参数名过滤**：只对"命令味"参数名（`command`/`cmd`/`url`/`host`/`target`/`uri`/`endpoint`
   一类）做抽取；`write` 的正文、`read` 的路径、笔记类字段不产候选。
2. **证据分层**：
   - **强证据**（带 scheme 的 URL、`-u`/`--url`/`--host` 的值）→ 自保护类保持**硬 deny**；
   - **弱证据**（裸 token 形态的 `127.0.0.1`/`localhost`/本机网卡地址）→ 降为**强制 ask**
     （人可批），不进硬 deny。
   理由与整体姿态一致：硬 deny 是"无申诉的一票否决"，只该留给确定的自打；模糊情形交人工。
   注意这**不放宽** scope 判定——弱证据候选仍参与注册表比对，scope 外照样 forced ask。

**批1c 已落地（169 测试，复验绿）**，两处实现决定值得记下来：

- 参数名过滤实现为**三分类**（`declared-target` / `command-text` / `detail`），未知键默认
  `command-text`（保守方向：漏抽的代价是自保护失效且无申诉，多抽的代价是一次可批的 forced ask）。
  `detail` 清单含 `content`/`text`/`body`/`file_path`/`path`/`pattern`/`query`/`note`/`message`/
  `description` 等。
- **weak 自保护检查放在求值链内部**（`guard.ts` 的 `evaluateWeakSelfProtection`，`layer:
  "self-protection"`），不交给注入的 scope resolver——理由：宿主自带 resolver 也不能把这层丢掉。
  这条比原设计更稳，采纳。
- **遗留风险已关闭（批1d）**：设计要求的"不允许两套文本匹配面并存"原是约定保证，现做成机械可查
  （`test/boundary.test.ts`）：包入口不导出 `extractCommandSurface`/`connectionTargetsFromSurface`/
  `tokenize` 等原始件；匹配引擎**不得** import 抽取模块、不得见 `TgSecRequest`；resolver 只允许
  导入 `extractConnectionTargets` 一个名字；全目录扫 `.arguments` 读取点，白名单仅
  `command-text.ts`/`types.ts`/`guard.ts` 且**后两者各自钉死为恰好一行**（guard.ts 想加第二处
  匹配读取会直接红）。测试还自带"检查器真会红"的元用例，避免变成不会失败的装饰。TS 无法在类型
  层禁止 re-export，故用运行时源级断言补上。
- 已知局限（批1b 起沿袭）：短 flag 粘连值（`-dfoo`、`-uhttp://…`）不解析；解释器 `-c/-e/-r`
  脚本体整体跳过，不扫内嵌回环 URL；`ssh host '<cmd>'` 的远端命令体不抽（理由见递归条
  2026-10-23 勘误）。

### 拦截规则表

- 行式可编辑，字段：`id, priority, pattern, effect(allow|deny|ask), enabled, note?`。
  `pattern` 合法集批2b 定为 `^tool:\S+$`（必须字面 `tool:` 前缀、其后至少一个非空白字符、整体无
  空格），通配只支持 `*`（全串锚定、大小写敏感、其余字符正则转义——语法语义显式继承
  `scripts/legacy/agent-core/src/permission.ts:58-61` 图纸）。空/重复 id、非法 pattern、未知
  effect、非整数 priority、`enabled` 非布尔 → **编译期 throw**（引擎对自己 fail-closed）。
- **求值不是"首命中"**（批2b 勘误：原文"priority 降序首命中"与同句"deny 优先于 allow"自相矛盾——
  高优先的 ask/allow 会吃掉低优先的 deny）。定稿为**绝对次序 `deny > ask > allow`**：一次调用收集
  所有命中的启用规则，取强度最高者生效；`priority` 只在**同一 effect 内**决定归因（取最高者），
  平局取先声明者。
- **三效果语义（2026-10-23 定调）**：
  - `deny` → **强制 ask**（`forced: true`，可申诉但不可被 grants/模式豁免），reason 点出是哪条
    id 拦的。**不是终态拒绝**——写错的运营规则不该把正当动作堵死；唯一终态拒绝是内置硬 deny。
  - `ask` → 非强制 ask（`forced: false`）。**批2b 裁决（原文"可被 always 豁免"作废）**：规则 ask
    位于模式分派之前，而 grant 查询在分派内部，故 `always` 会被接受并落库、但同一条规则**下次仍
    会 ask**——即 ask 规则**不产生持久豁免**。这是有意语义：操作者写 ask 就是要每次过眼；想安静
    就把规则改成 `allow`（而 `allow` 在 strict 下仍不生效）。行为已由测试钉住
    （"banks its always reply yet keeps asking"）。**若产品层日后要求 ask 可被持久豁免，需改链序，
    属可逆决定。**
  - `allow` → **只在 L2/L3/L4 的模式分派层生效**，等价于可持久化、可按战役配置的 grant；
    **strict 下不生效**（用户定调：最严格模式永远逐条人工，规则表不能悄悄 override 模式语义）。
    allow 同样不得越过 scope/危险集/weak 自保护的强制 ask——强制 ask 层先于模式分派短路。
    judge-auto 下 allow 命中则**不进 judge**（省一次 LLM 调用）；auto/yolo 下 allow 与 grants
    同时成立时归因记 `layer: "rules"`。
- 默认规则集为空 = 宽松姿态；规则由操作者按战役写入，不随仓库分发。
- 配置载体：操作者侧 `.tiangong/rules.json`（与 scope 注册表同风格，解析失败即 throw）；
  DB 持久化与热更新属批4/产品层。

### attestation（探测式边界证明，fail-closed）

三个触发点：harness open、会话 resume、fork 子会话创建。探针集（每条策略落地时必须自带对应
探针）：

1. `restricted-env`：读一个应被拒的路径，断言 EACCES（受限 ExecutionEnv 生效）。
2. `scope-outside-not-allow`：构造 scope 外目标调用，断言决策非 allow。
3. `danger-set-forced-ask-past-grants`：危险集命中样本，断言 `ask, forced: true` 且 grants 与
   模式豁免都不生效（批2a 落）。
4. `tool-set-alignment`：核验实际注册工具集 == 赛道预设声明集（对齐 evals 的扩展对账）。
5. `mode-document`：核验模式文档可读且值为四模式之一。
6. `unaffiliated-call-enters-chain`：**无 placement / 恢复态**的调用样本仍进链（复盘 P1-5 回归）。
7. `forced-ask-fails-closed`：ask 通道缺失时 forced ask 表现为 fail-closed 阻断（图纸语义③）。
8. `rule-deny-forced-ask-past-exemptions`：规则表 `deny` 命中产出**强制** ask，grants/模式不可
   豁免（批2b）。
9. `strict-ignores-rule-allow`：`strict` 下即使规则表 `allow` 命中仍必须 ask——定调 1 的机械守卫
   （批2b）。
10. `judge-transport-error-asks`：judge transport 抛错 → ask，且 span `layer` 归 `mode`（降级要
    升级到人，既不放行也不终态）（批2b）。
11. `judge-timeout-asks`：transport 永不返回 → 在 judge 自身超时预算内收敛为 ask（批2b）。

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
