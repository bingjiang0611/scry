# R3 后续：doctor / status 漏报警修复

范围：修复方案 C 全量回归中发现、且在未修改基线 `56620f73` 上复现的两项既有诊断失败。
本轮基线为 `efbb391b`。不改 C、不迁移记录、不触发 Provider、不把过期推断写成轮次终态。

## 两个根因

1. `recorderPendingHealth`、`recorderStaleOpenTurns` 直接读取 attention 标记；标记目录缺失时返回
   空列表。旧工作区、恢复后的工作区可能已有 inbox / open 状态，但 daemon 尚未重建索引，
   `doctor` / `status` 因而误报没有待处理证据。
2. `recorderStaleOpenTurns` 的结果添加语句误放在 `if (open.transcriptPath)` 内；即使已建立索引，
   没有 transcript 路径的旧 open turn 也永远不报 stale。

## 最小修复

`runtime-state.ts` 新增共享的 `attentionSessions` 选择逻辑，供 pending、stale、has-open 三个
读取入口复用：索引存在时仍只读标记；不存在时复用已有 `reconcileAttentionIndex` 从 runtime
重建。没有新增另一套索引或扫描协议。

将 stale 结果添加移到 transcript 分支之外。只有足够旧、非 managed、仍处于 open 的轮次
才可能报警；近期 transcript 活动仍会抑制报警。没有 transcript / transcript 文件消失，
都不能被当成近期活动。

保留两个不同语义：

- pending 健康值包含失败 / 不可读 inbox sidecar 所对应的证据。
- daemon 是否有可重试工作仍按 `recorderHasRetryableInbox` 判断，不因诊断警告而空转。

重建只维护可丢弃索引；诊断不重放 hook、不删除 inbox、不结束 open turn、不创建记录。
缺失索引的首次诊断允许全量扫描；已存在但不完整的索引仍使用原有 recovery 周期性修复机制，
本轮不扩展为每次 doctor 都执行全量修复。

## 验证

新增 `runtime-state.test.ts`，9 项覆盖缺失索引下的不可读 sidecar、managed / closing / quarantined
证据、无 transcript / 缺文件 / 老文件 / 近期文件及年轻轮次。stale 检查独立首先调用，并重复调用
验证已建立索引时的行为；源文件逐字节保持不变。

| 检查 | 结果 | 日志 |
|---|---|---|
| 修改前负对照：原 CLI 两文件 + 新测试 | 9 failed / 15 passed，复现两个旧失败及新增边界失败 | `/tmp/scry-doctor-negative.log` |
| macOS focused：CLI + runtime + attention + inbox + daemon | 6 文件 / 59 passed | `/tmp/scry-doctor-focused.log` |
| `npm run test:unit -- --maxWorkers=1` | 579 文件 / 5483 passed，4 个原有 opt-in 用例 skipped，0 failed；1258.53 s | `/tmp/scry-doctor-unit.log` |
| Linux guest 同组 focused | 6 文件 / 59 passed | guest `/tmp/scry-doctor-focused-linux.log` |
| macOS / Linux 构建后真实 CLI 子进程 | 健康退出 0；旧 inbox、status 先读 inbox、无 transcript 旧 open 均正确报警退出 5；原始证据不变且无记录生成 | `/tmp/scry-doctor-cli-{mac,linux}.log` |
| `npm run typecheck` | 通过 | `/tmp/scry-doctor-typecheck.log` |
| `npm run build:cli` / `npm run build` | 通过 | `/tmp/scry-doctor-build-cli.log`、`/tmp/scry-doctor-build.log` |

跨平台场景均使用临时 workspace / HOME / state；未访问真实 Provider。Linux 为 colima arm64 guest，
不是发行版目标机验收。测试环境使用现有 Node 24.18.0（macOS）、24.22.2（Linux）。

## 热路径工作量

复用 `scripts/recorder-engine.measurement.test.ts`，仅取工作量计数，不用并行验证期间的毫秒作结论。
日志 `/tmp/scry-doctor-counters.log`；未改 workload 或 collector。

| 已完成目录数 | 恢复 readdir / readFile | 单次 pending-health readdir / readFile |
|---:|---:|---:|
| 0 | 7 / 12 | 4 / 2 |
| 200 | 7 / 12 | 4 / 2 |
| 1000 | 7 / 12 | 4 / 2 |

这些计数与 R3 的已记录结果一致。pending / stale 读取增加一次索引存在性 stat，以区分
“无索引”和“索引为空”；不能据此声称总 I/O 完全不变或有 L2 加速。

## 边界与交付

不修改 `.scry/records` 格式、分配、去重或原子写入，不放宽 trust、路径授权或 renderer 隔离。
修复在共享读取层，覆盖 doctor 与相邻 status 入口，不只改 CLI 的退出码或测试期望。
构建产物验证不等于日常安装版本升级；不自动安装全局 CLI、不发布 npm、不推送或合并 main。
本地自查确认修改仅限共享诊断读取逻辑、9 项回归及说明；最终 diff 无无关改动，类型检查、构建与
全量单测均通过。Linux 临时 worktree 已清理，Colima 已恢复停止状态；临时夹具自动删除，完整验证
日志保留在上述 `/tmp/scry-doctor-*` 路径，未操作用户日常运行的 App / daemon。
