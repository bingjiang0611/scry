# 2026-10-26：历史会话打开去掉重复解析与冗余累积快照

## 当前结论

本轮把两个候选拆开验收，结论不同：

- **Stage 1 接受**：复用已经解析的 archive page，并在跨 IPC 的投影里只保留 renderer 会读取的最新累积快照。当前 main 抽象上的独立集成、全量单测、真实 Electron Pi 历史恢复与低负载固定负载均通过。
- **Stage 2 拒绝当前实现**：`f2ab79ab` 把每个大 patch 单独写入 durable content store。它能减小历史读取体积，但独立回归暴露 4 个证据正确性问题；在 40 轮、每轮 8 个不同 96 KiB patch 的低负载基准里，又新增 320 个 durable 文件，把写入墙钟放大约 10–11 倍。该提交不进入本次候选。

因此，本次只保留 Stage 1。没有修改磁盘格式、真实归档、ratchet、main、已安装 App 或 Provider 行为。

## 慢点的真实来源

### 日常记录

packaged build `79691ecc…`（0.2.225）在 2026-10-26 11:08–13:00 UTC 产生 13017 条记录：

- `ipc.agent:loadSession` n=169，p50 866 ms / p95 5145 ms / max 11180 ms。
- `session_history.load` 的 archive 阶段 p50 396 ms / p95 1893 ms；`page_hydration` p50 275 ms / p95 2088 ms。
- 每次打开固定读 40 个 turn 文件；慢样本的 session 只有 78–91 轮。瓶颈是单轮文件体积，不是轮数。

该日志 build 与源码映射仍 unknown，所以只用于定位热点，不用于证明当前源码已改善。

### 真实大会话

用户现场 `rotom eval` 会话有 92 轮、789 MB。最新 40 个 turn 文件合计 407 MB：

| 组成 | 字节 | 说明 |
|---|---:|---|
| `items[].session_diff` | 182 MB | 每轮重复“会话开始到当前”的累积快照 |
| `turnEvidence.diff` | 187 MB | 同一累积快照的 canonical evidence 副本，不跨 IPC |
| 工具事件 | 23 MB | 工具输出正文 |
| 其他 | 10 MB | 单轮 diff、模型文本等 |

旧实现先由 `readTraceArchivePageAsync` 解析最近 40 轮；Pi native 对账随后又用 `readTraceArchiveTurnsAsync` 解析同一批文件。返回页还携带 renderer 永远不会读取的旧累积快照。现场投影曾测得 IPC 页面 158 MB → 24 MB；该结果保留为真实形状证据，但不是当前分支的 L3。

## Stage 1 实现

### 复用已解析页

`readSelectedArchivePageTurns` 先按 runId 复用当前 archive page，只把未覆盖的 runId 交给 `readTraceArchiveTurnsAsync`。Profile 限定页可能过滤其他 Profile 的轮次，因此明确传 `null`，继续走权威读盘，不能静默缺轮。

该逻辑接在 `src/main/bootstrap/history-load.ts`，没有把复杂度塞回已拆分的 `index.ts`。

### 只裁剪跨 IPC 投影

`projectHistoryPageSnapshots` 从后向前只保留最新一条 `session_diff` 和最新一条 `session_diff_preview`。最新快照即使为空或失败仍然权威，不会复活更旧快照。

裁剪只发生在 `src/main/bootstrap/history-runtime.ts` 返回的历史页：

- 磁盘 archive 不变；
- main 侧 cache 不变；
- canonical `turnEvidence.diff` 不变；
- 单轮 `turn_diff`、工具事件与文本不变。

减少的工作是真正不再发生的重复文件解析、IPC 序列化与 renderer JSON 解析，不是把工作移出计时窗口。

## 独立验证

验证分支最初从 main `92707298` 建立；该提交相对代码基线 `7a1c4a60` 只增加交付文档。Stage 1 在 main 的 bootstrap 拆分上重新接线，不直接套用旧 `index.ts` 冲突块。验证期间 main 被并行任务先后推进到 `c67435c5` 和 `9b4037a8`；这些增量没有修改本轮四个历史加载文件，但增加了 renderer 重启、会话恢复和对应 opt-in smoke 等相邻路径。候选最终以 merge `18102902` 纳入最新 main，并在此精确提交上重跑最终验证。

### 正确性与兼容性

- 新增 7 个投影/复用测试：完整覆盖时 callback 不执行；缺轮时只读缺失 runId 并保持请求顺序；无可复用页时全部回退；只留最新 terminal/preview；同一轮同类事件保留 renderer 会选的最后一条；空快照仍权威；无累积快照时不添加或重排。
- Stage 1 初始 focused：3 文件、77 项通过，包括 archive 分页、冷索引和旧归档读取。
- 当前 main 集成 focused：5 文件、84 项通过，额外覆盖 renderer restart 与 session restore 相邻路径。
- 当前 main 集成 typecheck：Node 与 renderer 均通过。
- 当前 main 集成全量 unit：383 文件通过、4 个既有 opt-in 文件跳过；4218 项通过、4 项既有跳过、0 失败。未改超时、断言或 skip。
- 当前 main 集成 production build 通过；隐藏 Electron `--dev-pi-history-only` 通过，覆盖 named Profile、mixed/unknown Profile、55 轮 archive-only 分页/重开、provenance 不变，且没有执行 Provider。

本机第一次 focused 在系统高负载下，`transcript-archive` 的 5 秒冷索引用例超时；同一精确用例的 baseline 与候选单跑随后都通过。首次失败保留；低负载 mac2 完整 focused 与全量 unit 均通过，因此未提高超时或把本机首败删除。

### 固定大 diff 负载

负载固定为 40 轮；每轮有 8 个 96 KiB 累积 patch、2 个单轮 patch和一份 canonical evidence 副本。每轮累积状态不同，防止用重复正文去重掩盖真实写放大。所有毫秒测量由 `timing-run.mjs` 串行加锁；mac2 为 8 核，以下各轮 `highLoad=false`。

#### L1：体积和工作量

| 项 | main 基线 | Stage 1 |
|---|---:|---:|
| archive 文件 | 40 | 40 |
| archive 字节 | 71,481,891 | 71,481,891 |
| 页面累积快照数 | 40 | 1 |
| JSON 页面字节 | 71,476,172 | 40,511,486 |
| 最新快照正文 | 786,528 | 786,528 |

最新快照 SHA256 相同：`1b161b2f357be193eabc6bcb1242fee40b3a9bf2d1d003b57d40a770b417d291`。Stage 1 不减少 main 读盘字节；它删除重复二次读取，并缩小公开页面。

#### L2：重复解析

AB/BA 各 3 次。在同一 71 MB fixture 上，基线执行“页读取 + 按 40 个 runId 再读”；Stage 1 执行“页读取 + 复用已覆盖轮次”。

| 次序 | 基线 p50 | Stage 1 p50 | 进程墙钟：基线 → Stage 1 |
|---|---:|---:|---:|
| A/B | 265 ms | 115 ms | 1600 → 1159 ms |
| B/A | 249 ms | 118 ms | 1599 → 1147 ms |

两侧都返回 40 轮，末轮 SHA256 同为 `4e598e8b6e0dcabee3e3bbc0ecfa8970950d6cebba14ae214f97c796e68195ac`；Stage 1 的 missing-reader 调用为 0。结论只适用于这个函数级固定负载，不冒充完整 App 点击延迟。

页面读取+投影的另一个 AB/BA 样本中，Stage 1 p50 185–189 ms，基线 p50 199–356 ms；baseline 首轮冷波动明显，所以只作为方向性佐证，不宣称稳定百分比。

## Stage 2 为什么拒绝

`f2ab79ab` 试图把 `session_diff` / `session_diff_preview` / `turnEvidence.diff` 的大 patch 转成 `trace-content-v1` 引用，并在读页时回填最新快照。原提交自己的 82 项相关测试通过，但新增的最小合同测试在原提交上 **10 项中 4 项失败**：

1. 2 KiB preview 被错误标为 `storage: complete`。既有消费者可把 preview 当完整正文，造成可见 patch 截断。
2. 写 archive 时原地修改调用方 turn。live cache / 后续持久化可能看到已经被替换的引用，而不是原始证据。
3. content blob 缺失或损坏时，整个历史页 reject；没有按注释保留可见 partial ref。
4. full/selected archive reader 不回填最新快照。Profile/native 与 Claude full-read 路径可能返回引用而不是正文。

临时修正这些问题后，固定 unique-state 负载仍证明“每个 patch 一个 durable 文件”的抽象层不合适。对原 `f2ab79ab` 的低负载 AB/BA：

| 项 | main 基线 | `f2ab79ab` |
|---|---:|---:|
| archive 文件 | 40 | 40 |
| 新增 content 文件 | 0 | 320 |
| 总存储字节 | 71,481,891 | 41,052,771 |
| 单轮写入 p50（两次） | 4.70 / 5.09 ms | 329.15 / 303.51 ms |
| 40 轮进程墙钟（两次） | 1.28 / 1.40 s | 14.45 / 13.46 s |

读页确实缩小到 9,585,566 字节，3 次读取 p50 42 ms；但该数字建立在上述正确性缺口上，并以每轮最多 8 个新 durable publication 为代价。读快不能掩盖写入约 10–11 倍的端到端回归，也不能弱化证据合同。

历史的 789 MB 副本压实结果（791→226 MB、页读取 3745→396 ms）继续保留为“存储瘦身有价值”的线索；它不是接受当前 per-patch 文件方案的依据，因为当时未覆盖 unique bodies、调用方不可变、缺 blob 和全部 reader 合同。

## 决策与后续

- 本次候选只包含 Stage 1。
- `f2ab79ab` 不合入、不修修补补后强推。若继续存储瘦身，应先设计**快照级压缩/分块**，避免每个 patch 都产生 durable 文件；这属于新存储格式及恢复合同，实施前需要用户明确批准迁移范围。
- 不改变旧 archive；不执行存量压实；不删除旧累积证据。
- 不新增或放宽 ratchet。现有 `history.page`（4000 轮 × 1 小事件）看不到大 diff 形状，仍是覆盖缺口；本轮固定负载脚本和完整日志保存在独立验证根目录。

## 交付状态

- 独立候选分支：`integration/history-content-validation-20261026`；Stage 1 代码提交 `ab753e73`，最终 main 集成提交 `18102902`。
- 用户在独立验收后选择“仅合入 main”；main 已从 `9b4037a8` 快进到 `18102902`，没有覆盖并行 WIP。
- 本任务没有写 `reliability/collection` 或 `/Applications`。reliability 为 `a9f7bf44`；安装版在验证期间被并行任务改为 0.2.221，交付后检查又为 0.2.226，均不是本任务安装。
- 本任务未安装、未 push、未重启用户实例、无 L3。
- 结构化证据：[20261026-history-open-validation-evidence.json](20261026-history-open-validation-evidence.json)。
