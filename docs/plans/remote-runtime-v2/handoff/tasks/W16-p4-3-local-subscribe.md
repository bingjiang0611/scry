# W16 · P4-2 收尾与 P4-3：本机订阅（只在 on 下生效）

执行方 C。前置：W9（P4-2）已通过，见 [reports/W9-review-2.md](../reports/W9-review-2.md) 第六轮。

## 第一部分：P4-2 的两项非阻塞应修（先做）

1. 镜像积压超过 2,048 条时，emit 路径不再同步执行 `buildH1SnapshotFromDb`（`legacy-mirror.ts:247-256`）：改为置标记，在 drain 时重建。补测试：大突发下 emit 期间 0 次 DB 快照查询。
2. on 启动时同步解析 H1 只在 `on_active='1'` 时做，或者放到主线程以外。测量 33k run 规模的 on 启动耗时，修改前后对比。
3. 小项：
   - `orchestration` 为 null 或不是对象时，忽略该字段，不丢弃整份自报状态。
   - 引擎被封住时，状态要如实反映。
   - 修正 plan 第 9 行和 §9 开头里「开发构建默认走进程内」的过时说法（W15 之后已改为默认走后台服务）。

## 第二部分：P4-3 本机订阅

依据：[P4-orchestration-plan](../../P4-orchestration-plan.md) §9 的 P4-3 行，[-protocol](../../P4-orchestration-protocol.md) §5（订阅协议）、§6 表格第 1 行（App 本机），以及决定 H（decisions §14）。按设计实现，不重新设计。

| 项 | 内容 |
|---|---|
| App 切换 | `DaemonEventPump` 改为 `subscribe`；`DaemonRunRuntime` 不再每个 run 都读 `watch`，生命周期来自事件，只在提示到达时读 trace；删除 `DaemonRunDiscovery`、`departedState` 与 `settledTail`（终态 run 在 `orch_p_run` 保留 24 h，trace 从归档读）；`agent:start` 的 `commandId` 按 protocol §6 处理 |
| 开关 | **只在 daemon 报告 on 能力时切换**。`off`、未设置和 `shadow` 下，App 仍走现有的 pump 与 watch，行为逐字节不变。用测试证明两条路径都能工作 |
| reset | `subscribe` 收到 reset 或 `logId` 变化时，App 按快照重新同步，不丢 run 状态、不重复通知 |
| `AppEventFeed` | 按 plan 缩小范围，并接入 P5 的通知（W11 的 host-admin 通知）。不改 W11 的通知语义 |
| 重测 | 按 S1 流程重测首 token（on 与 off 对照，fullfsync 开启），并测 App 侧订阅下的会话切换和 run 状态延迟。不放宽任何门限 |

## 约束

- 默认路径（`off`、未设置、`shadow`、进程内模式）零行为变化，这是硬要求。
- 不改协议版本（仍为 2）。`subscribe` 作为 v2 能力加入：没有这个能力的旧 daemon 照常工作。
- 不碰 W14 的真机步骤、host-admin 安全逻辑、W13 的 trust 文件；改 `background-service-status.ts` 时先合并他人的提交，并保持 W11 的 N1 逻辑。
- 已经接近上限的文件先拆分，单文件小于 20,000 字节。

## 验收

- 先写失败测试再实现。
- 每个单元都要有真实 daemon 加真实 App pump 的集成测试，覆盖：on 下订阅、off 下旧路径、on 重启后 reset、daemon 被 SIGKILL 后 App 重连。
- 三种模式下的 orchestration 与 daemon 测试全部通过；`check:cli-runtime` 通过。
- 报告写 `reports/W16.md`，第一行写状态。
