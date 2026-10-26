# 正文、存储与性能

[返回 CLI README](../README.md)

## 工具正文：默认 `full` 原文

当前源码中，`scry init` 和省略 `capture.toolOutput` 的配置默认使用 `full`，记录原始工具 input/output，不再脱敏。旧配置的 `full-redacted` 作为迁移别名解析为 `full`，**不再表示保密承诺**。历史已脱敏内容及标记保留，不尝试恢复。此变更需构建/安装当前源码后生效，不改变已发布的旧版 CLI。

> ⚠️ 原文可能包含密钥、令牌、Cookie 和私钥，会进入 `.scry`、App archive/SQLite、备份及已配置的 uploader。分享/上传前必须自行检查。支持包和认证诊断的防泄露规则不因此移除。

以下是默认生效值：

```json
{
  "toolOutput": "full",
  "toolContentFieldBytes": 8192,
  "toolContentTurnBytes": 131072
}
```

- 已有配置中**显式**设置的 `none/summary` 继续生效，重复 `init` 不覆盖；旧版自动生成的 `summary` 与用户选择无法可靠区分，不根据猜测迁移。无 `scry.config.json` 的工作区仍不自动启用 recorder。
- 同时保存 `inputContent` / `outputContent`，不再把 `outputSummary` 当作全文。摘要从保留的原文生成。正文可能是字符串、JSON 或截断的 JSON 文本片段；只有 `encoding: "json"` 可按完整 JSON 解析。
- 单字段默认 8 KiB、最大 64 KiB；最终轮次记录新增正文合计默认 128 KiB、最大 1 MiB。按 UTF-8 字节裁剪，不截坏字符。预算按稳定调用顺序分配，input 在 output 之前；这只是 inline 预览预算，不是整个 `.scry` 的磁盘配额；完整正文另存 `.scry/content/sha256/` 并通过 `contentRef` 引用，事件暂存、archive、队列也有各自副本。
- 每个字段包含 `content`（省略时不存在）、`encoding`、`savedBytes`、`source`、`sourceCompleteness`、`redaction`、`storage`、`reasons`。`sourceCompleteness: "unknown"` 表示上游没有完整性承诺；`storage: "complete"` 只表示完整保存了当前收到的值，**不证明 Provider 原始输出完整**。
- 新采集的 `redaction` 为 `disabled`；历史 `applied/unchanged/failed/not_run` 仍可读取。旧版 reader 可能拒绝新增状态/原因，读取新记录时应同步升级 App、CLI 和下游消费方。原因区分 `provider_missing`、`source_truncated`、`field_budget`、`turn_budget`、`serialization_failed`、`not_collected`，历史 `redaction_failed` 保留。上游裁剪仍标 partial，不能从旧摘要恢复全文。
- 原文保留不取消结构安全：循环引用、accessor、自定义对象等无法安全序列化的值记为 omitted + `serialization_failed`，不调用 payload 的 getter/toJSON。字符串不因看起来像 JSON、URL 或 form 而被重排或替换。
- App 原始 transcript 镜像允许继续写入，但仍先校验 workspace/session 身份和受管路径。关闭脱敏不改变文件授权、trust gate 或 renderer 隔离。
- 普通轮次及 managed 恢复工件保留字节预算；旧 `full-redacted` 重试也不再对新内容脱敏，但已有正文的历史 provenance 不变。不要在活跃轮次中移动/删除配置或更换 dataDir。
- 外围上传端必须透传这两个新字段，看板需要展示正文及完整性状态；ACK 只证明接收成功。Scry CLI 不实现远端看板，也不负责外围多 active workspace 的 session 唯一绑定。

深工作目录（包括显式过长的 `SCRY_RECORDER_SOCKET`）自动映射为工作区/endpoint 哈希短路径；临时目录本身过长时回退 `/tmp`。路径按字节限制为不超过 100 字节，保留原有 daemon 所有权校验。

## 性能与资源

hook 在 Provider 每个生命周期事件上同步执行,所以这条路径的成本直接决定你是否感觉到卡顿。daemon 已运行时,hook 脚本用 `curl --unix-socket` 直投,省掉每事件一次 Node 启动;daemon 不在、`curl` 缺失、`SCRY_RECORDER_TRANSPORT=direct` 或 HTTP 状态码非 200 时自动回退到 CLI —— stdin 会先读进变量再投递,保证回退能重发,不丢事件。

实测基线(macOS / Apple silicon,单个 git 进程约 75ms,取 3–7 次中位数):

| 场景 | 快路径 | 回退到 CLI 自己落盘 | 提速 |
|---|---|---|---|
| 单个工具事件 | **108ms** | 550ms | 80% |
| 轮次起始事件(含 git 基线) | **874ms** | 1232ms | 29% |
| 一轮 · 5 次工具调用 | **2.60s** | 8.22s | 68% |
| 一轮 · 30 次工具调用 | **8.00s** | 34.56s | 77% |

轮次起始只快 29%,因为它的成本主要不是进程启动,而是 git 基线快照:

| `beginGitTurnDiff` | p50 |
|---|---|
| 干净工作树 | 335ms |
| 3 个未跟踪小文件 | 722ms |
| 300 个小文件 | 962ms |
| 一个 50 MB 未跟踪文件 | 1004ms |

`npm run bench:git-diff` 可复现这张表(信息用途,不是门禁)。仓库数量会线性放大这一项:壳仓库套 15 个子仓库时,`begin` 并行后仍需 1.6–2.0s。

- **CPU**:daemon 静置几乎不占 CPU(30 秒窗口 CPU time 增量 <0.2s;20 个进行中轮次约 1.3% 单核)。
- **内存**:单 daemon 启动后 RSS 约 71 MB,静置 30 秒回落到 64 MB。GC 后堆稳定(40 轮只留 1.7 MB),不是泄漏;RSS 不归还属 V8 高水位。
- **daemon 是每 workspace 一个,没有全局上限** —— 并行多个 worktree 时占用会叠加,只在需要采集的 worktree 执行 `init`。

不想要常驻进程:`export SCRY_RECORDER_TRANSPORT=direct`(行为等价,更慢)。

存量 workspace 升级 CLI 后需要重新生成 hook 脚本才能拿到快路径:`scry integrations repair --yes`(不做也不会错,只是慢)。

## 容量与归档

`.scry/records/` 是 append-only 事实源:一轮一个 JSON,文件名带 20 位序号且必须连续。

| 轮次形态 | 大小 |
|---|---|
| 只有 prompt,无工具无 diff | 2.6 KB |
| 5 次 Edit + 5 文件 diff | 6.6–9.9 KB |

存储量取决于实际采集的原文和 diff，不能按 inline 预算估算总磁盘占用。默认 `full` 的单轮工具正文 inline 预算为 128 KiB（可配置到 1 MiB），但 `contentRef` 指向的完整正文不受此预览预算限制；diff patch 不再设置单文件或单轮容量上限，另有元数据、归档和恢复副本。显式 `summary` 仍只保存输出摘要，单次 input 超 8 KiB 会省略并标 `partial`。

可选的 `storage` 配置提供软 quota、retention 候选和孤立文件宽限期：

```json
{ "storage": { "maxBytes": 10737418240, "retentionDays": 90, "orphanGraceHours": 24 } }
```

`maxBytes` 不会通过丢弃引用中的证据强行达标；超过时 maintenance 退出 3 并报告 `overQuotaBytes`。`retentionDays` 只列出候选，仍由 `records archive` 执行可校验的连续前缀归档。孤立 blob/遗留 `.tmp` 必须超过宽限期才可回收。存在 open turn、未完成 archive journal、其他 recorder lock 或近期 temp 时 maintenance fail closed，`--apply` 也不删除。

> ⚠️ **不要手动删除单个 record 文件。** 序号空洞会被 `turns verify` 与 `doctor` 判为 store 损坏(退出 4),而不是"已清理"。

```bash
scry records maintain --workspace "$PWD"                     # 只打印 GC/quota/retention 计划
scry records maintain --apply --workspace "$PWD"             # 回收确认孤立的正文/temp，gzip 轮转日志
scry records archive --before 30d --workspace "$PWD"          # 只打印归档计划
scry records archive --before 30d --yes --workspace "$PWD"    # 执行
```

归档把**连续前缀**搬到 `.scry/archive/<cutoff>/`(可用 `--out` 指定),写出带 sha256 的 `manifest.json`,并把 floor 记进 `archive-state.json`。`--out` 不得与 live `.scry/records/` 重叠；归档和新 record 的序号分配使用同一把锁，避免并发复用序号。跨文件系统复制通过 `.scry/archive-journal.json` 先记账、同步目标文件后再删除 source；中断后用同一个 `--out` 重试会校验 hash 并继续，journal 未收敛前禁止分配新序号。首次执行时 archive target 必须为空，避免覆盖旧 manifest。只有被 floor 解释的空洞才被接受,新轮次从 `floor + 1` 继续编号。配置了 commit hook 时,归档拒绝搬走未 ACK 的记录(退出 5),提示先 `notify-drain`;确实要放弃投递才用 `--force`。

在 uploader 完成“ACK 前接管完整正文”（U1）以前，归档前必须人工确认 uploader outbox 已覆盖待归档记录；只有通知任务或 recordId 入队不够。即使已有 outbox 副本，旧 uploader 若仍回源校验，归档也可能阻止上传，应先完成其 U2 校验改造或确认上传完成。recorder 的 ACK 不是远端上传成功证明。

归档目前不会自动清理 `record-environments/<recordId>.json`，其中可能有上传 URL 等敏感值。确认对应记录已完成投递、无需重放且已有必要备份后，维护者应按 recordId 手动清理；不要把这些旁路文件加入公开归档或排障材料。通知重试/死信与成功凭据也不随 record 归档自动删除，不要删除仍阻塞 ACK 的证据。

同一 recorder 进程内的 `turns list`、状态与投递 drain 会复用由 records 目录 stamp 校验的可丢弃索引；正式记录与 `archive-state.json` 仍是唯一事实源，`turns verify` 始终绕过索引全量校验。
