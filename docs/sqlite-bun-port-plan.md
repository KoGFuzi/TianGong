# sqlite-bun 移植规划（对齐上游 sqlite-node）

> **状态：已执行完成（2026-09-12）。** 旧实现整体废弃，上游 sqlite-node 已整体搬入；验收 105 项测试全绿 + tsc 零错误，全仓 5/5 包绿。

> 参照基线：`/run/media/J/Workspace/Code-Testing/pi-main/packages/session-backends/sqlite-node`（下称"上游"，v0.85.1）
> 背景：agent 包 Phase 2/3 已对齐上游新 session API，`session-backends/sqlite-bun` 仍是旧 API 实现，全仓验收红（测试 5/19 + 约 300 处类型错误）。
> 次要参照：opencode-dev 的 `effect-sqlite-node`/`effect-drizzle-sqlite`（Effect 惯用法；TG session 层为 Promise+Context，本移植不引入 Effect）。

## 现状判定

- 上游 sqlite-node src 共 1,850 行，模块小而清晰：`types`（SqliteDatabase 抽象）、`sql`（位置参数模板）、`migrations`（001_initial.sql）、`storage`（实现新 `Storage`）、`repo`（新 `SessionRepo`）、`session`（open-session 生命周期包装）、`session/{branch-entries, entries, session-row, session-sequences, session-stats, usage-ledger, values}`。
- 上游查询**全用位置参数 `?`**（`sql` 模板保证），无命名参数——bun:sqlite 适配无前缀问题。
- TG agent 侧导出面已备齐：`createSessionRepoConformance` 系列 ×9、`createStorageConformance`、`StorageBackedSession`、`createForkSnapshot`、`branchTip`、`uuidv7`、基准种子工具（`session/testing` 子路径）。
- 旧 TG sqlite 实现（lanes/registers/facts/writer-leases/branch-cache/tasks/session-index 等）为 TG 特有设计，构建在已删除的旧 API 上——**整体废弃**（与 agent 包 3e 删除旧 harness 核心同理）。

## 移植方案（整体替换，不渐进）

1. 删除 `packages/session-backends/sqlite-bun` 的 `src/`、`test/`、`dist/`（旧实现全量废弃）。
2. 逐文件搬运上游 `src/sqlite/**`，应用重命名：`@earendil-works/pi-agent-core`→`@onepanda-tiangongsec/tg-agent-core`、`@earendil-works/pi-ai`→`@onepanda-tiangongsec/tg-ai`、`pi-*`→`tg-*`。
3. 新写 `src/index.ts`：以 `bun:sqlite` 实现上游 `SqliteDatabase`/`SqliteStatement` 抽象（替代 node:sqlite 的 `DatabaseSync`），保留 `openExisting`（不建库）/`openReadOnly` 语义。
4. 迁移 `migrations/001_initial.sql` 原样拷贝；`build` 脚本补 `cp -r src/sqlite/migrations dist/sqlite/migrations`（bun build 单文件产物后 `import.meta.url` 指向 dist）。
5. 测试 6 个文件（adapter/repo/repo-conformance/storage/storage-conformance/sql，1,909 行）直接换 `vitest`→`bun:test`（仅基础 describe/it/expect）；conformance 走 `@onepanda-tiangongsec/tg-agent-core/session/testing`。
6. 基准（benchmark/*.bench.ts + vitest.benchmark.config）本轮不移植——bun 无 vitest bench 等价物，后续另案。
7. 验收：`bun test test` 全绿 + 自然退出；`bunx tsc --noEmit` 零错误；根级组合跑不回归。

## 风险登记

| 风险 | 缓解 |
|---|---|
| bun:sqlite 与 node:sqlite 行为差异（exec 多语句、只读打开、lastInsertRowid bigint、iterate 形状） | 适配器聚焦这四点；adapter.test + 全量 conformance 兜底 |
| 001_initial.sql 中的 PRAGMA（WAL 等）在 bun 下差异 | 逐条核对；失败即调整适配器而非 SQL |
| 上游 repo.ts 的文件布局假设（每会话一库 / 容器单库）依赖文件系统语义 | node:fs 语义 bun 全兼容，低风险 |

## 实际落地记录（2026-09-12）

移植按方案执行完毕，过程中发现并修复 **3 处 bun:sqlite/node:sqlite 行为差异**（均已写入适配器注释）：

| 差异 | 表现 | 处置 |
|---|---|---|
| `get()` 空结果返回 `null`（node 返回 `undefined`） | 全新库首次 create 即报 "session already exists"（`hasSessionRow` 判 undefined 失效） | 适配器 `get()` 将 null 归一为 `undefined` |
| `{ create: false }` 恒报 SQLITE_MISUSE（bun 1.3.14 缺陷，d.ts 却宣称支持） | `openExisting` 全部失败 | 改用 `{ readwrite: true, create: false }`（实测：存在可写/缺失抛 "unable to open database file"） |
| 命名参数键名必须带与占位符一致的 `$`/`:`/`@` 前缀（node 接受裸键） | adapter 命名参数用例静默绑空 | 生产代码全为位置参数不受影响；adapter.test 按 bun 语义改写并注明 |

另有两处移植适配：`fs.access()` resolve 值 bun 为 `null`（node 为 `undefined`），repo.test 相应断言改为意图等价的 `await access(path)`；`build` 脚本追加 `cp -r src/sqlite/migrations dist/migrations`（bun build 单文件产物后 `import.meta.url` 指向 dist）。

### 纯 Bun 化（移除全部 node: 依赖）

按"移除 node 的影响、全使用 bun"的要求，src 与 test 的 `node:` 导入全部清除（`grep "from \"node:"` 零命中）：

- 新增 `src/sqlite/bunfs.ts`：POSIX 路径原语（变长 `joinPath`/`dirName`/`relativePath`/`isAbsolutePath`）+ Bun 原生文件操作（`Bun.file().exists()/unlink()`、`Bun.write`、`Bun.Glob.scan`、`Bun.fileURLToPath`）+ Bun.$ 内建命令（`mkdir -p`、`rm -rf`）+ `realpath`（经 Bun.$ 调 realpath 二进制）+ `createTempDirectory`（TMPDIR + UUID，替代 mkdtemp）。
- `repo.ts`：`mkdir/openFile("wx")/readdir/realpath/rm` 全部改接 bunfs；**废弃 `wx` 预留文件**——行级事务守卫（`hasSessionRow`）已覆盖其全部受测语义；失败清理改为 `filePreExisted` 守卫（预存在垃圾文件不删、重复 id 不删有效会话）；`list()` 的目录 realpath 提升为单次调用 + 按名派生（文件名由 repo 生成、非符号链接，语义等价，避免逐文件 spawn）。
- `migrations.ts`：`readFile` → `Bun.file().text()`，`fileURLToPath` → `Bun.fileURLToPath`。
- 三个测试文件（adapter/repo/repo-conformance）同步换用 bunfs；`describe("node:sqlite adapter")` 更名 `"bun:sqlite adapter"`。

**验收（纯 Bun 版）**：105 pass / 0 fail / 6 文件（1.0s 自然退出）；`tsc --noEmit` 零错误；`bun run build` 产物含 migrations；根级双包组合 2450 项全绿（5.9s）。

已知取舍：`realpath` 经 Bun.$ 走 realpath 二进制（每次系统调用级开销，仅用于仓库路径规范化）；并发同 id create 的失败清理存在极窄 TOCTOU 窗口（上游 `wx` 原子预留所独有，无测试覆盖该窗口）。
