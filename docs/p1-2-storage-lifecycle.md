# P1-2 落地规划：storage 生命周期（deleteConversation / exportConversation / backup）

状态：已实施（2026-10-09；改动在工作区，未提交；实施记录与两处修正见 §0.5）
分支：`V2`（V1 冻结不适用于本批工作）
前置：P1-1 已交付（`projectUsage` 已落地）
更新日期：2026-10-09
验证基线：`bun run check` + `bun run test packages/gibraltar` 全绿

---

## 0. 决策记录

### 0.1 继承自已批摘要（`p1-usage-engineering.md` §2）

| # | 决策 | 出处 |
| --- | --- | --- |
| D1 | 三方法进 `Storage` 接口，`MemoryStorage` 同步实现，conformance 双侧同测 | §2.2 |
| D2 | 显式生命周期 API，不进 `commit` 写路径 | §2.2 |
| D3 | delete 级联按 `conversation_id` 逐表删，单事务；fork 子会话不级联 | §2.3 |
| D4 | ID 不回收：`record_ids` / `durable_metadata` 的 ID 分配状态不动 | §2.3 |
| D5 | delete 幂等：会话不存在时静默返回，不抛错 | §2.3 |
| D6 | 审计事件持久化（"何时删了何会话"），测试断言审计存在 | §2.7 / §6 决策点 |
| D7 | export 为 JSONL，一行一记录；header 带 schema 版本；本期只导不入 | §2.4 |
| D8 | backup 用 SQLite `VACUUM INTO`；目标存在则报错透传；`MemoryStorage` 写 JSON 投影仅供测试对称 | §2.5 |
| D9 | delete/export 的 liveness 守卫（运行中任务等）是调用方责任，storage 只管持久层 | §2.3 |

### 0.2 本文档拍板（2026-10-08，与用户确认）

| # | 决策 | 说明 |
| --- | --- | --- |
| D10 | 审计载体：`durable_metadata` 新列 | 迁移 v3：`ALTER TABLE durable_metadata ADD COLUMN deleted_conversations TEXT NOT NULL DEFAULT '[]'`。已批摘要"本项无 migration"与"durable_metadata 新 key"矛盾——singleton 表加 key 必须走 ALTER，即迁移；冻结的数据表（entries/documents 等）零变更，符合原冻结意图 |
| D11 | `deleteConversation` 返回审计对象 | `Promise<ConversationDeletion \| undefined>`；`undefined` = 会话不存在。返回值即审计事件的内存形状，conformance 双实现可直接断言，不需要 SQL 才能测审计 |
| D12 | `exportConversation` 返回 `readonly string[]` | 一行一元素。P1 只导不入，数组可直接逐行 `JSON.parse` 与 deepEqual；流式变体延后到 P2 导入/CLI 时评估 |
| D13 | export 行范围与 delete 级联完全对称 | header 之外增加 `tg.export.task` 与 `tg.export.submission` 行。"先导后删"不丢数据；行数关系可被 conformance 断言（对称性用例） |

### 0.3 本文档对已批摘要的事实修正（代码证据见 §1）

| # | 摘要原文 | 代码事实 | 处置 |
| --- | --- | --- | --- |
| F1 | "ancestry 断链在读取侧已有处理"（§2.3） | 不成立。三处 SQLite 读路径（`storage.ts:326/:357/:392`）与两处 Memory 读路径（`memory.ts:492/:671`）用 `(await …)!` 断言父会话存在；父行被删后访问 `undefined.parent` 抛 `TypeError`。删父会直接崩掉子的部分读取 | 新增工作项 M2"ancestry 硬化"：父行缺失视为可见历史终点，不抛（§2.4） |
| F2 | "本项无 migration"（§2.7） | 与"durable_metadata 新 key"（同节）机械上不可兼得：该表是固定三列的 singleton，加 key 只能 ALTER，即迁移 | 按 D10 落地为迁移 v3，仅动 `durable_metadata` 一张表 |
| F3 | 级联清单只列 conversation-scope 文档（§2.3 表） | 遗漏 task-scope 文档：tasks 按 `conversation_id` 删掉后，其 `scope_kind='task' AND owner_id=taskId` 的文档行与 revisions 变孤儿（`findDocument`/`scanDocuments` 仍能读到） | 级联清单补 task-scope 文档（§2.3 修正版） |

### 0.4 本文档新增的工程拍板

| # | 决策 | 理由 |
| --- | --- | --- |
| D14 | 保留会话（`ROOT_CONVERSATION_ID = 1`）拒删，抛错 | conformance 已断言"ID 1 保留给不可变根会话"；根是结构不变量，不是生命周期对象 |
| D15 | owned children（`owner.conversationId` 指向被删会话的子会话）不级联、不拒绝 | 与 D9 一致：storage 只管持久层。owner 边悬挂后子会话功能上等价 ownerless；liveness 由调用方保证。写入 doc comment 与 ops manual |
| D16 | ~~`MemoryStorage` 顶层 `import { writeFile } from "node:fs/promises"` 实现 backup~~ **已作废**：`MemoryStorage.backup` 拒绝并抛 `cannot write file backups` | 实施时撞上 `test/storage-runtime-boundary.test.ts`——包根导出图（`index.ts` → `storage/memory.ts`）机械禁止一切 Node 导入。机械边界优先于测试对称性；与 `health()` 对不支持后端报 `unsupported` 同精神（§0.5） |
| D17 | backup 不隐式 `mkdir` 父目录 | 路径管理是调用方责任；目录缺失时透传 SQLite 报错，不静默造目录 |
| D18 | export 全部行在单个 `db.transaction` 快照内读取 | 与 `Storage.document()`（`storage.ts:532`）既有先例一致；代价是快照期间持写预约锁（适配器 `transaction` 无条件 `BEGIN IMMEDIATE`），见风险 R5 |
| D19 | header 的 `schemaVersion` 从 `durable_schema` 回读（SQLite）/ Memory 报 `0` | 不假设、回读实测值；Memory 无 schema 概念，0 与 `health()` 对未迁移库报 0 的既有语义一致 |
| D20 | header 的 `projectId`：SQLite 填 `this.project`，Memory 省略该键 | Memory 无 project 概念，不伪造值 |
| D21 | 审计事件形状：`{ v:1, conversationId, projectId, deletedAt, counts }` 追加到列数组尾部 | 承接 D10/D11；`projectId` 必须有——`durable_metadata` 是文件级 singleton，一个文件多项目共存，无 project 维度的审计不可读 |

### 0.5 实施记录（2026-10-09，全部里程碑已落地）

| 里程碑 | 结果 | 验证 |
| --- | --- | --- |
| M1 迁移 v3 + `ConversationDeletion` 类型 | 完成；`sqlite-migrations` / `sqlite-health` 的版本断言随迁 | 全绿 |
| M2 `deleteConversation` + ancestry 硬化 | 完成（含 F3 的 task-scope 文档级联补漏）；硬化以独立 `fix` 语义落地 | conformance C1-C4 双实现 + across-reopen；S1 审计列 |
| M3 `exportConversation` | 完成；C5-C6 含 export/delete 对称性机械断言 | 双实现全绿 |
| M4 `backup` | 完成；S3-S5；Memory 按 D16 修订拒绝 | 双实现全绿 |
| M5 文档 | ops-manual §3.4/§4/§7/§8/§9、`CHANGELOG.md`、p1 §2.8、本文档 | `bun run check` + 包套件（44 文件 809 用例）全绿 |

实施修正两处（除 D16 作废外）：

1. **C2 的 mintId 断言删除**：原断言"删后重开 mintId 单调递增"不成立——`mintId` 候选在被 `commit` 写入前不具跨重开单调性（ReopeningStorage 每次 commit 重开，失败提交丢弃内存态候选）。不回收 ID 的机械保证是"同 ID 重建被拒"（保留断言），另断言新分配越过全部已写入 ID 并可成功提交。
2. **探针补充**：WAL 源库 `VACUUM INTO` 产物为独立 `delete` 库、只读可直读（S3/S4 的裸读断言依据）；`BEGIN IMMEDIATE` 内 `ALTER TABLE … ADD COLUMN` 提交成功（迁移 v3 事务形状依据）。

流程说明：未采用 §5 的"占位实现"拆分——接口按方法逐个扩展、与双实现同笔落地，每步编译自洽且无占位代码。commit 拆分建议（如提交时）按 §5 表中 M1→M5 语义分组。

---

## 1. 现状盘点（代码事实）

### 1.1 `Storage` 接口与三处实现

`packages/gibraltar/src/types.ts:992-1085` 定义 `Storage`：`commit / mintId` 加 conversation/entry/task/submission/document 的读与追加，`close` 收尾。**没有任何删除、导出、备份能力**；数据库只会增长。

接口实现共三处，新增接口方法三处都要动：

| 实现 | 位置 | 性质 |
| --- | --- | --- |
| `SqliteStorage` | `src/storage/sqlite/storage.ts:130` | 生产唯一后端 |
| `MemoryStorage` | `src/storage/memory.ts:219` | 测试专用 |
| `ReopeningStorage` | `test/sqlite-storage.test.ts:47-111`（test-local） | 每次提交后重开文件，验证跨重开持久性；用**逐方法显式转发**实现接口，不转发新方法会编译失败 |

先例对照：`health()`（`storage.ts:146`）与 `checkpoint()`（`:163`）是 `SqliteStorage` 的**类方法**而非 `Storage` 接口方法——因为它们是 node-only 能力且 Memory 无对应物。本批三方法按 D1 进接口：delete/export 需要双实现对称（conformance），backup 需要 `ReopeningStorage` 等实现方一起承担签名，且已批摘要明确三方法同列。

### 1.2 Schema v2 全表清单（`src/storage/sqlite/migrations.ts`）

| 表 | 列 | project 隔离 | delete 语义 |
| --- | --- | --- | --- |
| `durable_metadata` | singleton=1, next_id TEXT, next_seq INTEGER | **文件级，无 project_id** | 只追加审计列（D10），不动 next_id/next_seq |
| `record_ids` | id, record_type | **全局，无 project_id** | 不删（ID 永不复用的执行者） |
| `conversations` | id, project_id, owner_conversation_id, owner_task_id, record | 有 | `WHERE project_id = ? AND id = ?` |
| `entries` | id, project_id, conversation_id, head, commit_seq, record | 有 | `WHERE project_id = ? AND conversation_id = ?` |
| `tasks` | id, project_id, conversation_id, kind, status, abort_requested, background, record | 有 | 同上 |
| `submissions` | id, project_id, conversation_id, request_id, status, record | 有 | 同上 |
| `documents` | id, project_id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record | 有 | 见 §2.3 级联谓词 |
| `document_revisions` | document_id, seq, kind, version, content | 无（经 document_id 关联） | 随文档行删 |
| `projects` / `health` / `durable_schema` | — | — | 不动（调用方管理 / 探测记录 / 版本表） |

既有行级 `DELETE` 仅两处 `document_revisions` 级联（`storage.ts:921/:946`，随文档 base 重写与 retire），与本批无冲突。

### 1.3 会话数据的扇出（delete/export 的行集依据）

一个会话拥有的行（全部按 `project_id` 过滤）：

1. `conversations` 本体行（含 `parent` fork 边与 `owner` 归属边，都在 record JSON 里）；
2. `entries` 行（`conversation_id`）——**fork 不复制 entries**：`session/transaction.ts:289-335` 的 `forkConversation` 只复制 conversation-scope 文档（`prepareForkDocumentCopies`，`:322`），子会话靠 `ConversationRecord.parent` 链在读取时走父历史；
3. `tasks` 行（`conversation_id`）——task 恰属一个会话，无跨会话 entry 写入；
4. `submissions` 行（`conversation_id`）；
5. `documents` 行：`scope_kind='conversation' AND owner_id=conversationId`（harness 对每个会话固定创建 4 个：`tg.live`、`tg.inbox`、`tg.usage`、`tg.agent`，`harness/harness.ts:354-360`），**加上** `scope_kind='task' AND owner_id IN (该会话的 tasks)`（F3 补漏）；
6. `document_revisions` 行：上述文档行的 revisions。

`Session` 文档（`scope_kind='session'`）不属于任何会话，不进级联，也不进导出（与已批"全局表不进会话导出"一致）。

### 1.4 fork 读取路径的崩溃点（F1 证据）

子会话可见历史 = 自身 entries + 沿 `parent` 链的父 entries（≤ `parent.at` 截止）。五处 walk 用非空断言取父会话：

| 后端 | 位置 | 崩溃方式 |
| --- | --- | --- |
| SQLite | `readEntry` `storage.ts:326` | `(await this.readConversation(…))!` → `undefined` 上取 `.parent` 抛 `TypeError` |
| SQLite | `readLatestHeadMarker` `storage.ts:357` | 同上 |
| SQLite | `readEntries` `storage.ts:392` | 同上 |
| Memory | `visibleEntries` `memory.ts:671` | `this.state.conversations.get(currentId)!` 同崩；`entry()` 双参重载（`:469`）委托它 |
| Memory | `findLatestHeadMarker` `memory.ts:492` | 同上 |

即：**删父后子的全量 `scanEntries`（走穿自身行数后继续向父）、双参 `entry()`、`findLatestHeadMarker` 都会崩**，只有行数够 limit 提前 break 的分页读侥幸不崩。M2 的硬化把这五处改为"父行缺失 → 可见历史到此为止"，行为从崩溃改为明确语义（§2.4）。

### 1.5 `durable_metadata` / `record_ids` 的角色

- `durable_metadata` 是**每个文件一行**的 singleton（无 project 维度）；`commit` 每次在事务里 `SELECT next_id, next_seq`（显式列清单，`storage.ts:201-203`）——审计列不进 commit 读路径，`commit` 热路径零开销。
- `record_ids` 全局登记 id → record_type；`checkGlobalIds`（`storage.ts:656`）据此拒绝复用（"already belongs to"）。delete 不删它 ⇒ 删除后同 id 重建被拒 ⇒ **ID 永不复用**有机械保证，且这正是 D4 要保留的性质。

### 1.6 运行时边界

- Node 适配器用 `SerialOperationQueue`（`node.ts:36-79`）串行化同一连接上的全部操作；`transaction()` 无条件 `BEGIN IMMEDIATE`（`:198`）。因此 delete/export 的多语句事务天然与 commit/close 互斥；backup 的单语句 `VACUUM INTO`（不能进事务，见 §1.8）排在队列里同样与它们互斥，无需 `admitRead`（那是为多语句读与 close 的排空协议准备的，`storage.ts:587`）。
- `SessionImpl` 有已加载文档缓存 `#documents`（`session/session.ts:61`）：storage 层删会话后，活着的 Session 对该会话文档的快照/订阅仍吃缓存。**P1 不在 Session/Harness 层接线**（见 §7），doc comment 与 ops manual 写明调用时机（D9 扩展：也不应有持有其已加载文档的活 Session；`unloadDocuments()` 可清缓存）。

### 1.7 conformance 框架

- 用例定义在 `src/testing/storage-conformance.ts`（`createStorageConformance`，`:91`），断言面 `StorageConformanceAssertions`（`src/testing/types.ts:3-22`，vitest 风格 façade：`toBe/toEqual/toMatchObject/rejects…`）。
- 注册点：`test/sqlite-storage.test.ts:113/117`（含 across-reopen 变体）与 `test/memory-storage.test.ts:8`。**新用例写进共享套件即双实现自动同测**；实现差异性行为（审计列 SQL、backup 产物格式）放 `test/storage-lifecycle.test.ts`。
- 已有根会话用例："reserves ID 1 for the immutable root conversation"（`storage-conformance.ts:94-101`）——D14 拒删根的依据。

### 1.8 SQLite 实测探针（2026-10-08，node:sqlite，脚本已按 house 规则用后即删）

| 探针 | 结果 |
| --- | --- |
| `prepare("VACUUM INTO ?").run(path)` 绑定参数 | 可用，生成完整可开库 |
| 目标文件已存在 | 报 `output file already exists` |
| 事务内执行 | 报 `cannot VACUUM from within a transaction` ⇒ backup 绝不能包进 `db.transaction` |
| `BEGIN IMMEDIATE` 内 `ALTER TABLE … ADD COLUMN deleted_conversations TEXT NOT NULL DEFAULT '[]'` + `COMMIT` | 提交成功，旧行值得 `'[]'`（迁移 v3 与 `applySqliteMigrations` 的事务形状一致，`migrations.ts:171-190`） |
| 事务内读审计列 → append → `UPDATE` | 往返无损，JSON 完整 |

---

## 2. 设计

### 2.1 公共类型与接口签名（完整落地形状）

`packages/gibraltar/src/types.ts`：

```typescript
/** Durable summary of one completed conversation deletion; the persisted audit event's in-memory shape. */
export type ConversationDeletion = {
	readonly conversationId: ConversationId;
	/** Project the deletion ran in; absent when the backend has no project notion. */
	readonly projectId?: string;
	/** Wall-clock milliseconds when the deletion committed. */
	readonly deletedAt: number;
	/** Rows removed per table; documents counts conversation- and task-scoped incarnations. */
	readonly counts: {
		readonly entries: number;
		readonly tasks: number;
		readonly submissions: number;
		readonly documents: number;
	};
};
```

`Storage` 接口（`types.ts:993`）追加三方法（doc comment 按下方原文落）：

```typescript
export interface Storage {
	// …既有成员不动…

	/**
	 * Permanently remove one conversation and every row scoped to it in this storage's project: its
	 * conversation record, entries, tasks, submissions, and conversation- and task-scoped document
	 * incarnations with their revisions. Then records an audit event in durable metadata. Returns
	 * undefined when the conversation is absent; nothing is deleted or audited. The reserved root
	 * conversation is rejected. IDs are never reclaimed, so recreating a deleted conversation's ID
	 * is rejected by commit. The caller owns liveness: no live task may still write the conversation,
	 * and no Session may hold its documents loaded.
	 */
	deleteConversation(id: ConversationId, context: Context): Promise<ConversationDeletion | undefined>;

	/**
	 * Serialize one conversation's own rows as JSONL lines, read from one consistent snapshot: a
	 * header line, then entry, task, submission, and document lines in ascending ID order. Returns
	 * undefined when the conversation is absent. The payload covers exactly what deleteConversation
	 * removes, so export-before-delete loses nothing. Session-scoped documents and other
	 * conversations' rows (including fork parents') never appear.
	 */
	exportConversation(id: ConversationId, context: Context): Promise<readonly string[] | undefined>;

	/**
	 * Write a consistent snapshot of the storage to a new file at path. SQLite uses VACUUM INTO: the
	 * snapshot covers the whole database file, every project in it, including committed WAL content.
	 * The target must not exist; that error is passed through. MemoryStorage writes a JSON projection
	 * for test symmetry only and is not a restore format.
	 */
	backup(path: string, context: Context): Promise<void>;
}
```

导出追加到 `src/index.ts`：`ConversationDeletion` 类型。JSONL 行格式不入 TS 类型（P2 导入时再定，见 §7）。

### 2.2 迁移 v3：`durable_metadata` 审计列

`src/storage/sqlite/migrations.ts`：

```typescript
// Version 3 adds the conversation-deletion audit to the storage singleton. One ALTER on
// durable_metadata only: the data tables (conversations, entries, tasks, submissions, documents,
// document_revisions, record_ids) do not change. The column is read and written only by
// deleteConversation; commit's metadata SELECT lists next_id and next_seq explicitly, so the
// audit never touches the commit path. Events append at the array tail:
// { "v":1, "conversationId":…, "projectId":…, "deletedAt":…, "counts":{…} }
const ADD_DELETION_AUDIT: readonly string[] = [
	`ALTER TABLE durable_metadata ADD COLUMN deleted_conversations TEXT NOT NULL DEFAULT '[]'`,
];

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
	{ version: 1, statements: INITIAL_SCHEMA },
	{ version: 2, statements: ADD_PROJECT_ID },
	{ version: 3, statements: ADD_DELETION_AUDIT }, // CURRENT_SQLITE_SCHEMA_VERSION 变为 3
];
```

- 旧文件升级与新建文件都经 `applySqliteMigrations` 既有机制（事务内逐版本执行，`:161-191`），无需新代码路径；探针已证实在 `BEGIN IMMEDIATE` 内可行。
- 语义边界：`deleted_conversations` 是**审计事件数组**，只增不改；上限为"该文件历史上发生过的删除次数 × ~200B"。膨胀风险与逃生舱见 R1。

### 2.3 deleteConversation（SQLite 实现）

单事务（`this.db.transaction`）内按下序执行；顺序由子查询依赖决定（revisions 的删除谓词引用 documents 与 tasks 行，documents 引用 tasks 行，所以必须先删依赖方）：

```
1. 读本体      SELECT record FROM conversations WHERE project_id = ? AND id = ?
               → 行不存在 ⇒ return undefined（幂等，不审计不删行）
2. 拒根        id === ROOT_CONVERSATION_ID ⇒ throw（进事务前判，见下）
3. 计数        SELECT count(*) 各表（documents 用第 4 步同谓词）
4. 删 revisions  DELETE FROM document_revisions WHERE document_id IN (
                    SELECT d.id FROM documents d
                    WHERE d.project_id = ? AND (
                      (d.scope_kind = 'conversation' AND d.owner_id = ?)
                      OR (d.scope_kind = 'task' AND d.owner_id IN
                          (SELECT t.id FROM tasks t WHERE t.project_id = ? AND t.conversation_id = ?))))
5. 删 documents   DELETE 同第 4 步谓词（task 子查询仍可用，tasks 行未删）
6. 删 entries     DELETE FROM entries WHERE project_id = ? AND conversation_id = ?
7. 删 submissions DELETE FROM submissions WHERE project_id = ? AND conversation_id = ?
8. 删 tasks       DELETE FROM tasks WHERE project_id = ? AND conversation_id = ?
9. 删本体        DELETE FROM conversations WHERE project_id = ? AND id = ?
10. 审计         SELECT deleted_conversations FROM durable_metadata WHERE singleton = 1
                 → JSON.parse → push { v:1, conversationId, projectId: this.project,
                                      deletedAt: Date.now(), counts } → UPDATE 回写
```

要点：

- **根拒删在事务外先判**（`assertOpen()` 后立即），不消耗事务：`throw new Error("The root conversation is reserved and cannot be deleted")`（措辞与既有错误风格一致，不新造 error class）。
- **project 隔离贯穿每条语句**；别的 project 同 id 会话行不可见 ⇒ 第 1 步得 `undefined`，幂等返回。
- **不动**：`record_ids`、`durable_metadata.next_id/next_seq`、`projects`、session-scope 文档。`mintId` 单调性不受影响。
- **审计并发安全**：事务内读-改-写整列，同一文件上的事务经适配器串行排队，无丢失更新。
- **不级联不拒绝**：fork 子会话（`parent` 指向被删者）与 owned 子会话（`owner` 指向被删者）行保留（D3/D15）；前者依赖 M2 硬化保持可读。
- 返回 `ConversationDeletion`（`projectId: this.project`）。

### 2.4 M2 ancestry 硬化（F1 处置）

五处 walk 的语义统一改为：**沿 `parent` 链上行时父会话行缺失 ⇒ 可见历史到此为止**（SQLite 三处 break/return undefined；Memory 两处把 `conversations.get(currentId)!` 换成缺失即终止）。

- 语义自洽性：删除父会话同时删掉了父的 entries 行，"父历史不再可见"就是持久层真实状态；崩溃（现状）不是任何调用方依赖的契约，改为明确定义是修 bug 而非行为变更。CHANGELOG 以 Changed/Fixed 记录（见 §5 M2）。
- 覆盖读取面：`scanEntries`（子全量与分页）、双参 `entry()`（父 entry 不可见 ⇒ `undefined`）、`findLatestHeadMarker`（子自身无 marker 时停在断链处 ⇒ `undefined`）。`head` 指向父区间的子 marker 行仍返回（它是子的行；其 `head` 值继续充当下界，无崩溃路径）。
- Memory 与 SQLite 同步硬化，conformance 用例 4（§4）双测。

### 2.5 exportConversation（双实现）

行格式（`v:1`，一行一 `JSON.stringify` 产物；records 是 JSON 文本，无裸换行）：

```jsonl
{"v":1,"kind":"tg.export.header","projectId":"default","conversationId":2,"exportedAt":1759948800000,"schemaVersion":3,"conversation":{…ConversationRecord 原文}}
{"kind":"tg.export.entry","seq":2,"entry":{…EntryRecord 原文}}
{"kind":"tg.export.task","task":{…TaskRecord 原文}}
{"kind":"tg.export.submission","submission":{…SubmissionRecord 原文}}
{"kind":"tg.export.doc","doc":"tg.usage","key":null,"version":1,"state":{…物化值}}
{"kind":"tg.export.doc","doc":"tg.tool.memo","taskId":9,"key":"slot-1","version":1,"state":{…}}
```

- 行序：header → entries（id ASC）→ tasks（id ASC）→ submissions（id ASC）→ docs（document id ASC）。确定性排序，逐行可 `JSON.parse`。
- header 携带 `conversation`（完整 `ConversationRecord`，保 `parent`/`owner` 边）——P2 导入可凭此重建 fork 图（D13 延伸）。
- doc 行：`doc`=文档 kind，`key`=family 成员键（singleton 为 `null`），`version`=物化时的定义版本，`state`=`document(id,"current")` 物化值；`taskId` 仅 task-scope 文档携带。只导 current、活的化身；session-scope 与他会话（含 fork 父）的行永不出现。
- `projectId`：SQLite 填 `this.project`；Memory 省略键（D20）。`schemaVersion`：回读 `durable_schema.version`（D19，不假设等于 `CURRENT_SQLITE_SCHEMA_VERSION`）；Memory 填 `0`。`exportedAt`：`Date.now()` 毫秒。
- SQLite 实现：整个读取包在 `this.db.transaction` 里（D18），entries 用 `SELECT record, commit_seq FROM entries WHERE project_id = ? AND conversation_id = ? ORDER BY id ASC`（own-rows 直查，**不走 `scanEntries`**——它是 fork-aware 的，见 §1.4；此路径恰好不受断链影响，但仍属 M2 范畴的语义一致性说明）；docs 物化复用 `materializeDocument`（`storage.ts:606`）。会话不存在（本 project）⇒ `undefined`。
- Memory 实现：同序读 `state.entryIds` / `state.tasks` / `state.submissions` / conversation+task-scope 文档（经 `state.documentIdsByScope` 与文档地址索引），物化走其内部 `materializeDocument`。
- 大会话内存上界见 R4。

### 2.6 backup（双实现）

- SQLite：`this.db.run("VACUUM INTO ?", path)`。**不进 `db.transaction`**（§1.8 实测：事务内直接报错）；不套 `admitRead`（单语句，串行队列已与 close/commit 互斥，§1.6）；`assertOpen()` 后执行。目标存在 ⇒ 透传 `output file already exists`；目录缺失 ⇒ 透传打开失败（D17）。快照含全部 project 与已提交 WAL 内容（VACUUM INTO 自身保证一致性，无需先 checkpoint）。
- Memory（实施修订，D16 作废）：`backup(path)` 拒绝并抛 `MemoryStorage cannot write file backups; backup is a SQLite storage capability`——包根导出图（`index.ts` → `storage/memory.ts`）禁止 Node 导入，机械边界优先；storage 保持打开可用。`deletions` 内存审计轨迹保留（delete 对称性）。
- conformance 不收 backup（产物格式实现各异，无法双侧同断言）；实现专属测试见 §4。

### 2.7 错误面汇总

| 场景 | 行为 |
| --- | --- |
| delete 不存在的会话（本 project） | `undefined`；不删不审计 |
| delete 根会话（id=1） | throw（结构不变量） |
| delete 有活任务的会话 | 照删（调用方责任，D9；doc comment 明示） |
| delete 后同 ID 重建 | `commit` 拒绝 "already belongs to"（record_ids 保留） |
| delete 后 fork 子会话读取 | 硬化后返回子自身历史，不抛（M2） |
| export 不存在的会话 | `undefined` |
| 三方法在 `close` 之后 | `assertOpen` 抛 "SqliteStorage is closed" / Memory 同理 |
| backup 目标已存在 | 透传 `output file already exists`，源库无损 |
| backup 目录不存在 | 透传打开失败，不 mkdir |
| backup 期间并发 commit/读 | 串行队列互斥；进程外连接按 SQLite busy 语义等待 |

---

## 3. 变更文件清单

| 文件 | 改动 |
| --- | --- |
| `packages/gibraltar/src/types.ts` | `ConversationDeletion` 类型；`Storage` 接口追加三方法（doc comment 按 §2.1） |
| `packages/gibraltar/src/index.ts` | 导出 `ConversationDeletion` |
| `packages/gibraltar/src/storage/sqlite/migrations.ts` | 迁移 v3 `ADD_DELETION_AUDIT`；`CURRENT_SQLITE_SCHEMA_VERSION` → 3 |
| `packages/gibraltar/src/storage/sqlite/storage.ts` | 三方法实现；五处 ancestry walk 硬化中的三处（`:326/:357/:392`） |
| `packages/gibraltar/src/storage/memory.ts` | 三方法实现（backup 为拒绝语义，见 §0.5）；两处 walk 硬化（`:492/:671`）；state 增 `deletions` 轨迹 |
| `packages/gibraltar/src/testing/storage-conformance.ts` | 新增 6 个共享用例（§4 矩阵 C1-C6） |
| `packages/gibraltar/test/storage-lifecycle.test.ts` | **新建**：实现专属用例（S1-S5、M1-M2，§4） |
| `packages/gibraltar/test/sqlite-storage.test.ts` | `ReopeningStorage` 转发三方法（编译修复） |
| `packages/gibraltar/test/sqlite-migrations.test.ts` | v3 期望：版本 3、审计列 `'[]'`、v2 文件升级路径 |
| `docs/ops-manual.md` | §3 增"3.4 生命周期三方法"（示例 + 调用时机警示 + 审计查询示例 + backup 文件级语义）；§4 `schemaVersion: 2` 示例改 3（`:136`）与 §4.1 告警阈值（`:173`）；§7 排障增两行（审计列、backup 目标存在）；§8 升级补 v3 一句；§9 范围更新 |
| `docs/p1-usage-engineering.md` | §2 末追加"§2.8 落地修订"小节：D10-D13 拍板与 F1-F3 修正，链接本文档（日期记 M5 落地当日） |
| `packages/gibraltar/CHANGELOG.md` | `Unreleased → Added` 三方法；`Changed`（或 `Fixed`）记 ancestry 硬化与迁移 v3 |

不动的文件：`database.ts`、`node.ts`（backup 用既有 `run`，无需 façade 扩展）、`session/*`、`harness/*`（P1 不在 Session/Harness 层接线，见 §7）。

---

## 4. 测试计划（矩阵）

原则（AGENTS.md 测试规则）：每条断言只断**已观察**行为；写用例前先跑最小探针（本文档 §1.8 的探针已覆盖 VACUUM INTO/ALTER 两个最大未知数；写 S1 前用 `bun -e` 再探一次审计列读改写即可）。

### 4.1 共享用例（`src/testing/storage-conformance.ts`，双实现自动同测）

| # | 用例 | 关键断言（全部可观察） |
| --- | --- | --- |
| C1 | delete 级联清空自身行、邻居完好、返回审计对象 | 建会话 A、B + A 的 entries×2 / task×1 / submission×1 / conversation-scope 文档×2 / task-scope 文档×1；删 A → 返回值 `counts = {entries:2, tasks:1, submissions:1, documents:3}`（documents 含 task-scope，锁死 F3 修正）；`conversation(A)` undefined；`scanConversations` 只剩 B；`scanTasks/scanSubmissions({conversationId:A})` 空；`scanDocuments({scope:{kind:"conversation",conversationId:A},at:"current"})` 空；A 的 entry/文档 `entry()/document()` undefined；B 的行原样 |
| C2 | ID 永不复用 | 删 A 后 `commit` 重建同 id 会话 → rejects "already belongs to"；新分配越过全部已写入 ID 并可成功提交（实施修订：原"mintId 跨重开单调"断言删除，见 §0.5） |
| C3 | 根会话拒删 | 先建根；`deleteConversation(ROOT_CONVERSATION_ID)` rejects；根仍可读 |
| C4 | 删父后子可读（硬化回归，锁死 F1） | 建父 P + 父 entries；建子 C（record 带 `parent:{conversationId:P, at:父entry}`）+ 子 entries；删 P → `scanEntries({conversationId:C}, 大limit)` 只含子自身行且**不抛**；双参 `entry(C, 父entryId)` undefined；`findLatestHeadMarker(C)` 不抛（子无 marker ⇒ undefined） |
| C5 | export 行结构 | 同 C1 数据导 A：首行 `JSON.parse` 得 `{v:1, kind:"tg.export.header", conversationId, conversation:{…A 的 record}}`（toMatchObject，不断 `exportedAt/schemaVersion` 的具体值）；kind 序列 = header → `tg.export.entry`×2（id ASC）→ `tg.export.task`×1 → `tg.export.submission`×1 → `tg.export.doc`×3（document id ASC）；每行可 `JSON.parse`；总行数 = 1+2+1+1+3；不存在会话 export → undefined |
| C6 | export 与 delete 对称 | 同一数据：先 export 后 delete，`counts` 各分项 === 对应 kind 行数（D13 的机械断言） |

### 4.2 SQLite 专属（`test/storage-lifecycle.test.ts`，临时目录 + 裸 `DatabaseSync` 查证，仿 `scalar()` 模式）

| # | 用例 | 关键断言 |
| --- | --- | --- |
| S1 | 审计事件落 `durable_metadata` | 删两次（两个会话）→ 裸连接读 `deleted_conversations`：数组长度 2，事件字段 `{conversationId, projectId, deletedAt>0, counts}` 与返回值逐项相等；追加序=删除序；删后 `health().ok === true`（已批摘要 §2.6 条目 1 的完整性断言，验收时补入） |
| S2 | 迁移 v3 | 新文件：`health().schemaVersion === 3`、审计列 `'[]'`；手工构造 v2 版本文件（`applySqliteMigrations(migrations.slice(0,2))`）重开 → 升到 3、审计列 `'[]'`、`next_id/next_seq` 不变 |
| S3 | backup 产出可开快照 | 写数据（WAL 活跃，未强制 checkpoint）→ `backup(p)` → 用 `openNodeSqliteStorage(p)` 打开备份：`health().ok === true`、`schemaVersion === 3`；各表行数与源一致（覆盖"含已提交 WAL 数据"） |
| S4 | backup 目标存在 | 第二次 `backup(p)` rejects（消息含 "output file already exists"）；源库 `health().ok` 且行数不变 |
| S5 | close 之后三方法拒绝 | `close` 后 delete/export/backup 各自 rejects "closed" |

### 4.3 Memory 专属（同文件）

| # | 用例 | 关键断言 |
| --- | --- | --- |
| M1 | Memory backup 拒绝为不支持能力 | 打开状态下 `backup(p)` rejects 且消息含 `cannot write file backups`，随后 storage 仍可用；`close` 后 rejects `closed`（实施修订，见 §0.5） |

### 4.4 既有套件回响

- `sqlite-migrations.test.ts` / `sqlite-storage.test.ts` 的版本与 metadata 断言按 v3 更新（`next_id/next_seq` 断言不变，审计列是新增列不进其 `toEqual`）。
- 跑法：`bun run test packages/gibraltar`（窄到包）；单文件迭代 `cd packages/gibraltar && bun run vitest --run test/storage-lifecycle.test.ts`。faux 数据 only，无真实 provider（AGENTS.md 规则）。

---

## 5. 落地顺序（里程碑 → 验证 → 提交）

每个里程碑独立可交付：`bun run check` + `bun run test packages/gibraltar` 全绿后才进下一个；提交按 AGENTS.md 显式路径暂存，消息走 `feat|fix|docs(gibraltar): …`。

| # | 内容 | 提交 | 验证要点 |
| --- | --- | --- | --- |
| M0 | 基线：全量 `bun run check` + `bun run test`（不含 e2e 激活变量）确认起点全绿；`git status` 干净 | 无 | 基线不绿先修，不夹带 |
| M1 | 迁移 v3 + `ConversationDeletion` 类型 + 接口签名三方法（两实现先落**最小语义版**：delete 幂等骨架不审计、export/backup 暂 throw？"否"——接口与实现一并落，见 M2 拆分说明） | `feat(gibraltar): add deletion audit column and lifecycle interface` | `sqlite-migrations.test.ts` v3 断言过；类型检查过。注：若希望接口与实现同 commit，可将 M1 限缩为"迁移 + 类型 + 两实现的 deleteConversation 完整实现"，M2 只剩硬化与用例 |
| M2 | SQLite+Memory 的 `deleteConversation` 完整实现 + **ancestry 硬化五处** + conformance C1-C4 + S1 | `feat(gibraltar): delete conversations with durable audit` 与 `fix(gibraltar): treat missing fork ancestors as visible-history end`（两笔：硬化是独立行为修正，单独可回归） | C1-C4/S1 绿；CHANGELOG 记硬化 |
| M3 | 双实现 `exportConversation` + conformance C5-C6 | `feat(gibraltar): export conversations as JSONL` | C5-C6 绿 |
| M4 | 双实现 `backup` + S3-S5 + M1 | `feat(gibraltar): snapshot databases with VACUUM INTO backup` | S3-S5/M1 绿 |
| M5 | `docs/ops-manual.md` + `docs/p1-usage-engineering.md` §2.8 修订 + `CHANGELOG.md` | `docs(gibraltar): document the storage lifecycle` | 手册与代码逐条对照（§3 清单）；`bun run check:house-standard` 过 |

M1 的拆分建议（上表"注"展开）：接口加方法后 TS 结构化类型立即要求全部实现者提供方法，因此**每笔提交都必须自洽可编译**。推荐顺序：M1 只做迁移+类型+`index.ts` 导出（接口不动，编译自洽）；M2 第一笔把接口三签名与 `deleteConversation` 双实现 + `ReopeningStorage` 转发一起落（export/backup 以显式 `throw new Error("Not implemented")` 占位，同笔内被 M3/M4 替换——占位在 CHANGELOG 不宣传）；或者 M2 直接三方法全实现一次到位。取后者则 M2/M3/M4 合并为单笔大提交，不利于回归定位，**推荐前者**。

---

## 6. 风险登记簿

| # | 风险 | 评估 | 缓解 |
| --- | --- | --- | --- |
| R1 | `durable_metadata.deleted_conversations` 列无界增长（singleton 行追加事件） | 每事件 ~200B；万次删除 ~2MB，且不进 commit 读路径（显式列清单），实际影响低 | 计划内接受；P2 逃生舱：迁往独立审计表（迁移 v4，一次性搬移）；写入 CHANGELOG 已知边界 |
| R2 | ancestry 硬化改变可观察行为（崩溃 → 明确语义） | 现行为是 `TypeError`，非任何调用方依赖的契约 | 独立 `fix` 提交 + C4 回归锁死 + CHANGELOG 明记 |
| R3 | 删除时活 Session 的文档缓存陈旧（`session.ts:61`） | storage 层删行不通知 Session；快照/watch 继续吃缓存直到逐出 | P1 范围内：doc comment + ops manual 写明调用时机（独占打开或 `unloadDocuments()` 后）；Session 层接线留 P2（§7） |
| R4 | export 大会话全量驻内存（string[]） | 10 万 entries ≈ 数百 MB 级风险存在 | P1 接受（产品路径尚无此量级调用方）；P2 导入/CLI 时加流式变体（§7） |
| R5 | export 快照持 `BEGIN IMMEDIATE` 写预约锁 | 与 `document()` 既有先例同等代价；快照期间阻塞同库写 | 接受；若实测成为问题，P2 给适配器加只读事务通道（改 `database.ts`，超出本批） |
| R6 | `VACUUM INTO` 与进程外连接的文件锁 | 备份期间进程外写者等待（busy 5000ms 后报错） | 透传 SQLite 语义；ops manual §3.4 写明"备份窗口内避免外部写" |
| R7 | ~~MemoryStorage 引入 Node 绑定（`node:fs/promises` 顶层 import）~~ 已消解（实施修订）：改为拒绝语义 | 包根运行时边界（`test/storage-runtime-boundary.test.ts`）机械禁止根导出图内 Node 导入 | 已按边界实现；CHANGELOG 记录拒绝语义（§0.5） |
| R8 | owned children 的 owner 边悬挂（D15） | 子会话功能等价 ownerless；subtree abort/图视图不再可达该边 | doc comment + ops manual；若实测图视图出问题，P2 补"清边"或级联选项（§7） |
| R9 | 审计事件 `deletedAt` 用 `Date.now()` | 测试不可复现具体值 | 断言只测 `> 0` 与单调性，不断具体值（C1/S1 已按此写） |

---

## 7. 开放问题（P2 候选，均不阻塞本批）

1. **导入**（import）：ID 冲突策略（重 mint vs 保号合并）、按 header `schemaVersion` 拒收或迁移；本期只导不入（D7）。
2. **审计查询 API**：`scanDeletionAudits()` 之类的公开读面；P1 用裸 SQL（S1）与返回值（C1）覆盖。
3. **Session/Harness 层接线**：`Harness.deleteConversation`（先 waitForIdle + 卸载缓存再下沉 storage）；解决 R3 的正规路径。
4. **流式 export**：`AsyncIterable<string>` 变体，服务 CLI 与超大会话（R4）。
5. **backup 的项目级子集**：VACUUM INTO 是文件级；"只备一个 project"需要先复制行到新库，另立项。
6. **owned children 处置**（R8 后续）：级联选项或 owner 边清理。
7. **审计迁独立表**（R1 逃生舱）：迁移 v4 一次性搬移。

---

## 8. 与已批摘要的差异对照（审阅用速查）

| 摘要条款 | 本文档 | 性质 |
| --- | --- | --- |
| `deleteConversation … Promise<boolean>`（§2.2） | `Promise<ConversationDeletion \| undefined>`（D11） | 签名细化（审计可测） |
| 审计 `{conversationId, deletedAt}`（§2.7） | 事件加 `v/projectId/counts`（D21） | 字段补充（文件级 singleton 需 project 维度） |
| "本项无 migration"（§2.7） | 迁移 v3，仅 `durable_metadata` 一列（D10/F2） | 矛盾修正 |
| "ancestry 断链在读取侧已有处理"（§2.3） | 需 M2 硬化五处（F1） | 事实修正 |
| 级联清单缺 task-scope 文档（§2.3 表） | 谓词补 `scope_kind='task' AND owner_id IN (会话 tasks)`（F3） | 补漏 |
| export 行 = header+entries+docs（§2.4） | + task/submission 行（D13） | 用户拍板扩展 |
| backup "事务内 VACUUM INTO"（§2.5） | **事务外**单语句（§1.8 实测：事务内报错） | 事实修正 |
| Memory backup 写 JSON 投影（§2.7/D8） | 拒绝：包根零 Node 导入边界不可破（实施修订，§0.5） | 机械约束修正 |
