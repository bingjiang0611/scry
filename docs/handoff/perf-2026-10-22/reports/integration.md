# 整合报告：perf/integration-2026-10-23

## 结论

五个分支已按顺序 `--no-ff` 合入。没有源码冲突。

本机环境：macOS darwin-arm64，Node 24.18.0，Electron 42.10.1。在合并结果 `940ea76` 上，7 个指定 gate 都在**第一次运行时通过**，`npm run test:renderer:ui` 整条通过。

整合前未验证的 A1（Claude 停止/强制停止）和 B2（`catalog_recovered` 侧栏自动刷新）已在独立 test 实例中重放，均通过。

本分支未合入 main，未安装 App，未修改 `STATUS.md`。

## 合并记录

起点：`origin/perf/handoff` = `a360d83`。合并前执行了 `git fetch --prune`，各分支均使用远端最新提交：

| 顺序 | 分支（远端提交） | 合并提交 | 冲突 | 处理 |
|---|---|---|---|---|
| 1 | `fix/chat-preview-workspace-dirty`（`462fd95`） | `0daaabc` | 无 | — |
| 2 | `perf/c-git-readonly`（`96721b9`） | `e62b6fe` | `STATUS.md`、`docs/performance-opportunities.md` | STATUS 取 perf/handoff 版本；opportunities 两段都保留 |
| 3 | `perf/d-renderer-transcript`（`1231c0b`） | `035c6a2` | `STATUS.md`、`docs/performance-opportunities.md` | 同上 |
| 4 | `perf/e-remote-delta`（`e78a9b6`） | `774294e` | 无 | — |
| 5 | `perf/f-ios-observable`（`aedb1f1`） | `940ea76` | `STATUS.md` | 取 perf/handoff 版本 |

- 冲突文件与 STATUS「整合预检」的试算结果一致，没有出现源码冲突。
- 合并后，`git diff origin/perf/handoff -- docs/handoff/perf-2026-10-22/STATUS.md` 为空，说明 STATUS 与 perf/handoff 版本相同。
- `performance-opportunities.md` 顶部按以下顺序保留三段：perf/handoff 的批次 A、批次 C、批次 D。三段文字均原样保留，没有改写；所有变更文件中都没有残留冲突标记。
- 未合入 `perf/f2-ios-stream-layout`。fetch 后，远端也没有这个分支。
- `fix/chat-preview-workspace-dirty` 和 `perf/c-git-readonly` 的远端提交比各自的修复提交多出审查方的核验文档提交（`462fd95`、`96721b9`）。本次合并的是包含这些文档的远端最新提交。

## 完整 gate（合并结果 `940ea76`）

| 检查 | 首次结果 | 证据 |
|---|---|---|
| `npm run typecheck` | 通过，15 s | `/tmp/scry-int/typecheck.log` |
| `npm test` | 通过，284 s：unit 308 个文件、**3777 pass / 4 skipped**（opt-in 探针）；shell `PASS setup-scry-workspace` | `/tmp/scry-int/test.log` |
| `npm run build` | 通过 | `/tmp/scry-int/build.log` |
| `npm run check:cli-release` | 通过，92 s：typecheck、CLI 合同 32 个文件 / 624 pass、`build:cli`、CLI 包冒烟（`scry-turn-recorder` 0.2.51） | `/tmp/scry-int/check:cli-release.log` |
| `npm run test:renderer:ui` | **整条通过**，229 s，开始时 load 5.87。16 个阶段全部执行，包括已修复的 chat-preview workspace dirty 阶段 | `/tmp/scry-int/test:renderer:ui.log` |
| `npm run test:desktop-remote` | 通过，120 s：build、`build:cli`、session-opening、host smoke（`--dev`）、主流程、parity、composer-history、remote-settings、session-lifecycle | `/tmp/scry-int/test:desktop-remote.log` |
| `npm run performance:measure -- --compare 531e88c` | 通过，`Ratchet: passed`。在 timing lock 下运行，load 3.52→4.66，`highLoad=false` | `/tmp/scry-int/performance-measure.log`、`/tmp/scry-int/performance/` |

**首次失败：** 7 个 gate 没有首次失败，也没有重跑。

**环境准备：** CI 在运行 UI gate 前会执行 `electron-builder install-app-deps`。本机使用同版本（12.11.1）的 Electron ABI `better-sqlite3`，执行以下步骤：

1. 运行 Node gate 时使用 Node ABI。
2. 运行 UI gate、desktop-remote、重放和 performance 前，替换为 `/tmp/scry-c-electron-native` 中的 Electron ABI 版本。
3. 全部检查结束后恢复 Node ABI，并已验证 Node 能打开内存数据库。

**performance 比较（531e88c → 940ea76）：**

- 43 个计数项都是 `measured`。
- 只有 `files.fixed-operations/io.read.bytes` 变化了 −2 bytes，其余 42 项差值都是 0。
- 2 个门禁项通过：`source-control.diff/subprocess.git` 为 8/8，`source-control.service.status-diff/subprocess.git` 为 11/11。

ratchet 表中有 4 个 better、4 个 worse 和 3 个 CPU instruction missing。它们来自已记录的 candidate 基线，不是本次整合造成的：

- main（`531e88c`）上的同一组计数值与本分支相同。
- 这与 A+B 交付记录中的“4 个必要新工作的 worse、3 个 instruction missing”一致。

本次没有手改 ratchet 文件，也没有生成 proposal。

需要注意，这套固定计数不覆盖 C/D/E/F 各自的专用 profile。例如，C 的 `source-control.diff` collector 走的是未改动的 `readWorkspaceGitDiff`。所以它只能证明本次整合没有使现有计数退化，不能复核各批次的收益。

## 补充验证 a：A1 Claude 停止与强制停止

**目的：** 验证 `agent-runner.ts` 的 `signalSpawnedChild`：

- 异步采集单 PID 身份；
- 先发送经过复核的进程树信号；
- 树信号不可用时回退到子进程句柄。

现有 `SCRY_ELECTRON_SMOKE_PROVIDER` fixture 会**整体替换** Provider adapter。它的 `forceKill` 只修改内存标志，不会经过 `agent-runner` 或真实子进程，因此不能证明 A1。

本次重放使用生产 Claude adapter 和 SDK `query()`，并通过 `SCRY_CLAUDE_PATH` 指向临时的 fake Claude CLI：

- 只讲 SDK 的 stream-json 控制协议，不访问网络或模型，没有费用；
- 启动后会派生一个 `/bin/sleep 300` 孙进程，用来区分进程组/树信号和单句柄信号。

**环境：**

- 在 `out/` 构建产物上启动 dev Electron，使用 CDP；
- 临时 HOME、userData 和工作区；
- 禁用其他 Provider，`SCRY_TEST_APP=1`，`SCRY_REMOTE_HOST=0`；
- 不操作用户正在使用的 App。

**操作：**

1. 通过生产 preload 调用 `window.scry.start({ providerId: 'claude' })`。
2. 等待 fake 的流式文本出现在页面上。
3. 在真实 UI 中点击 `.run-status-stop`（「停止本轮」）。

| 场景 | stopState 序列（相对点击） | turnDone | fake 收到的消息 | 进程结果 |
|---|---|---|---|---|
| 停止：CLI 响应 interrupt | `interrupt_requested@2ms → settled@59ms` | `stopped=true`，48 ms | `interrupt@2ms`，随后 SDK 关闭 stdin（`@4ms`） | fake 与孙进程都已退出（`ps` 查无） |
| 强制停止：CLI 不响应 interrupt，且忽略 SIGTERM/SIGINT/SIGHUP | `interrupt_requested@1ms → force_kill_requested@6003ms → settled@6132ms` | `stopped=true`，6123 ms | `interrupt@1ms`；`interrupt@6003ms`（升级时 `requestStop()` 再发一次）。没有记录到任何可捕获的信号，说明直接收到 SIGKILL | fake 与**孙进程**都已退出 |

- 强制停止在 Claude `gracefulMs` 设定的 6000 ms 时触发。
- 孙进程不会因为父进程死亡而退出。它也消失了，说明 SIGKILL 发给了经过身份复核的进程组/树，而不是只发给句柄。
- `window.scry.onError` 没有收到错误。
- 重放结果：`/tmp/scry-int/replay-a1.log`；现场目录：`$TMPDIR/scry-int-a1-QA59Ir`。

**未覆盖：** 身份不可用（`ps` 超时或失败）时的句柄回退路径，在 App 中没有重放。原因是无法在不修改系统的情况下让 `/bin/ps` 失败。这条路径由 A 的 unit 回归覆盖：负对照时 13 例中有 7 例失败。

## 补充验证 b：B2 `catalog_recovered` 侧栏自动刷新

**构造 userData：** 使用生产写入函数 `createAppSessionStore` 和 `upsertTraceArchiveTurn`，种子脚本由 vite-node 执行。

1. `app-sessions.json` 只记录工作区 W 的 Qoder 会话「B2 已知 Qoder 会话」。
2. 写入该会话的归档后，调用 `discoverTraceArchiveSessionsAsync(['qoder'])` 发布干净的 Qoder 索引。此时没有 dirty 标记。
3. 再写入 W 中的「B2 目录缺失的 Qoder 会话」归档。

种子校验结果：

- `cleanAfterPublish=true`
- `dirtyAfterLoss=true`
- `indexHasLost=false`
- 目录中只有已知会话

可选填充：在 50 个**目录中不存在的工作区**下写入 3000 个 Qoder 归档。这些归档会被扫描，但不应被录入。填充只用于拉长后台扫描时间，让刷新前后的状态可以观察；不填充的版本也已运行。

**操作：**

1. 启动 App。
2. CDP 连上后，在页面内每 10 ms 读取一次 `.sidebar` 的可见文本。
3. 同时订阅 `onDataUpdated`。
4. 观察期间不点击、不 reload。

| 运行 | 已知会话出现 | `catalog_recovered` 事件 | 缺失会话出现 | 启动后的状态 |
|---|---|---|---|---|
| 填充 3000 | 730 ms | 1939 ms | **1950 ms**（事件后 11 ms） | 目录增加缺失会话；dirty 标记已删除；索引含缺失会话（3002 项）；侧栏没有任何 padding 会话；项目列表只有 W |
| 无填充 | 742 ms | 757 ms | 765 ms | 同上（索引 2 项） |

- 在填充运行中，侧栏先只显示已知会话。约 1.2 s 后收到 `catalog_recovered`，缺失会话随即在不经用户操作的情况下出现。
- 这条证据对应「首屏不等待发现，后台恢复后通知刷新」。
- 未知工作区的归档没有被复活成项目或会话。
- 结果日志：`/tmp/scry-int/replay-b2.log`、`/tmp/scry-int/replay-b2-nopad.log`；现场目录：`$TMPDIR/scry-int-b2-Tywp1I`、`$TMPDIR/scry-int-b2-hSaKm1`。

## 重放 harness 自身的问题

以下是 harness 缺陷，不是产品失败，修正后才得到上面的结果：

1. 第一次 A1 运行在等待 fake 启动时超时。原因是模板中的占位符替换先命中了注释，日志路径没有被替换。fake 实际已运行，但日志写进了工作区下的 `__LOG__` 文件。
2. 第二次运行已通过，但「停止」场景选错了进程：选中了 SDK 启动的短命能力探针进程，而不是承载本轮的进程，因此该行没有证明力。修正后改为按收到用户 turn 的进程选择。

两次废弃运行的临时目录已删除。harness 文件位于 `/tmp/scry-int/replay/`，包括 `harness.mjs`、`fake-claude.template.mjs` 和 `seed-b2.ts`。这些文件没有提交到仓库。

## 未验证项与限制

| 项目 | 原因 / 如何补 |
|---|---|
| 真实 Claude Provider 的停止 | 按要求不驱动付费 Provider。fake CLI 只证明 Scry 侧的协议、信号与进程收口 |
| A1 身份不可用时的句柄回退（App 内） | 见上文；仅有 unit 覆盖 |
| F 的 iOS 改动 | 本次 gate 不含 Xcode/Swift，也没有在真机上重新构建。F 的真机证据来自其分支 `aedb1f1`。合并时 apps/ios 只有 F 改动，与其他分支没有文件交集 |
| C/D/E 的收益数字 | 没有在整合结果上重跑各自的专用 profile 或 bench；固定计数只证明没有退化 |
| Node 20/22 CLI 兼容、`pack:artifact`、打包 App 安全冒烟 | 不在本次指定 gate 内，没有运行 |
| L2/L3 | 没有日常样本；不宣称整合后提速 |
| 重放 harness 未入库 | 审查方要复跑时需要使用本机 `/tmp` 文件。是否把它们整理成仓库内的可复用冒烟脚本，由维护者决定 |

## 交付状态

- 分支 `perf/integration-2026-10-23` 包含 5 个合并提交和本报告提交，已推送到同名远端分支；提交哈希见推送记录。
- 未合入 main，未安装 App，未修改 STATUS。
- 测试进程均已退出，没有残留的 fake CLI 或 `sleep` 进程。
- `node_modules` 已恢复为 Node ABI 的 `better-sqlite3`。
- 日志位于 `/tmp/scry-int/`；3 个重放现场目录保留在 `$TMPDIR` 中。

## 核验意见（审查方，2026-10-23）

结论：**已核验**。

- 用 `git show --remerge-diff` 逐个检查 5 个合并提交：手工解决冲突只涉及 `STATUS.md` 和 `docs/performance-opportunities.md`，与预检一致，源码没有夹带改动。合并后的 `STATUS.md` 与 `perf/handoff` 完全相同，`apps/ios` 与 `perf/f-ios-observable` 完全相同。
- 7 个 gate 第一次运行全部通过，`test:renderer:ui` 整条全绿。performance 计数与 main 相比没有退化；报告也说明了固定计数不能复核各批次自身的收益，口径正确。
- **A1 重放**用的是生产 Claude adapter 加不连网的 fake CLI，比 smoke fixture 更接近真实：强制停止后，那个不会随父进程退出的孙进程也被结束，说明 SIGKILL 确实发给了经身份复核的进程树。身份不可用时的句柄回退只有单测覆盖，理由成立。
- **B2 重放**直接看到了“首屏先出、约 1.2 s 后收到 `catalog_recovered`、缺失会话自动出现”，未知工作区的 3000 个归档没有被复活。

**后续**
- `perf/f2-ios-stream-layout` 已核验，只改 `apps/ios` 和文档；用 `merge-tree` 试算可无冲突合入本分支。
- 重放 harness 留在执行方本机 `/tmp`。建议把 A1 的 fake Claude CLI 和 B2 的种子脚本整理进 `scripts/`，作为以后改停止/恢复逻辑时的回归；是否做由维护者决定。
