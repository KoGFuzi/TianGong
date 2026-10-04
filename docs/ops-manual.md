# TianGong 实地部署运维手册

版本：V1（`2.0.1`）
适用范围：`@OnePanda-TgSec/tg-ai`、`@OnePanda-TgSec/tg-gibraltar`
更新日期：2026-10-04

本手册只写已经过测试或在本仓库内验证过的行为。凡本手册与代码不符，以代码为准，并请回报，因为那是本手册的缺陷。

---

## 1. 运行前提

| 依赖 | 最低版本 | 用途 |
| --- | --- | --- |
| Bun | 1.4.0 | 包管理、脚本编排、运行时 |
| Node.js | 22.19.0 | `tsc` 生成 `.d.ts`；`node:sqlite`；`packages/tui` 的 `node:test` 套件 |

SQLite 由 Node 22.19+ 内建的 `node:sqlite` 提供，无需另行安装。

---

## 2. XDG 五根目录布局

TianGong 按 XDG Base Directory 规范拆分五个根，每个根下各建一个 `TianGong` 目录。这与 `opencode` 的布局方式一致：一个产品目录对应一个根，目录内容只放该根职责范围内的东西。

| 根目录 | 默认路径 | 存放内容 | 覆盖变量 | XDG 变量 |
| --- | --- | --- | --- | --- |
| data | `~/.local/share/TianGong` | 凭据、会话数据库、快照、日志 | `TIANGONG_DATA_DIR` | `XDG_DATA_HOME` |
| config | `~/.config/TianGong` | 用户手工撰写的设置 | `TIANGONG_CONFIG_DIR` | `XDG_CONFIG_HOME` |
| state | `~/.local/state/TianGong` | 锁文件等短生命周期状态 | `TIANGONG_STATE_DIR` | `XDG_STATE_HOME` |
| cache | `~/.cache/TianGong` | 可丢弃缓存 | `TIANGONG_CACHE_DIR` | `XDG_CACHE_HOME` |
| tmp | `os.tmpdir()/TianGong` | 临时文件 | 无 | 无 |

data 目录下的两个关键文件：

```text
~/.local/share/TianGong/
├── auth.json        tg-ai login 写入的 provider 凭据
└── session.sqlite   默认会话数据库
```

**凭据为什么在 data 而不在 config**：`auth.json` 是程序运行时生成的状态，不是用户手写的配置。`opencode` 把自己的 `auth.json` 放在 data 根，TianGong 与其一致。排查权限问题时请检查 data 目录，而不是 config。

### 2.1 路径解析规则

按优先级从高到低：

1. `$TIANGONG_<root>_DIR` 为非空**绝对路径** → `$TIANGONG_<root>_DIR/TianGong`
2. `$XDG_<root>_HOME` 为非空且不以 `/` 结尾 → `$XDG_<root>_HOME/TianGong`
3. `$XDG_<root>_HOME` 以 `/` 结尾 → 去掉尾斜杠后拼接
4. 都未设置 → `~/<xdg-fallback>/TianGong`（data=`.local/share`、config=`.config`、state=`.local/state`、cache=`.cache`）

### 2.2 覆盖变量必须是绝对路径

相对路径的覆盖值**会被拒绝**，不会静默落到当前工作目录下。宁可失败，也不要把会话库写进一个随启动目录漂移的位置。

### 2.3 程序化读取路径

```typescript
import { tiangongConfigPath, tiangongDataDir, tiangongDataPath, tiangongSessionDbPath } from "@OnePanda-TgSec/tg-ai";

tiangongSessionDbPath();     // ~/.local/share/TianGong/session.sqlite
tiangongDataDir();           // ~/.local/share/TianGong
tiangongDataPath("auth.json");
tiangongConfigPath("settings.json");
```

---

## 3. 会话存储

SQLite 是唯一的生产存储后端。`MemoryStorage` 仅用于测试，不落盘。

### 3.1 打开方式

```typescript
import { openDefaultSqliteStorage, openNodeSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";

// 开箱即用：不带路径，落到默认位置
const storage = await openDefaultSqliteStorage();
storage.project; // "default"

// 显式指定文件 + 项目隔离
const scoped = await openNodeSqliteStorage("/var/lib/tiangong/acme.sqlite", { project: "acme" });
scoped.project; // "acme"
```

`openDefaultSqliteStorage()` 的路径可由环境变量改写：

- `$TIANGONG_SESSION_DB` 改默认**文件名**（如 `acme.sqlite`）
- `$TIANGONG_DATA_DIR` 搬整个 data 根

### 3.2 project_id 隔离

每一行都带 `project_id`，每一次读都按它过滤。因此**同一个数据库文件可以承载多个项目**，互相看不见对方的会话、条目、任务与提交。

已验证的行为：

- 项目 A 写入的 conversation，项目 B 读到 `undefined`
- 项目 B 的 `scanConversations` 返回空数组、无游标
- 项目 B 的 `entry(id)`（全局查找）返回 `undefined`
- 项目 B 的 `scanEntries`（按会话查找）抛出 `Unknown conversation`，而不是返回空 —— 会话本身不可见时这是明确报错，不是静默空结果
- `project: ""` 在打开时被拒绝，抛出 `must not be empty`
- 相同 project id 的两次打开能读到对方的行

迁移行为：schema version 2 会把隔离机制引入**之前**写入的行全部归入 `"default"`，因此升级后无需手动处理存量数据。

### 3.3 WAL 与崩溃语义

连接建立时应用的 PRAGMA：

```text
PRAGMA journal_mode = WAL            写不阻塞读；崩溃后事务要么完整要么不存在
PRAGMA synchronous = NORMAL          提交在进程崩溃后存活；断电或宿主机故障可能丢最新一笔
PRAGMA wal_autocheckpoint = 1000     默认阈值，可调
PRAGMA foreign_keys = ON
PRAGMA wal_checkpoint(PASSIVE)       打开时执行，把 WAL 限制在有界范围内
```

关闭时执行 `PRAGMA wal_checkpoint(TRUNCATE)`，把日志交还给文件系统。

**若断电不可接受**，`synchronous` 需要更高等级。这是 SQLite 的语义而非本适配器的选择；改动前请先阅读 SQLite 官方文档中 `synchronous` 一节。

---

## 4. 健康检查

`storage.health()` 从连接**回读**实际配置，报告的是数据库此刻的真实状态，而不是适配器启动时打算配置的值。

```typescript
const health = await storage.health();
// {
//   ok: true,
//   integrity: "ok",
//   schemaVersion: 2,
//   journalMode: "wal",
//   synchronous: 1,
//   walAutoCheckpointPages: 1000,
//   busyTimeoutMs: 5000,
// }
```

字段说明：

| 字段 | 含义 | 异常时 |
| --- | --- | --- |
| `ok` | `integrity_check` 结果为 `ok` | `false` |
| `integrity` | `PRAGMA integrity_check` 原始返回值 | 非 `ok` 的具体错误串；后端不支持时为 `"unsupported"` |
| `schemaVersion` | `durable_schema` 记录的版本 | **0 表示尚未执行任何迁移**，属正常状态而非故障 |
| `journalMode` | 实际生效的 journal 模式 | 非 `wal` |
| `synchronous` | `PRAGMA synchronous` 的数值 | `1` 才是 `NORMAL` |
| `walAutoCheckpointPages` | 实际生效的自动检查点阈值 | `0` 表示已禁用 |
| `busyTimeoutMs` | 实际生效的锁等待超时 | `0` 表示 SQLite 默认值 |

### 4.1 调用示例：定时健康探测

```typescript
import { openDefaultSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";

const storage = await openDefaultSqliteStorage();

setInterval(async () => {
	const health = await storage.health();
	if (!health.ok) {
		// integrity 非 ok 意味着文件损坏；此时应停止写入并告警，而不是继续提交。
		console.error("storage integrity failure:", health.integrity);
		return;
	}
	if (health.journalMode !== "wal") {
		console.error("journal mode regressed:", health.journalMode);
	}
	if (health.schemaVersion < 2) {
		console.warn("schema below project isolation:", health.schemaVersion);
	}
}, 60_000);
```

### 4.2 调用示例：部署后自检

部署完成后立即执行一次，把结果写进启动日志：

```typescript
const health = await storage.health();
console.log(`storage ready: integrity=${health.integrity} schema=${health.schemaVersion} journal=${health.journalMode}`);
if (!health.ok) process.exit(1);
```

### 4.3 手动回收 WAL

```typescript
await storage.checkpoint(); // wal_checkpoint(TRUNCATE)
```

任意时刻调用均安全。批量导入、长事务之后调用，可把 `session.sqlite-wal` 缩回零，避免日志文件无界增长。

### 4.4 连接参数调优

```typescript
const storage = await openNodeSqliteStorage(path, {
	busyTimeoutMs: 250,          // SQLite 默认 0；适配器默认 5000
	walAutoCheckpointPages: 64,  // 默认 1000；0 = 禁用
});
```

传什么读什么 —— `health()` 会回显实际值，用来自检配置是否生效。

---

## 5. 环境变量

### 5.1 路径类

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `TIANGONG_DATA_DIR` | 覆盖 data 根（需绝对路径） | `~/.local/share/TianGong` |
| `TIANGONG_CONFIG_DIR` | 覆盖 config 根（需绝对路径） | `~/.config/TianGong` |
| `TIANGONG_STATE_DIR` | 覆盖 state 根（需绝对路径） | `~/.local/state/TianGong` |
| `TIANGONG_CACHE_DIR` | 覆盖 cache 根（需绝对路径） | `~/.cache/TianGong` |
| `TIANGONG_SESSION_DB` | 覆盖默认会话库**文件名** | `session.sqlite` |
| `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` | 各 XDG 根 | XDG 规范默认值 |

优先级：`$TIANGONG_*_DIR` > `$XDG_*_HOME` > 规范默认值。

### 5.2 模型与鉴权类

| 变量 | 读取方 | 作用 |
| --- | --- | --- |
| `TG_CACHE_RETENTION` | `tg-ai` | 设为 `long` 时选择长生命周期 prompt cache |
| `TG_OAUTH_CALLBACK_HOST` | `tg-ai` | 本地 OAuth 回调监听绑定的主机 |
| `TG_TUI_WRITE_LOG` | `tg-tui` | 捕获写到 stdout 的原始 ANSI 流 |
| `TG_TUI_DEBUG` / `TG_TUI_DEBUG_REDRAW` | `tg-tui` | 主屏调试输出 / 全量重绘追踪 |
| `TG_TUI_ESC_TIMEOUT` | `tg-tui` | 转义序列消歧窗口，毫秒 |
| `TG_TRUE_COLOR` / `TG_HYPERLINKS` / `TG_IMAGE_PROTOCOL` | `tg-tui` | 终端能力覆写 |

---

## 6. API Key 鉴权

`@OnePanda-TgSec/tg-ai` 的 `./auth` 提供 Bearer Key 鉴权。

### 6.1 生成与存储

```typescript
import { generateApiKey, hashApiKey } from "@OnePanda-TgSec/tg-ai";

const key = generateApiKey();       // tg_<base64url>
const stored = hashApiKey(key);     // SHA-256 hex，落库存这个，不要存明文
```

**库泄漏不泄密钥**：存储侧只持有哈希。校验时把**明文 key** 与**存下的哈希**传给 `verifyApiKey`，由它把前者哈希成相同摘要再比较。

### 6.2 校验请求

```typescript
import { ApiKeyAuthenticator, verifyApiKey } from "@OnePanda-TgSec/tg-ai";

const authenticator = new ApiKeyAuthenticator((presented) =>
	verifyApiKey(presented, storedHash) ? "acme" : undefined,
);

const result = await authenticator.authenticate(request);
if (!result.ok) {
	// result.code: "missing_credentials" | "invalid_key"
	// result.message: 粗粒度描述，不区分具体是哪一把 key
	return;
}
result.providerId; // "acme"
```

### 6.3 接受的入参形态（三种，全部保留）

| 形态 | 来源 | `Authorization` 读取方式 |
| --- | --- | --- |
| `{ headers: Headers }` | fetch `Request` | `headers.get()`，大小写不敏感 |
| `{ headers: plainRecord }` | **node `IncomingMessage`**、Express、Fastify 等主流 Node 框架 | 大小写不敏感遍历 |
| `Headers` 直接传入 | 已有 `Headers` 的调用方 | `headers.get()` |
| 顶层 plain record | 已自行归一化 headers 的服务 | 大小写不敏感遍历 |

**`IncomingMessage` / record 分支是刻意保留的，不可移除。** 原因已在源码注释中写明：

- node 的 `http.createServer` 交付的 `IncomingMessage.headers` 是**纯 record**，键名小写，**没有 `get()` 方法**（已用真实 HTTP 服务实测确认）
- `Object.entries(new Headers())` 返回**空数组**，所以 `Headers` 对象不能当作 record 处理，必须有独立分支
- 移除 record 分支会直接导致所有 Express / Fastify / 原生 `http.createServer` 调用方无法鉴权

### 6.4 失败语义（刻意粗粒度）

- 未呈现凭据（无 header、非 Bearer scheme、空凭据）→ `missing_credentials`
- 有凭据但不匹配 → `invalid_key`
- 结果中**不包含**任何能区分具体 key 的信息，也不区分「key 未知」与「key 存在但形态不对」

### 6.5 端到端行为（已测试验证）

```text
POST /   Authorization: Bearer <有效key>   → 200 { ok: true, providerId: "groq" }
POST /   Authorization: Bearer <无效key>   → 401 { ok: false, code: "invalid_key" }
POST /   Authorization: <缺失>             → 401 { ok: false, code: "missing_credentials" }
```

---

## 7. 运维排障清单

| 症状 | 排查方向 |
| --- | --- |
| `schemaVersion` 为 0 | 尚未执行任何迁移。用 `openDefaultSqliteStorage()` 或 `openNodeSqliteStorage()` 打开即会触发迁移 |
| `schemaVersion` 高于代码支持版本 | 存量库比当前代码新。先升级代码 |
| `journalMode` 不是 `wal` | 连接建立时 PRAGMA 未生效。检查文件系统是否支持 WAL（如网络文件系统不支持） |
| `synchronous` 不是 `1` | 有其他连接改过该 pragma；本适配器每次打开都会重设 |
| `busyTimeoutMs` 为 0 | 打开时未传 `busyTimeoutMs`，落到 SQLite 默认值 |
| `integrity` 非 `ok` | **立即停止写入**，备份文件，然后用 `sqlite3 <file> ".recover"` 处理 |
| `-wal` 文件持续增长 | 长事务未提交，或 autocheckpoint 被设为 0。调用 `storage.checkpoint()` |
| 打开时报 `must not be empty` | `project` 传了空字符串 |
| 凭据读不到 | 检查 data 根（`~/.local/share/TianGong/auth.json`），**不是** config 根 |
| `401 invalid_key` 但确认 key 正确 | 存储侧存的是明文 key 而非 `hashApiKey(key)` 的返回值 |

---

## 8. 升级与回滚

1. 升级前完整备份 data 根，包括 `session.sqlite`、`-wal`、`-shm` 三个文件
2. 停止所有持有该存储的进程（单进程独占存储，无跨进程锁）
3. 升级代码，重新启动；迁移在打开时自动执行
4. 启动后立即执行第 4.2 节自检，确认 `schemaVersion` 达到预期且 `integrity` 为 `ok`

**回滚**：schema 版本只前进不后退。`durable_schema` 版本高于代码支持版本时，打开会直接报错并拒绝，防止降级代码写过新 schema。回滚前先恢复备份文件。

---

## 9. 交付范围说明（V1）

**已交付**：SQLite 唯一生产源、`project_id` 隔离、开箱即用默认路径、基础 API Key 鉴权、WAL 调优、自动迁移、健康检查、启动自检、entry 数据模型与复杂事件流设计冻结。

**延后至 V2**：非核心闭环的优雅架构重构，包括会话共享与分享链接、多工作区/工作树模型、权限模型、事件流持久化、`synchronous` 等级提升、以及存储引擎的再扩展。

**明确不兼容项**：上游 `@earendil-works/pi-durable` 的 JSONL 存储无读取器；`tg.*` 持久化 kind 为一次性改名、无别名无迁移 shim，读取上游存储需先就地改写 kind 字符串。