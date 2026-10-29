# 2026-10-28 会话并发 P0 续：in-main trace 与 remote readers 阶段记录

## 状态

- 本篇记录 R1–R5 的 in-main trace 测量工具与 12 格功能采集，不改变上一阶段 native 窗口 fixture 的口径（见 [native 阶段记录](./20261028-session-concurrency-p0.md)）。**后续记录**：R6 与 50k 的 pilot／预注册已完成，P0 已正式冻结（baseline 冻结，不是改善结论；[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §5）；本篇的组件口径与 12 格功能结果不变。
- P1 **未开始**：本篇没有产生任何生产优化（P0 冻结后仍未开始）。此次只有测量工具，单独提交（提交号以 Git 历史为准）；不安装、不推送。
- 阶段记录不是验收门禁；门禁与 ratchet 仍以[性能闭环](../performance-loop.md)为准。
- **R6 入口**：其后的真实 App live lane（真实构建 App → loopback TLS → 受限 IPC → 生产 `RemoteChat`）已作为独立工具验收；功能矩阵与后续噪声 pilot 已完成，尚无改善结论：[R6 live lane](./20261028-concurrency-trace-live.md)。

## 1. 这个 fixture 是什么

- **固定工作量**：16 任务，每波 limit `4|16`，peer `0|1|4`，每 run 客户端 `1k|10k` items，共 2×2×3=12 格。
- **真实组件**：主进程内真实 `runtime.boundedLiveRun` ＋ 同一个 `createDesktopHostReader` ＋ 真实 `DesktopRemoteClient` peer ＋ 进程内 JSON roundtrip。
- **固定写入**：7 个阶段；每 peer 112 次真实 poll，配合独立 oracle；4 peer 共 448 次。
- **严格串行**：读按固定 peer 序→run 序发出，`maxActive===1` 由 spy 证明，避免 CPU 区间重叠。
- **不是**：完整 App、真实 Provider、TLS、renderer commit、日常 RemoteChat 频率。当前每格仅采一次，因此只记录功能与描述性证据。

## 2. 50k 与未测部分

- 每 run 50k 的 main projection/revision 内容与容量/边界已有单测；真实 client 上限仍是 `MAX_ITEMS=10_000`，50k 没有伪装成"聚合成小任务"。
- 本篇写时仍未测：50k 的 Electron 耗时、完整 App 远程混合路径、实际 hash 工作计数。**后续记录**：hash 计数（[计数与试点篇](./20261028-concurrency-trace-counts-pilot.md)）与 50k 组件计时（[main-only 50k 篇](./20261028-concurrency-trace-main-50k.md)）已补；完整 App 远程混合路径仍不是日常路径证据。
- `projectionInputItems` 只是输入规模，不是工作量或耗时证明。

## 3. 证据与身份

| 项 | 值 |
| --- | --- |
| 源码基线 | `eb61031a841915d79439a2e8ce2aacfb4cbc6df9`（采集时工作区为 dirty） |
| bundle | `55f787e2f9056a3838d3922687de2ed083958e0d22175f85e74872e06aa8ba73` |
| 运行时 | Electron 42.10.1 内 Node 24.18.1；driver Node 24.18.0；arm64 Apple M2 Pro 10 核 |
| 报告 | 带逐文件 source/bundle hash；12 格 source 与 bundle 均相同，前后未变 |
| 负载 | 全部 `highLoad=false`，5.82–7.48 / 10 核 |

hash 相同只说明采集期间这些文件未变，**不构成**构建新鲜度证明。

## 4. 12 格采集结果（`/tmp/scry-p0-remote-matrix.Ao7RXb`）

12 格全过（1k/10k × limit 4/16 × readers 0/1/4）：

- 每格 16 个完成、16 次独立 reconcile；`steps` 为 28 或 7；实际 fixture max in-flight 等于该格 limit。
- reads/oracle 随 reader 数：0 读者 0 次、1 读者 112 次、4 读者 448 次。
- 未触发 chunk 分页；每格登记 3 个进程、stop 成功、close 0、私有 temp 已删除；未登记后代保持 unknown。
- 每格只有一次功能/描述性样本：**不是**优化结论，也不是噪声估计。

## 5. reset 语义（仅限此受控串行序）

- limit 4：`resetsWithCursor=0`；limit 16：每 peer 96，4 peer 共 384。
- 首读 snapshot 另行计数，不计入 reset。
- 该结论只在这个受控顺序下成立，不能推广为"所有 reset 都是 eviction"。

## 6. 原生错误对照

日志：`/tmp/scry-p0-remote-error-control.OYuUE4/{before,after}.log`。临时 bundle 内把 trial 调用替换为 throw，不改 repo，也不是 timing 样本。

- 旧 sender 在 `status:error` 通知里漏掉 `error`，父 validator 判 `notification-invalid`，把原始错误盖掉。
- 修后 `reason=trial-error`，notification／payload／summary 都保留 `R5 controlled trial failure`；登记 3 个进程收敛、close 0，result 与日志保留。
- 这些进程已回收，本次不再处理。Node 行为测试覆盖"正常错误"与"result 写失败 + 已有 trial 错误"两条原因。

## 7. 其它先红后绿（简）

- cleanup 失败不能删除现场；重复 dispose 不能变成成功。
- 等长正文腐蚀必须被识别；已交付 view 别名／丢掉 delta 必须报错。
- writer 中断仍要记真实 item 计数与 CPU；0 读者不应发生 112 次无用 sanitize。

## 8. 最终验证

- `npm run test:unit -- scripts/concurrency-trace-*.test.ts scripts/session-concurrency-*.test.ts src/main/remote/desktop-trace-delta.test.ts`：15 文件、146 项全部通过。
- `npm run typecheck`、`git diff --check` 通过；15 个新增脚本/测试文件均小于 20,000 字节，无行尾空白或多余 EOF 空行。
- 以上为 focused 验证，不是全仓测试或发布门禁。

## 9. 复现

```
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs \
  concurrency-trace-limit4-readers1-items1k -- \
  node scripts/concurrency-trace-bench.mjs --limit 4 --readers 1 --items 1000
```

wrapper 必须带 `<label> -- <command>`；单格参数只有 `--limit 4|16`、`--readers 0|1|4`、`--items 1000|10000`。

- `highLoad` 只来自 wrapper footer；低负载是 L2 的必要条件，不是充分条件。
- 主进程 CPU 含 in-process clients 与 oracle；reader intervalCPU 不是 exclusive 归因。登记 3 个进程不表示采到了三者的 CPU/内存合计。
- 内存只有主进程前后两点样本，不是峰值、物理内存或 GC 后驻留；未登记进程仍 unknown。

## 10. 开放项（owner：父会话）

| 开放项 | 备注 |
| --- | --- |
| pilot 噪声／MDE／重复次数与顺序预注册 | 预注册后才允许 L2 结论；已采 reader 变体的低负载样本见[计数与试点篇](./20261028-concurrency-trace-counts-pilot.md)；**后续记录**：预注册已定，见 [P0 冻结与比较预注册](./20261028-concurrency-trace-p0-freeze.md) §4 |
| 必要的 native／50k 计量、实际 hash 工作计数 | 实际 hash/JSON 计数工具已实现，48 条 observations 采自 R4 与 10k/50k（[计数与试点篇](./20261028-concurrency-trace-counts-pilot.md)）；50k 当时无毫秒，**后续记录**见 [main-only 50k 篇](./20261028-concurrency-trace-main-50k.md) |
| collector 冻结与提交 | 工具已单独提交并随 P0 冻结，见[冻结验收](./20261028-concurrency-trace-p0-freeze.md) §5；未安装、未推送 |
| P1 | 未开始，另 commit（P0 已冻结，见 [P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md)） |
