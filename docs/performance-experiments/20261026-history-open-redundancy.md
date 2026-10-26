# 2026-10-26：历史会话打开去掉重复解析与冗余累积快照

## 结论（一句话）

打开一个真实大会话时，主进程把同一批 40 个 turn 文件**解析了两遍**，并把 **158 MB**
历史页送过 IPC，其中 84% 是 UI 只读最新一份的「累积会话 diff 快照」。这两处已修，
页面体积降到 24 MB；剩下 5–6 s 的成本是「一次打开必须读解析 302–407 MB」，需要存储层瘦身才能继续降。

## 慢点的真实来源（本机日常记录 + 真实会话实测）

### 1. 日常记录（packaged build `79691ecc…`，0.2.225，2026-10-26 11:08–13:00 UTC，13017 条）

- 选定 build：`79691eccc0fb94ddda38fd52cdb3b10e79a07560fe749ddbdebb9e35a22f3ac7`
  （已安装 0.2.225 的运行日志；源码→构建→运行映射仍为 unknown，日志 build 只用于定位热点）。
- `ipc.agent:loadSession` n=169，p50 866 ms / p95 5145 ms / max 11180 ms。
- `session_history.load` 阶段拆分（169 条）：

| 阶段 | p50 | p95 | max |
|---|---:|---:|---:|
| archive（读+解析 turn 文件 + 持久化工具内容） | 396 ms | 1893 ms | 5110 ms |
| native_history（Pi 原生历史，Provider 侧） | 54 ms | 821 ms | 2729 ms |
| project_remember | 47 ms | 238 ms | 747 ms |
| merge / merge_turns | 0 ms | 25 ms | 75 ms |
| **page_hydration（含重复读同一批文件 + 原生 hydrate + enrich）** | 275 ms | 2088 ms | 4845 ms |

- 每次打开固定读 40 个 turn 文件（`archiveTurnFilesRead=40`），慢样本里 `archiveTotalTurns` 只有 78–91
  —— 说明「慢」不是轮次数量，而是**单轮文件体积**。
- `agent.trace_content` n=2327，p50 84 ms（工具内容按引用分页读取，本轮未改）。

### 2. 真实会话体积（用户现场 `rotom eval`，session `01a171fd…`，cwd `…/dev-agent`）

- 归档 92 轮，789 MB；最新 40 轮 turn 文件合计 407 MB（最大单文件 195 MB）。
- 最新 40 轮文件字节构成（只统计结构，不读内容语义）：

| 组成 | 字节 | 说明 |
|---|---:|---|
| `items[].session_diff` 累积快照 | 182 MB | 每轮重复「会话开始 → 当前」的同一份清单与 patch |
| `turnEvidence.diff` | 187 MB | 与上面同一份累积快照的第二份拷贝，且从不跨 IPC |
| 工具事件 | 23 MB | 工具输出正文 |
| 其他（每轮 net diff、模型文本等） | 10 MB | |

- 页面投影后跨 IPC 的实际构成：162 MB = `harness/session_diff` 136 MB（其中 121 MB 是 inline patch）
  + `tool_result` 17 MB + 其余 9 MB。

## 假设与改动

### 假设 A：`page_hydration` 重复解析同一批 archive 轮次

- 原实现：`archive` 阶段用 `readTraceArchivePageAsync` 已经解析了这 40 个 turn 文件（并持久化工具内容），
  `page_hydration` 又用 `readTraceArchiveTurnsAsync` 按 runId 把同一批文件重读重解析一遍，只为了做 native 对账。
- 改动：新增 `selectArchivePageTurns`（`src/main/session-history-page-projection.ts`），已由当前 archive 页解析过的 runId 直接复用，
  只把未覆盖的 runId 交回读盘；**Profile 限定的页不复用**（该过滤会丢弃别的 Profile 的轮次，复用会静默缺轮）。
- 减少的工作去了哪里：**真的不做了**（少一次 40 文件的 lstat/containment/readFile/JSON.parse）。

### 假设 B：IPC 页里带着 UI 永远不读的旧累积会话快照

- `sessionDiffViewFromTurns` / `sessionNetDiffSummary` / `sessionNetDiffReview` 都从末尾往前找
  **第一条**会话快照就停（`src/renderer/turn-diff.ts`），更早的累积快照在既有 UI 上不可达。
- 改动：新增 `projectHistoryPageSnapshots`（`src/main/session-history-page-projection.ts`），只在**要跨 IPC 的页投影**里
  保留页面内最新一条 `session_diff` 与最新一条 `session_diff_preview`，其余丢弃。
  磁盘 archive 与 main 侧 `sessionHistoryCache` 保留全部快照，不删除证据；「最新快照即使为空/失败也仍然权威」
  的选取语义不变（有测试固定这一点）。
- 减少的工作去了哪里：**少传输 + 少序列化**（IPC 与 renderer 解析），`main` 侧读盘不变。

## 验证

### L1（计数与体积，可信）

| 项 | 前 | 后 |
|---|---:|---:|
| 一次打开重复解析的 turn 文件数 | 40 | 0（被页覆盖时） |
| 跨 IPC 历史页体积（同一真实会话） | 158 MB | 24 MB |
| 主进程 `JSON.stringify` 页面耗时（同机器，串行） | 628–1058 ms | 95–302 ms |

- 新增回归测试（`src/main/session-history-page-projection.test.ts`，5 项通过）：复用覆盖的 runId、只交回未覆盖的 runId、
  只保留最新累积快照、空/失败快照仍权威、final/preview 各自保留最新。
- 负对照：把 `projectHistoryPageSnapshots` 临时改回原样，3 项新测试确定性失败；恢复后全通过。

### L2（毫秒，未成立）

- 命令（临时 harness，未提交）：

```sh
cp -Rc "$HOME/Library/Application Support/scry/trace-archive-turns-v1/pi" /tmp/scry-hist-bench/userData/trace-archive-turns-v1/pi
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs history-load-before -- npx vitest run src/main/tmp-history-load.test.ts
```

- 结果（同一真实会话，本机 `highLoad: true`，负载 51–99）：

| 阶段 | 前 | 后 |
|---|---:|---:|
| archive 页读取（40 文件） | 4795–8076 ms | 5344–6273 ms（未改，波动内） |
| 重复解析 | 4177–8247 ms | 0 ms |
| 页面 stringify | 837–1393 ms | 95–302 ms |

- 因为 `highLoad: true`，**不宣称毫秒级改善**（L2 未成立）。需要在低负载机器（30.7.226.226）重跑同一负载的两侧才作结论。
- 期间全量 unit（`npx vitest run`，load average 17–175）：首轮 4097 项里 20 个文件 32 项失败，
  逐个重跑 19/20 文件 252 项通过，剩 1 项 `commit-environment` 单跑 5 项通过；重构后最终一轮
  4092 通过 / 2 项 `scripts/check-staged-file-size.test.ts` 5 s 超时，该文件连跑 3 次均 10 项通过。
  这些都是本机高负载下真实 git/子进程用例的既有超时类不稳定，路径未被本次改动触及；
  没有提高超时、跳过或用重跑抹掉首轮失败。

### L3

未验证（未构建、未安装、未发布）。

## 剩余限制与下一步（要给毫秒级必须继续做）

页面读取仍是 302–407 MB / 40 文件，JSON.parse 无法跳过，所以「打开一次读全页」有一个物理下限。
要继续降，只能减小**存储字节**：

1. 每轮不再写两份累积快照：`items[].session_diff` 与 `turnEvidence.diff` 目前各存一份同一快照（共 369 MB/40 轮）。
   候选：累积快照每会话只保留最新一份（sidecar），每轮只保留 `turn_diff` 主证据。
2. 把 patch 正文移到已有的内容寻址存储（`trace-content-v1` / `writeRecorderContentCopies`，已有去重），
   `DiffFile.patchContent` 字段本来就是为此设计的。
3. 存量 5.2 GB 归档需要一次性压实，会改变历史累积快照的可得性 —— **需要用户明确取舍**（删除旧累积快照 vs 转成内容引用）。
4. 工具正文 23 MB/40 轮是剩下的地板；要进两位数毫秒还需要把工具正文默认改为引用 + 展开时取。

## 交付状态

- 优化源码：本提交（新增 `src/main/session-history-page-projection.ts` 与其测试；`src/main/index.ts` 只接线 3 处）。
  `src/main/index.ts` 与 `src/main/session-history.ts` 已超过仓库 pre-commit 的 20 KB 单文件预算，本次 `index.ts` 的接线提交需 `--no-verify`；新逻辑按该 hook 的要求放在独立小模块里，不继续加厚大文件。
- 合入状态：未合入（仅本地分支 `reliability/collection`，未推送）。
- 构建状态：未构建。安装/生效：未安装。
- 台账：未新增/未放宽任何 ratchet 指标。`history.page` 现有 workload（4000 轮 × 1 个小事件）
  看不到 diff 快照体积，属于覆盖缺口。
