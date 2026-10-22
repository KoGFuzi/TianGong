# 旧源码留存

本目录保存将被本轮重设计淘汰的源码，仅供阅读与对照。**这里不是构建产物，也不是依赖**：不参与编译、
不被任何包导入、不受房规与格式检查管辖。

## 范围与出处

| 目录 | 内容 | 出处 |
| --- | --- | --- |
| `agent-core/` | `@OnePanda-TgSec/tg-agent-core` 的全部 `src/`、`test/`（含 `permission.ts`）与 `examples/mcp-codemode/` | 工作区 `packages/agent`，快照于 2026-10-22 |
| `sec-agent/` | 旧 `tg-sec-agent` 的 `src/`（261 文件）、`examples/`（15 文件）、`package.json`、`CHANGELOG.md` | `git archive HEAD`，即提交 `7dcf8a8`（feat: localize tg-sec-agent into the workspace） |

未留存：旧 `packages/sec-agent/docs/`（47 文件、2.9 MB 文档，非源码，可从 `7dcf8a8` 取回）。

`examples/mcp-codemode/` 已一并留存：它是本工作区里唯一把两个 vendored 包（`pi-mcp`/`pi-codemode`）
与一个运行时拼起来的可运行示例，`docs/provenance.md:145` 直接引用它。删包即断链。

## 留存理由

- `agent-core/src/permission.ts` 是 `docs/sec-guard-design.md` 认定的**图纸**：该文档明确不搬迁它，
  只按四级模式重写求值器，因此求值语义（first-match-wins、fail-open 默认、无 ask 通道时 fail-closed、
  `always` 授权按精确 resource 而非规则 pattern 记录）必须能就地对照。
- `agent-core/src/agent-loop.ts` 与 `types.ts` 是旧循环的行为规范，`test/` 是其可执行版本。
  `docs/sec-agent-harness-wiring-review.md` §2、§4 的逐项比对以此为唯一权威；批5 的验收条件
  "agent-loop 零引用"之后，这份对照物就只能靠本目录或 git 历史。
- `sec-agent/src/` 是上游 pi-1.3.0 coding-agent 的本地化成果（会话管理、compaction、扩展、系统提示分段、
  工具实现）。重设计按 `docs/sec-agent-design.md` 走 gibraltar 原生路线，但移植底稿与行为边界需要一份
  可读的旧实现。

## 一次性损失记录

旧 `packages/sec-agent/src/core/harness/`（`harness-agent.ts` 1635 行、`harness-events.ts` 248、
`engine-tools.ts` 110、`harness-preflight.ts` 99、`engine-models.ts` 20）**从未进入 git**，随
`packages/sec-agent` 的工作区删除一同消失。核对方式：`git ls-tree -r HEAD packages/sec-agent/src/core/harness`
为空、`git log --all --diff-filter=A -- '*harness-agent.ts'` 零命中、`git stash list` 空、
`git fsck --lost-found` 无悬挂对象。该桥接层留下的唯一描述是
`docs/sec-agent-harness-wiring-review.md` §1–§3。批5 要求该桥退役，故本次删除与既定方向一致，无需重建。

## 工具链豁免

`scripts/legacy/` 被三处显式排除，新增同类留存时须同步：

- `tsconfig.scripts.json` 的 `exclude`（否则 `check:types` 会把它当脚本编译）
- `biome.json` 的 `files.includes` 中 `!scripts/legacy/**/*`（否则 `check:format` 判格式违规）
- `scripts/check-relative-imports.ts` 的 `LEGACY_ARCHIVE` 跳过（`check:relative-imports` 会遍历整个 `scripts/`）

`check:house-standard` 只遍历 `packages/` 下的包目录，本目录天然不受标识符规则约束。
