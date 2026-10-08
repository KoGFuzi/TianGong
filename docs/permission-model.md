# 权限模型设计（方案 A′ + 异步审批通道）

状态：已实施。本文档是实施前的设计定稿，与代码不一致时代码是错的。

## 背景与目标

`packages/agent` 此前唯一的执行前控制点是 `beforeToolCall` 钩子，返回值为布尔语义的
`{ block?: boolean; reason?: string; terminate?: boolean }`：只能表达"拒绝"，无法表达
"要求人工批准"，也没有任何声明式的策略载体 —— 每个调用方都要自己写钩子函数硬编码规则。

本设计在不改动 `BeforeToolCallResult` 契约的前提下，引入：

1. 声明式权限规则（first-match-wins 求值，fail-open 默认）；
2. 异步审批通道 `onPermissionAsk`，命中 `effect: "ask"` 时暂停 tool dispatch 等待人工决策；
3. 全部拒绝路径复用既有 block 错误路径，模型看到的拒绝语义与 `beforeToolCall` 阻止完全一致。

## 非目标（明确不做）

- 不给 `BeforeToolCallResult` 增加 `effect` 字段，也不引入 `PermissionVerdict` union。三态决策
  只存在于权限模块内部类型，不进入 hook 返回类型。
- 不做 `preset: "strict"` 之类的"高危工具 ask 模板"体系。参照 opencode 的现状：其源码同样
  不存在可命名的严格模板（默认 agent 规则集是 `* → allow` 底加极少数例外，bash/edit 并不在
  ask 名单内），说明该机制的需求强度不足以支付其成本。需要防护时，用户直接写规则。
- 不做参数级 resource 提取器（`AgentTool.resource`）。MVP 的 resource 只有 tool 名一种推导。
- 不引入 Effect 架构。求值是纯同步函数，审批回调是普通过滤的 Promise。

## 参照 opencode 时的两个取舍

| opencode 的做法 | 我们的取舍 | 理由 |
| --- | --- | --- |
| `evaluate()` 无匹配时兜底 `effect: "ask"`（fail-closed） | **不抄**。无匹配 → `allow`（fail-open） | 与已锁定的 fail-open 默认一致；agent 库作为基础组件，静默暂停等审批会把"没配置"变成"卡死" |
| 默认 agent 硬编码一组防护规则（`.env` 读取 ask、外部目录 ask 等） | **不内置任何默认规则**。默认规则集为空，即无配置时全放行 | 我们的 action 模型只有 `execute`，opencode 的那些例外规则（read action、目录概念）在本包没有对应物；硬塞会降低语义忠实度 |
| `findLast`（后声明优先） | first-match-wins（先声明优先） | 与既有方向一致；"例外在前、通则在后"的写法对读者更直观 |
| 交互式 ask 经事件 + Deferred 等待回复 | `onPermissionAsk` 回调直接 await | 等价的暂停语义，但零新抽象 |

## API 形状

```ts
// permission.ts（新模块）
export interface PermissionRule {
  action: "execute" | "*";        // MVP 仅 execute
  resource: string;               // 支持 "*" 通配（见下）
  effect: "allow" | "deny" | "ask";
}

export interface PermissionRequest {
  action: "execute";
  resource: string;               // 派生值，形如 "tool:<name>"
  toolName: string;
  args: unknown;                  // schema 校验后的参数
}

export type PermissionAskReply = "allow" | "deny";

export function evaluatePermission(
  rules: readonly PermissionRule[],
  resource: string,
): "allow" | "deny" | "ask";
```

`AgentLoopConfig` / `AgentOptions` 各增加两个 optional 字段：

```ts
/** 权限规则，按声明顺序求值，首个匹配生效；无匹配或无规则 → allow（fail-open）。 */
permissionRules?: PermissionRule[];
/** 命中 ask 时调用，等人工决策；回调拒绝或抛错 → 该次调用被拒绝。 */
onPermissionAsk?: (request: PermissionRequest, signal?: AbortSignal) => Promise<PermissionAskReply>;
```

## resource 推导与通配符

- MVP 唯一推导：resource = `tool:<toolName>`。tool 名经 `:` 拼接，避免与将来其他 action 的
  resource 命名空间冲突。
- 通配符只支持 `*`：把模式中的 `*` 之外字符按正则转义、`*` 替换为 `.*`，全串锚定匹配，
  大小写敏感。例：`tool:*`、`tool:shell*`。不支持 glob 字符类、不支持 regex、不支持 `?`。

## 执行链路与优先级

tool dispatch 前的暂停点（`prepareToolCall` 内，`agent-loop.ts`）：

1. 用户 `beforeToolCall` 先执行。返回 `block: true` → 拒绝（既有语义，零改动）。
2. 用户钩子返回其他值（含 `undefined`、`{}`、`{ block: false }`）→ 视为弃权。
3. 弃权后做策略求值：
   - `deny` → 拒绝，理由文本注明命中的规则；
   - `ask` → `await onPermissionAsk(request, signal)`：
     - 未配置回调 → 拒绝，理由 `"no onPermissionAsk handler configured"`。**这是全设计唯一
       的 fail-closed 点**：用户显式写了 ask 却没人接，静默放行违背其意图；
     - 回调返回 `"deny"` 或抛错 → 拒绝；
     - 回调返回 `"allow"` → 继续执行；
     - 回调返回 `"always"` → 继续执行，并把 `execute:<resource>` 写入会话级
       `permissionGrants` 缓存；此后同一 action+resource 的调用跳过规则求值直接放行，
       **人工显式批准优先于一切声明式规则（包括 deny）**；
     - 等待期间 abort signal 触发 → 走既有 "Operation aborted" 错误路径。
   - `allow` 或无匹配/无规则 → 继续执行。

用户钩子与策略的冲突消解：钩子的 `block: true` 无条件生效（它先执行）；钩子没有"显式放行"
的表达（契约冻结），因此"用例外规则覆盖通则 deny"通过规则顺序完成 —— 例外写在通则之前。
`deny` 无全局短路特权，因为单条求值链路上不存在两个决策打架的场景。

## 与既有代码的接合点

| 位置 | 改动 |
| --- | --- |
| `agent/types.ts` | `AgentLoopConfig` 增加 `permissionRules`、`onPermissionAsk` 两个 optional 字段；从 `permission.ts` 导入类型 |
| `agent/permission.ts` | 新模块：`PermissionRule`、`PermissionRequest`、`PermissionAskReply`、`evaluatePermission` |
| `agent/agent-loop.ts` | `prepareToolCall` 在 `beforeToolCall` 弃权后插入策略求值与审批等待；拒绝统一走 `createErrorToolResult` |
| `agent/agent.ts` | `AgentOptions` 增加同名字段并在 `createLoopConfig` 透传 |
| `agent/index.ts` | 导出 `permission.ts` |

`runToolCall`（工具内调用工具的入口）自动获得同等权限检查，因为它与模型发起的调用走同一个
`prepareToolCall`。嵌套调用必须透传 `permissionRules` / `onPermissionAsk` / `permissionGrants`
三个字段（见 `examples/mcp-codemode/tools.ts` 的 `createNestedToolRunner`），否则会静默绕过
策略与"always"授权缓存 —— TianGong 没有 opencode 那种独立命名的 subagent 实体，"subagent
继承主 agent 策略"在我们的结构中等价于"嵌套工具调用走同一份 hooks 与 grants"。

## 兼容性

- `BeforeToolCallResult`、`BeforeToolCallContext`、`AgentTool` 契约零改动；既有
  `beforeToolCall` 实现逐字兼容（既有测试套件不作任何修改即通过即证明）。
- 不配置 `permissionRules` 时行为与现状完全一致：无求值开销（空数组短路），无审批暂停点。
- 仅配置 `permissionRules`（无 `onPermissionAsk`）而规则里无 `ask` 时，同样全程无暂停。

## 迁移/使用示例

```ts
// 旧代码，零改动
beforeToolCall: async ({ toolCall }) => {
  if (toolCall.name === "dangerous_thing") return { block: true, reason: "not allowed" };
  return undefined; // 弃权 → 策略求值 → 无匹配则 allow
}

// 新增：声明式规则 + 审批通道（可只加其一）
new Agent({
  // ...既有选项
  permissionRules: [
    { action: "execute", resource: "tool:safe_*",  effect: "allow" }, // 例外在前
    { action: "execute", resource: "tool:*",       effect: "ask"   }, // 通则在后
    { action: "execute", resource: "tool:rm_file", effect: "deny"  },
  ],
  onPermissionAsk: async ({ toolName, args }) => uiConfirm(`Allow ${toolName}?`),
});
```
