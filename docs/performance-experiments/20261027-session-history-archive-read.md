# 会话历史 archive 读取：先分清读与写

状态：已加细分标记，性能结论为「无免费大优化」；未做产品取舍。

## 两个目标其实是同一条路径

`ipc.agent:loadSession`（p50 592 ms）与 `session_history.load·archive`（p50 356 ms）
都落在 `src/main/bootstrap/history-load.ts` 的同一个 handler：`archive` 阶段从
`readSessionHistoryAfterCompletedRuns` 之后开始，既包含 archive 页读取，也包含随后
逐轮 `persistTraceToolEvents` 的写入。一个标记把两件事混在一起，无法判断慢在读还是在写。

改动：在持久化循环之前加 `archive_read` 标记（含 `archiveTurns`、`archiveTurnFilesRead`），
`archive` 保留为这段的总时长。这样日常记录里能分开读与写，不需要新的采样通道。

## L2：真实档案的读成本（受控副本，不在 App 数据上跑）

用本机一条真实 pi 会话（111 轮、108 MiB turn 文件、163 MiB content store）复制到
`/tmp/scry-perf-ud` 后计时，走 indexed 快路径（不需要重建索引）：

| 页大小（limit） | 中位毫秒（3 次） | 返回轮数 |
|---|---:|---:|
| 1 | 29 | 1 |
| 5 | 67 | 5 |
| 10 | 100 | 10 |
| 20 | 137 | 20 |
| 40 | 363 | 40 |
| 80 | 470 | 80 |

- 固定成本约 25–30 ms（索引读取 + 最新快照水合 + 首轮）。
- 其余基本按轮线性增长：每轮约 2.5–6 ms，因为每轮都是一份约 1 MiB 的 JSON
  要 read + parse + 校验。并行读取已经存在（`Promise.all`），所以瓶颈是单线程解析，
  不是磁盘等待。
- `highLoad: true`（机器 load 15–20），绝对值只作方向性证据；40 轮那一档波动最大
  （320/363/612 ms），说明当前机器上还会被其他进程挤。

## 结论

没有「免费」的大优化：

1. 减少轮数（把默认页从 40 降到 10–20）能把 363 ms 压到约 100–137 ms，但用户每屏看到的
   轮次变少、需要更多次「加载更早」。这是产品取舍，需要拍板。
2. 真正做到「快而不减内容」只能改成懒加载：首页只解析首屏需要的字段，其余在滚动时补，
   这要动 renderer 与 IPC 协议，属于架构级。
3. 其他猜测（索引重建、重复校验）在这条真实档案上没有发生：读的是 indexed 快路径，
   `readMode: "indexed"`，没有触发 rebuild。

## 未验证

- 上一行「每轮解析占主导」来自轮数扫描，不是逐轮 CPU profile；没有把 read 与 parse
  分开计时。
- 只看了一条 pi 会话、一种页大小序列；claude（有 transcript 路径）未测。
- 未在打包 App 里复测（需要安装与重启）。
