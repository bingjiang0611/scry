# Native runner 工作区索引归因（2026-11-13）

## 范围与假设

PR #82 的 Native primary 失败，A/A 正反向也失败；高 load 只是线索。维护者授权独立调查测量与 runner，不提高预算、不缩小工作量、不移除 guard，也不以诊断通过替代旧失败。

假设：App 之外的索引工作可能与 Native 争用资源。先收集测量窗口外的进程快照，再在独立、带观测开销的完整四场景 profile 中采样运行中进程，最后检查 Spotlight 是否实际访问这次 CI 工作区。未改 App source、预算或正式工作量；没有重跑旧 PR 来刷新失败状态。

## 已取得的证据

| revision / run | 结果 | 能证明什么 |
| --- | --- | --- |
| `5f3069b6` / [43365419569](https://github.com/bingjiang0611/scry/actions/runs/43365419569) | Node 通过，Native primary 6 项回归 | 前后快照都可用；边界快照不能覆盖中间启动/退出的进程，不能据此排除外部争用 |
| `0125ca4f` / [43367728054](https://github.com/bingjiang0611/scry/actions/runs/43367728054) | 正式门禁通过；独立 profile 32 次进程快照、未触及 128 次上限 | 30.498 秒 profile 中，观察到的 Spotlight CPU 下界为 10.84 CPU 秒：mdworker_shared 8.24、mds_stores 1.48、mds 1.12。不能把这次通过当作修复旧失败 |
| `b29e31cf` / [43369806208](https://github.com/bingjiang0611/scry/actions/runs/43369806208) | Node 通过，Native primary 6 项回归；独立 fs_usage 成功退出 | 15 秒内有 39,366 条索引器事件，其中 7,994 条匹配工作区 node_modules，286 条匹配其他工作区路径；其余 31,086 条没有工作区路径，不能全部解释成工作区外 I/O |

三个 run 均以 `e0500b4cfb10ee638c7bb040b4d05b2df36df1f3` 为基线（已核对三个 baseline.json 的 revision）。证据在各 run 的 `performance-native-results` artifact：均有正式 `report.md(.json)` 与 baseline/candidate；第二、三次有独立 `runner-profile-timing.log`，第三次另有 `indexer-trace.json`。原始 trace 不落盘；只保存计数和 collector stderr/退出码。

CPU 下界按 PID + ps 启动时间合并累计 CPU；已确认在窗口内出生的进程从零累计，其他进程取观察到的首末差值。它遗漏未入选及最后一次观察后退出的 CPU，不能直接等同争用造成的墙钟延迟。该 run 的 OS CPU tick / 单调时钟 / 逻辑核比约 0.997–0.998，不能据“忙碌百分比高”推断 VM 丢失 CPU 时间；该结果也不追溯证明旧 runner 的状态。

## 定向修复与验证边界

将 Native job 的 baseline/candidate 两份完整检出及产物放进 `native.noindex/`，使用 macOS 的目录级索引排除。不关闭宿主卷索引，不停止系统进程，不改 SIP 或其他安全设置。所有原有 run 命令、完整四场景、primary/A/A、比较器和阈值保持不变；只调整工作目录、checkout、缓存输入及 artifact 路径。Node job 不变。

新增路径合同在旧 workflow 上失败（1 failed / 2 passed），证明能发现遗漏。路径计数器正对照覆盖 `native.noindex/candidate/node_modules`，避免目录改名导致假零。还须在修复后的真实 runner 上验证：完整正式测量、artifact/缓存路径，以及有效追踪窗口内是否仍出现工作区扫描。即使没有匹配，也只是有限窗口证据；不宣称解释或消除所有共享 runner 波动，不用带 profile 开销的毫秒数证明提速。
