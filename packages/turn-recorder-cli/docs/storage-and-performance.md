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

## 排除 diff 路径

`scry.config.json` 的 `capture.diffExclude` 是工作区级排除，值是相对工作区的路径：

```json
{ "capture": { "diffExclude": ["generated", "vendor/bundle"] } }
```

接入方（例如 CodeLens）还可以为**当前会话**声明排除路径：`recorder capture start` 的 context 携带 `diffExclude`（绝对路径数组）。它只对被声明的那次会话采集生效，随 capture 保存，`capture stop` 后失效；同一 capture 多次 start 只会并集，不会缩小。它不写入项目文件，也不改 `scry.config.json`。

排除按**每个仓库自己的根**换算，所以排除一个流程运行目录不会连带丢掉里面的代码仓库：那个仓库仍是自己的仓库，那条路径不在它的根之下，一个文件都不排除。声明的路径是当前仓库的祖先时同样无效。

被排除的文件既没有清单条目，也不读取正文。record 的 `diff.value[].diffExclude` 只记命中的声明路径和文件数（`paths`、`files`），diff 证据因此标 `partial` 并在 `omissionReason` 写明；匹配不到任何文件时不出现该字段。工具调用、prompt 与原始 transcript 不受影响。

需要 recorder 0.2.72 或更高版本；更早的版本接受 context 但会忽略这些路径。

## 多仓库覆盖与诊断

以下字段由包含本次可靠性改动的 CLI 写出；历史 record 不回填，缺少字段不能当作零。

- `diff.discovery.requestedRoots`：本轮发现并请求采集的目录清单，数组长度是该清单的数量，不是磁盘上的全部仓库数，也不保证每个目录已解析出有效 Git root。仅在发现阶段有证据时出现。
- `diff.discovery.maxDepth` 与 `depthLimitedDirectories`：本轮使用的深度上限、因该上限未继续下探的目录数。后者不是“漏掉的仓库数”。默认深度仍为 2，上限 5；排除目录及目录符号链接仍不下探。
- `diff.discovery.worktreeDiscovery`：所有者或结果触及上限、Git 查询失败时出现；`incomplete: true` 不代表工作区没有其他 worktree。查询最多 32 个已发现仓库，按排序分批、每批最多 4 个 Git 进程；每个所有者最多接纳 128 条工作区内结果，Git 查询共享 5 秒预算。越界和排除目录不进入采集范围。超过上限时应先将关键仓库作为独立 workspace；扩大预算前须测量完整 turn-start，而不是仅看目录扫描时间。
- `diff.value[]`：逐项查看 `status`（`captured` / `timeout` / `failed` / `unavailable`）及可用的 `reason`。`requestedRoot` 是已知请求目录；`repoRoot` 只在 Git 解析到它时提供。不同仓库即使同时结束也保留独立结果。
- 深度边界只作为 `discovery` 元数据保留，不单独改变 diff 的 status/quality 或增加 `omissionReason`。`available` 表示已纳入清单的快照可用，不证明磁盘上所有仓库都已采集。真实缺失证据仍按原规则降级并写原因；恢复时无法可信归因 diff，仍为 `unavailable`，不补造快照、耗时或成功状态。没有 `diff.value` 不等于发现了零个仓库。

`doctor` 的 `repositories.depth` 只额外查看 depth+1 一层，最多探测 32 个边界目录、128 个目录项。仅在实际发现 `.git` 时 warn、列出路径并提示调整 `repositories.maxDepth` / `repositories.exclude`。没有发现时 pass；即使探测不完整也不告警，但 detail 会明确说明上限或不可读，不能把 pass 当作已确认没有更深仓库。不会自动扩大采集范围。

`doctor` 和 `support-bundle` 的 `userHookSkips` 单独汇总 `${XDG_STATE_HOME:-$HOME/.local/state}/scry/hook-skip.log` 中的 `bridge_not_found`。其 `value.workspaceAttribution` 固定为 `unknown`：日志没有工作区身份，不能加到当前工作区的 `hookSkips` 或失败计数中。`hook.userBridgeSkips` 对非空、截断或不可用的窗口给出 warning，但不改变当前工作区退出码。缺失日志是已观察的空窗口，不证明 Provider 加载过 hook；不可读或受检路径为符号链接则为 `unavailable`，没有伪造的零值。

用户级汇总只读当前日志及 `.1`，各最多读取尾部 1 MiB，不旋转或重写日志。截断时为 `partial`；`count` 是可见保留窗口的行数，`recentCount` 包括近 24 小时及时间不明的行。bundle 不包含原始用户级日志或任意时间文本。OpenCode plugin 不使用 shell bootstrap 的 `bridge_not_found` 日志，不能据此假设 Provider 能力相同。

升级 CLI 后执行 `scry integrations repair --yes` 并重启 Provider，让旧 `provider-hook.sh` 也在入口清除继承的内部 daemon-attempt 标记。daemon 在线 curl 快路径没有新增进程。

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

- **CPU**：早期 30 秒小样本不足以覆盖长期 open + 大 transcript；0.2.75/0.2.76 会在 snapshot 命中前反复扫描 Codex anchor。0.2.77 将命中检查前置，不变文件不再重读；冷读、文件变化及独立子 transcript 仍须读取真实证据。
- **内存**:单 daemon 启动后 RSS 约 71 MB,静置 30 秒回落到 64 MB。GC 后堆稳定(40 轮只留 1.7 MB),不是泄漏;RSS 不归还属 V8 高水位。
- **daemon 是每 workspace 一个,没有全局上限** —— 并行多个 worktree 时占用会叠加,只在需要采集的 worktree 执行 `init`。

### 0.2.77：空闲恢复与退出

- 恢复等待仍按 1、2、4、8、15 秒退避；新 hook 重置等待。保留无 hook 的 transcript 终态恢复，不用静默伪造完成。
- daemon 只检查 attention 中的待处理会话，不再每 64 次轮询扫描整个历史。隔离轮次的 `.scry/quarantine-index/<provider>/<session>.json` 是可重建的候选索引（不写入会话目录），`turns/<补零 generation>/pending-open.json` 仍是事实源。先写索引，再写状态；初始化或扫描失败不发布“空索引”。
- 新安装/索引缺失时初始化；显式 `scry recorder recover` 每次重建发现索引。恢复备份或混用旧版直接写者后，应执行一次该命令；不要让旧版直接写者长期与新版 daemon 混用。该索引不替代事实文件，也不删除隔离证据。
- 无待恢复轮次时，默认 30 分钟无 hook 自动退出。状态查询不再延长寿命。仍有 open、队列或隔离证据时继续保活；长期等待工具/审批不是完成证据。更新检查期间收到新 hook 不会关闭该会话。
- 同一 socket 的直接 `serve` 也串行认领，避免两个进程互相 unlink；不自动清理此前已启动的旧版孤儿进程。检查存量进程时须核对 PID、工作区、版本和 owner，不按进程名批量杀进程。
- `scripts/recorder-daemon-cpu-bench.mjs` 提供 600 秒真实等待的隔离 L2 socket 基准。它计 daemon 与小型测试客户端所在进程的 user+system CPU，不含 Git 子进程、真实宿主或上传。历史目录只用合成数据，不改生产账本。

### 0.2.85：单个会话不可读不再中断整轮

- 恢复轮、健康统计、`staleOpenTurns` 列表和“是否还有 open turn”的判断都逐会话隔离。一个会话目录里出现非目录项（Finder 写的 `.DS_Store`、被文件占位的 `turns/`）或权限不足，只跳过这一个会话，其余会话照常处理，整轮不再是全有或全无。
- 只有“这个条目不是可读会话”的错误（`ENOTDIR`/`ENOENT`/`EACCES`/`EPERM`/`ELOOP`/`ENAMETOOLONG`）按可跳过处理。轮次内部的读错误（例如事件 `stat` 的 `EIO`）仍然直接失败：它可能改变结论，不能变成一次安静的跳过。
- 同一个会话连续 3 次失败后进入 suspended：不再每轮重试，改为每小时重探一次。转入时 `recorder.log` 留一行 `WARN session suspended after N failed passes`（0.2.89 起同一原因连续失败写 `... after N identical failed passes`），`health.json` 的 `suspendedSessions` 和 `scry status` 都会报出来。暂停只影响重试，不删标记、不改 `open.json`、不丢弃证据。0.2.89 起计数范围从“会话不可读”扩到任意转录读取/解析失败，并按会话与轮次分开记账：整轮 pass 正常完成才清，单条记录可读不会清掉另一条轮次的失败。
- 一次成功收尾会清掉该会话的失败记录，瞬时故障不会累积成 suspended。记录写在 `.scry/session-failures.json`（和 `health.json` 同级），是报告，不是事实源；删掉它只会让下一轮重新计数。

### 0.2.89：超大转录不再整份读入，同因失败不再每轮重试

0.2.89 起，transcript 的读取和定位都有字节上限；超过上限是一次带原因的截断，而不是一次会重试的异常。

- **窗口上限 64 MiB。** `readTranscriptWindow` 最多读 64 MiB（`TRANSCRIPT_WINDOW_LIMIT_BYTES`）。超限时只保留最新的 64 MiB，丢掉起点处的残缺行，其余照常解析。返回值带 `truncated` 和 `truncation: { reason: 'window_limit', requestedBytes, keptBytes, droppedBytes }`。
- **截断会进入记录，不静默。** 解析快照标 `complete: false`，原因写明保留和丢弃的大小。启用原始转录采集且能确认字节范围时，记录的 `transcript` 段标 `partial`，带 `value.sourceCompleteness: "partial"` 和 `omissionReason`。读取方看到的是“这一段没读到”，不是“这一轮什么都没发生”。
- **锚点扫描也有上限。** 反向扫描最多回看 64 MiB（`TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES`），单行最多在内存里保留 4 MiB（`TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES`），有记录的起点时只从起点前 8 MiB 开始（`TRANSCRIPT_ANCHOR_LOOKBACK_BYTES`）。超长行直接按记录正文丢弃，不再跨 chunk 反复 `concat`；NUL 字节按格式边界处理，不为了找锚点把稀疏前缀读进内存。找不到锚点时仍回退 byte 0，但读取本身受窗口上限约束。
- **Codex 的锚点缓存只复用轮次边界。** 同一个 `task_started` 轮次在后续 pass 里直接复用已定位的起点，只补扫新增字节。`user_message` 行只是反向扫描的提示，不会被当成新的轮次起点，否则窗口会从提问行开始、丢掉 `task_started`。
- **一次失败不再变成每轮重试。** 任意转录读取/解析失败（不只是“会话不可读”）现在都按“会话 + 轮次”记账；同一原因连续 3 次失败后挂起该会话，每小时重探一次，`recorder.log` 留 `WARN session suspended after 3 identical failed passes`，`health.json` 的 `suspendedSessions` 和 `scry status` 会报出来。整轮 pass 正常完成才清记录，`open.json` 和证据保持原样。
- **`transcriptStartOffset` 记真实位置。** 轮次打开时记录当时 transcript 的字节长度；转录文件在轮次开始后才出现（或读不到）时记 `null` = 未知，不再用 `0` 冒充“从头开始”。这个值只是定位提示，不证明 Provider 从这个字节开始写本轮；恢复时找到的解析锚点不回填。

改动前后的实测数字（同一台机器、同一份 transcript，`stableTranscript` 单次调用）：

| 场景 | 0.2.88（旧） | 0.2.89 |
|---|---|---|
| 真实 Codex rollout 1.02 GB，轮次身份不可定位（窗口只能从 byte 0 起） | 读 1,027,213,094 字节，抛 `ERR_STRING_TOO_LONG`，无快照；maxRSS 0.8–1.0 GB | 读 67,371,008 字节，45 个事件 + 明确截断原因，`complete: false`；maxRSS 306 MB |
| 稀疏 1 GiB 转录（首部有真实行，其余为空洞），带 prompt hash 但无 turn id | 扫描 1,073,741,824 字节、CPU 444 秒、maxRSS 5.7–8.4 GB，最后仍抛 `ERR_STRING_TOO_LONG` | 扫描 67,108,864 字节、CPU 0.30 秒、maxRSS 168 MB，返回带原因的 partial 快照 |
| 40 MiB 会话，锚点在 38 MiB 处（正常大轮次） | 扫描 40,202,062 字节 / 493 ms，`complete: true` | 扫描 40,202,062 字节 / 489 ms，`complete: true`（无回退） |
| 同一 40 MiB 会话连续 3 个 pass，每轮追加 1 行 | 每轮重扫 40.2 MB：493 / 482 / 471 ms | 首轮 489 ms，其后 30 / 30 ms（只扫新增的 577 / 676 字节） |

已知限制：截断窗口里的证据只覆盖尾部 64 MiB；需要整轮完整正文时，仍然要等长期方案（持久行索引 + 增量解析器），见 `docs/research/native-console-optimization.md`。上限是常量，不按 Provider 或工作区配置；调整前应先测完整 turn-start，而不是只看单次读取耗时。

### 0.2.88：多仓库工作区的位置信息不再时有时无

- 症状：45 个仓库的工作区里，同一会话、同一版本的轮次，diff 条目的 `repositoryLocation` 时有时无，出现时通常只挂在一条上，每轮挂哪个仓库不固定，有时只剩 `branchAfter`/`commitAfter`。
- 主因是**启动采样的 32 并发上限**，不是那个 50 毫秒截止：`sampleGitRepositoryLocation` 在 `pending >= 32` 时连读都不启动，直接返回空快照。一轮 41–45 个捕获同时采样时，超出部分整段丢；端采样的 `branchAfter`/`commitAfter` 走同一个计数器，所以也一起丢——这就是“什么都没有”的那一类。本机 39 个仓库的实测：39 并发时 22.2% 为空，只跑 32 个（不触发上限）降到 5.0%；超过上限的那 7 个正好是 17.9%。
- 第二个原因：远端（`includeOrigin`）只在轮次开始采样时读，结束只读头指针。开始那次没读到，`remote` 就没有第二次机会。
- 第三个原因：`commitBefore` 和 `branch` 其实已经在手里——同一个 capture 的 `git status --porcelain=v2 --branch` 已经给出 `# branch.oid` 和 `# branch.head`，只是没写进证据。实测缺位置的样本里 94% 只差 `remote` 一项。
- 现在：收尾只对**这一轮真正改动过**的仓库补读一次远端（专用小并发池 8，不共用那个 32 上限）；`commitBefore`/`branch` 直接取开始时那次 status 的结果，分离头指针写 `null`。到顶就放弃并写状态，不延长宿主的 Stop。
- 预算是**整轮共用一个截止时间**（`REPOSITORY_REMOTE_RETRY.turnMs = 500`，由 `collectTurnDiffs` 算一次后经 `locationRetryDeadline` 传给每个仓库的收尾），单仓库读上限 250 ms。所以最坏情况下 Stop 钩子最多多等 500 毫秒，与仓库数量无关；不是“每个仓库各自 500 毫秒”。
- 已经开始采样就确认了 `absent`/`unsupported` 的仓库不再补读：那是关于这个仓库的事实，不是没取到。
- 状态描述的是**这条记录最终带着的值**，不是采样时的中间状态：回填之后有值就是 `observed`（分支为 `null` 是 `detached`），没值才退回采样给的状态，都没有就是 `unavailable`。这样“50 毫秒采样没赶上、随后由 status 数据补上”这种最常见的情形不会出现“值有了、状态却说没读到”。
- 一条记录最多保留 32 个仓库的位置，**有改动的仓库先占名额**，剩下的按出现顺序给没改动的；超过名额的条目不带位置。没有改动、三个状态又都是 `unavailable` 的条目直接不带位置（那是“没读”，不是证据），省体积也不占名额。
- 位置字段带上三个状态，不再靠省略键表达：`remoteStatus`（`observed`/`absent`/`unsupported`/`unavailable`）、`branchStatus`（`observed`/`detached`/`unavailable`）、`commitStatus`（`observed`/`unavailable`）。`absent` 是“config 读到了但没有 origin”，`unsupported` 是“有 origin 但不是可识别的身份（本地路径、token-only URL、本解析器不支持的续行写法）”，`unavailable` 才是“没读到”。本地路径形式的远端只记状态，不记路径本身。
- 读取方兼容：`repositoryLocation` 的校验走 `normalizeTurnRepositoryLocation`，只投影已知键、忽略未知键。本机实测旧校验器（桌面端自带 CLI 0.2.84、CodeLens 运行时 0.2.84、PATH 上的 `scry` 0.2.80）对“带三个状态键”和“只有状态键”的记录都是 accepted，所以这三个键不需要等任何读取方升级。
- 读取宽容 / 写入严格：读取时值不在定义的集合里就投影掉，不让整条记录失效；写入时 `commitRecord` 用 `invalidRepositoryLocationStatuses` 拒绝未定义取值（错误信息 `refusing to commit a record with undefined repository location statuses: …`）。
- 实测（本机 45 个仓库的临时工作区，端到端跑真实的 `beginGitTurnDiff`/`finishGitTurnDiff`，每轮 3 个仓库有改动）：

| | 改动仓库的位置完整 | 整轮收尾 p50 |
|---|---|---|
| 0.2.87（改动的仓库排在最后 3 个） | **3/18（16.7%）** | 2.4 s |
| 0.2.88（同一排列） | **18/18（100%）** | 2.3 s |

- 补读本身的成本（本机 39 个真实仓库、含远端）：单仓库 p50 0.5 ms、p95 1.0 ms、max 3.3 ms；40 个排队调用仍在 500 ms 上限内返回。整轮收尾的差异落在 git diff 自身的波动里（±300 ms），补读不构成可测增量。
- 记录体积（45 个仓库的同一轮，走真实 `aggregateTurnEvidence`）：0.2.87 只有 1/45 条带位置、位置字段合计 338 字节；0.2.88 有 32/45 条带位置、合计 **5,204 字节**（每条约 163 字节），也就是 45 仓库工作区每份记录多约 **4.9 KB**。32 是 `TURN_REPOSITORY_LOCATION_LIMITS.repositories` 的上限。
- 已知限制：没有改动的仓库仍然只有状态没有远端（按设计，不花第二次读）；跨轮缓存仓库身份、把 32 上限抬高都没做。

### 0.2.87：Codex 首轮用量不再把会话累计当成本轮

- Codex 的 `token_count` 帧是会话累计值，一轮的用量是相邻帧的差。差需要“这一轮开始前的累计”做基线，而按轮解析的窗口从本轮 `task_started` 开始，看不到上一帧。
- 以前找不到基线就把基线当 0：`没有基线` 和 `会话从 0 开始` 在代码里是同一个值。续写 rollout（`resume`/`fork`、同一会话的第二段文件）的首帧累计本来就已经很大，于是那一轮把整个会话累计写成了本轮用量。
- 现在按顺序取基线：① 同文件内前序累计帧（原逻辑，`CODEX_USAGE_BASELINE_BYTES` 窗口内最后一帧）；② 窗口首帧自带的 `last_token_usage`：`首帧累计 − 最近一次` 就是首帧之前的累计，前提是该帧同时带两组值且 `最近一次 ≤ 累计`；③ 两者都拿不到时，这一轮用量标 `unavailable`，只写固定句子 `USAGE_BASELINE_MISSING_REASON`，不写数字，**也不写 `omissionCodes`**：旧读取方和服务端的码表只认 diff 的码，一条带新码的记录会被整条拒收。新码在读取方宽容的版本铺开后再写：本机实测桌面端自带 CLI 0.2.84 与 CodeLens 运行时内置 0.2.84 的校验器都会把带该码的记录判成 `invalid turn record`，而它们的 hook 路径用 `listRecords` 全量解析，一条坏记录会让该工作区之后每个 hook 都失败（全局 CLI 0.2.8 的校验器宽松，不是瓶颈）。
- 真正从 0 开始的新会话（首帧累计等于最近一次）算出的基线就是 0，仍然按本轮算，不会被标未知。
- 实测（本机 2,223 个 rollout、803 个带累计帧的轮次）：input 合计 20.07b → 3.79b（5.3×），单轮最大 2.51b → 426.2M，值发生变化的只有 14 轮；每个文件都满足“逐轮差值 + 推导基线 = 文件末累计”。三个具体文件：2,514,734,962 → 465,004、550,229,534 → 2,843,638、2,450,973,309 → 23,925,566。
- 本机 14,801 个 `token_count` 帧全部同时带 `total_token_usage` 与 `last_token_usage`，五个计数齐全，也没有 `最近一次 > 累计` 的情况，所以第 ② 步在真实数据上总能成立；第 ③ 步只兜住残缺或手写的帧。
- 逐轮自检（每一轮的用量应等于这一轮内所有帧的 `last_token_usage` 之和，按解析器自己的相邻重复规则去重）：803 轮里 799 轮完全相等，4 轮不等。不去重时是 42 轮不等，多出的 38 轮都是同一份 `last_token_usage` 被连续重复广播——这也正是 `CodexUsageDeltaFilter` 存在的原因。剩下 4 轮：3 轮是某个 `token_count` 帧的累计没前进、`last` 却非零（少算一次请求，10.7 万–19.5 万）；1 轮是累计前进了 141,402 而该轮唯一的帧只写 `last` 73,177，差的 68,225 来自一次没有留下 `last` 帧的请求（归到了轮边界之外）。单轮可能把边界外的一次请求算进来，同时另一轮漏掉它，整份文件的总量仍然对得上，不会凭空增加。
- 已知限制：如果一轮的第一次请求没有留下用量帧，推导出的基线会把那次请求算在轮外，结果是少算一次请求，不会多算。
- 修后仍有 28 轮 >2000 万 input，全部来自真实的多请求轮次（20.2M–426.2M，中位 31.6M），其中最大那轮 426,209,277 是 1,702 次请求、单次 input 中位 254,174（最大 449,791），等于这些帧 `last_token_usage` 之和，没有累计重复。
- 历史记录不回填、不重传。已经写进 store 和已经上传的偏大值仍然存在，要单独处理。

### 0.2.86：记录摘要缓存（派生，可重建）

- 身份路径（给新会话分配 `generation`/`turnIndex`、判断某个 `providerTurnId` 是否已提交）只需要每份记录的五个字段：`provider`、`sessionId`、`generation`、`turnIndex`、`providerTurnId`。以前为这五个字段要解析整份记录，现在读 `.scry/records-summary.json`。
- 缓存按记录文件名（序号 + recordId）对齐：文件名列表与缓存不一致、文件缺失、JSON 损坏、字段不合规，一律丢弃重建成一次全量解析。全量解析遇到读不出来的记录仍按原样报错，不静默跳过。
- 写入方在 `commitRecord` 里追加一行；写缓存失败只丢缓存，不影响提交结果。缺缓存时的冷重建由第一个读者完成（守护进程启动时就会预热），之后不再全量解析。
- 记录仍是唯一事实源。原地改写已有记录不会被文件名对齐发现，所以未来任何改写记录字段的路径必须删掉该缓存；目前没有这样的路径：提交只追加、归档只把文件移出、`content-repair` 不改记录。
- 实测（3,000 条 × ~88 KB）：`listRecords()` 1,011 ms / 峰值 352 MiB；冷重建 925 ms / 79 MiB；热读 9 ms / 55 MiB。`npm run bench:record-summary` 复现，每个模式独立进程计峰值。

### 0.2.86：静默轮次改低频复查

- 一次 recovery pass 以前会把每个仍有 open 轮次的会话重新判一遍，包括那些结论不会再变、证据也没动过的会话。工作区里存在几十个陈旧轮次时，这份重复劳动是常驻 CPU 的主要来源。
- 现在：某次 pass 判过“仍然开着、且它自己的文件已经超过 stale 窗口没动静”的会话，会记住当时的文件指纹，之后**一小时**才复查一次；任何 hook 到达、或任何它读的文件发生变化（`open.json`、`session.json`、当前 generation 目录与 `events/`、`inbox/`、transcript），下一次 pass 立即恢复常规频率。
- 只改调度。不收尾轮次、不动 marker、不删证据；记录在内存里，进程重启后第一遍复查全部——偏向安全的一侧。
- 两类会话永不延迟：`open.json` 里记录了 `host` 进程的轮次（宿主退出不会改变任何文件，下一遍就能收尾），以及 managed 轮次（它们的恢复靠一条只在“循环看见了 managed 轮”时才跑的 pass）。
- 只对尚未收敛的会话生效：已收尾的会话不留记录；操作者用 `recover --session` 点名的会话永远照常复查。`--expire-open` 等显式动作不受影响。
- 实测（45 个陈旧会话，两个模式用同一个 `npm run bench:quiet-revisit`，`--mode=visit` 在每遍之间改 `open.json` 的 mtime，就是改动前“每遍重新判一遍”的行为）：
  - 合成 fixture（45 个会话，每轮 64 KB transcript）：整遍约 0.9 s → 约 0.2 s CPU（同机负载波动约 ±30%）。剩下的 0.2 s 里几乎全部是每遍结束时的 health 扫描（45 × 约 4 ms），与本节无关。
  - `rate-native` 工作区真实 `.scry` 的只读副本（1,120 个会话、3,212 条记录、其中 45 个陈旧轮次、2 个 managed 轮次）：陈旧轮次这部分每遍 401–702 ms CPU → 21–29 ms CPU（约 19 倍）。
  - 同一副本上整遍仍要 3–5 s CPU，因为大头不在这里：managed 恢复（2 个会话，约 3.1 s）与每遍 health 扫描（约 0.24 s）。前者正是摘要缓存（上面 0.2.86 第一节）要解决的问题。
  - 结论：本节只降低“重复判静默会话”那一份；工作区里没有陈旧轮次时它什么也不省。

不想要常驻进程:`export SCRY_RECORDER_TRANSPORT=direct`(行为等价,更慢)。
存量 workspace 升级 CLI 后需要重新生成 hook 脚本才能拿到快路径:`scry integrations repair --yes`(不做也不会错,只是慢)。

## 容量与归档

`.scry/records/` 是 append-only 事实源:一轮一个 JSON,文件名带 20 位序号且必须连续。

| 轮次形态 | 大小 |
|---|---|
| 只有 prompt,无工具无 diff | 2.6 KB |
| 5 次 Edit + 5 文件 diff | 6.6–9.9 KB |

存储量取决于实际采集的原文和 diff，不能按 inline 预算估算总磁盘占用。默认 `full` 的单轮工具正文 inline 预算为 128 KiB（可配置到 1 MiB），但 `contentRef` 指向的完整正文不受此预览预算限制；diff patch 不再设置单文件或单轮容量上限，另有元数据、归档和恢复副本。显式 `summary` 仍只保存输出摘要，单次 input 超 8 KiB 会省略并标 `partial`。

### Diff 正文：一份完整内联内容（方案 C）

CLI / daemon 自行采集 Git diff 后，新生成的记录把完整 patch 保存在
`diff.value[].files[].patchContent.content`，并保留 `patchContent.contentRef`，不再重复写
`files[].patch`。`savedBytes`、完整性状态和内容库校验不变；正文没有截断，也不是按需加载。
旧记录不重写，仍可读取、导出与归档。App managed canonical handoff 不经过这处 Git 正文生成路径，
本次不修改它的证据结构或重复提交判定。

自建 uploader / 消费方不能假定每个文件都有 `patch`；完整正文优先读
`patchContent.content`，旧记录可读 `patch`。若遇到只有引用的记录，仍按既有引用合同读取正文，
不能把空预览当成完整正文。方案 C 只删除记录内的重复副本，内容库仍保存正文，读取大记录时仍需
加载内联正文。

### 单条记录的传输预算（提交边界）

`commitRecord` 是 App managed 与独立 CLI 唯一的提交口。写入前它把一条记录收敛到接收方校验的
传输封装内：超限时**优先省略外置引用**（字段已有的有界预览原样保留），只有在省略引用后仍超限时才
把 diff 内联正文裁到 8 KiB 预览。三个上限定义在 `src/core/turn-recorder/record-content-budget.ts`
并导出，uploader 直接引用，不再各自维护一份：

| 常量 | 值 | 语义 |
|---|---|---|
| `RECORDER_CONTENT_MAX_BYTES` | 8 MiB | 单个正文 blob；更大的正文只能留预览 |
| `RECORDER_CONTENT_MAX_REFS` | 512 | 一条记录最多引用多少个不同 SHA-256 |
| `RECORDER_TRANSPORT_MAX_BYTES` | 16 MiB | 最终封装：record JSON + base64 正文 + JSON 开销 |

被省略的字段按既有合同表达：`ToolContent.storage` 变 `truncated`/`omitted` 并追加 `turn_budget`
；transcript 引用没有内联副本，省略后该证据变为 `unavailable`；所在分区标 `partial` 并写
`omissionReason`。内容库里的 blob 不删，记录提交后也不回写旧记录。内联副本本来就是完整正文
（diff patch）时，省略引用不损失任何字节，因此该字段不降级。

### 引用必须在本库兑现

同一条不变式在 `commitHandoff` 里、`commitRecord` 之前再守一次（`resolveRecordContentRefs`）：
记录里的每个引用都要能在本工作区内容库解析。可解析 → 放行；引用缺失但字段内还带着完整正文 →
先把字节写回本库；两者都不成立 → 走同一套降级语义（`unavailable` + 分区 `partial`）。准备、恢复与
重复提交共用这一次遍历，所以旧版本准备的 handoff 或只在 App trace 库存有字节的证据，都不会变成
悬空引用。

修复既有 store 时用同一个 sha256 契约找回字节，默认只读演练：

```bash
scry recorder content repair --workspace "$PWD"                        # 只报告汇总与未命中清单，不写盘
scry recorder content repair --apply --workspace "$PWD"                # 从 App trace 库复制命中项
scry recorder content repair --record-id <recordId> --apply            # 只修指定记录（可重复给出）
```

它按 sha256 在 `--app-data`(默认是 App 的 userData 目录)下的 `trace-content-v1/*/content/sha256/`
查找正文，读时校验长度与摘要，命中才复制进本库。未命中的只列清单（退出 3），**不改写任何记录**：
记录是否降级仍由提交边界决定，修复工具不替用户改证据语义。`--record-id` 指向不存在的记录会直接报错。

本库已有同名 blob 但校验不过（同名不同字节）时不删除也不覆盖：那是损坏的证据，修复工具把它列在
`corrupt` / `corruptItems` 里，状态为 `corrupt`（演练）或 `applied-with-corrupt`（`--apply`），同样退出 3。

`records/` 里并不只有记录：中断的原子写会留下 `.tmp`，崩溃也可能留下半成品。修复与维护命令只认
`<20 位序号>-<recordId>.json` 这种合规文件名，读不出来的文件同样跳过，并在输出的 `skipped`
（维护命令里是 `skippedRecords`）中列出文件名与原因：`unrecognized_name` 或 `unreadable_record`。
跳过不等于删除,清理走下面的维护命令。

### 中断写盘留下的临时文件

`writeJsonAtomic` 先写 `<path>.<pid>.<uuid>.tmp` 再 `rename` 上屏。进程被杀会留下永不生效的
`.tmp`（可能 0 字节）。recorder 在日常路径上自动清理**超过一天**的这类文件：每次提交（App 托管与
独立 CLI 共用 `commitRecord`）检查一次，标记文件 `runtime/stale-temp-prune.json` 保证目录遍历最多
每天发生一次，daemon 启动时也做一次。`runtime` 不是真实目录（例如被换成指向别处的符号链接）时，
清理跳过这个入口，标记文件改写到数据根，不会沿链接在工作区外创建文件。更短命的文件可能属于正在写盘的进程，绝不会被碰；清理失败只
影响这次卫生，不阻断提交。`scry records maintain --apply` 仍然是显式、可审计的那条路径。

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
