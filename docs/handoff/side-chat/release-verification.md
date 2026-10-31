# 侧边会话发布前门禁验证（本轮）

状态：**历史轮次（安装前，PRE-INSTALL）**。本轮只做门禁与必要修复；当时**未**升版本、未打包安装、未 push，日常实例仍是旧构建 `0.2.230`。此文件下面的门禁结果、首次失败台账与性能数据是那一轮的原始记录，**未改写**；后续版本提升、全量门禁与安装结果见 **[final-delivery.md](final-delivery.md)**，续作状态见 [continuation-checkpoint.md](continuation-checkpoint.md)。

> 证据表述已按后续校订：未知原因一律标 `UNKNOWN`，不再用未取得的观测支撑因果判断。

## 身份

- 集成分支 HEAD：`cf25a103`（merge：`fcd40cf4` 功能 + `beac4da8` main）。本轮在其上新增两个修复提交：
  - `107a9208` test(terminals)：晋升断言改读 durable 工作台命名空间。
  - `72ec35cc` fix(renderer)：虚拟化历史锚定与精确视图恢复各自保留。
- 版本：根 `package.json` `0.2.230`；私有 CLI `packages/turn-recorder-cli` `0.2.52`（本轮不动）。
- 已安装产物（本轮之前、未重装）：`/Applications/Scry.app`，App `0.2.230`，`app.asar` SHA-256 `05c088c95e172cf7dd99aa7afb22ef84ba2a53e10499e17e6612d9a864ad0dbc`。
- Node `22.22.1`（`/Users/baobingjiang/.nvm/versions/node/v22.22.1/bin`），npm `12.2.0`；darwin-arm64。
- 全部日志：`$TMPDIR/scry-release-gates-0jw8gcKN/`（下文用 `<logs>/`）。

## 门禁结果

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run test:renderer:ui`（完整既有矩阵） | 通过 | `<logs>/renderer-ui-final.log`（最终代码，代码与 `72ec35cc` 相同，退出码 0，含 Credits、side-chat、conversation IPC、pi-native-history；`renderer-ui-run4.log` 为同一逻辑在等价重构前的矩阵结果） |
| `npm run check:cli-release` | 通过 | `<logs>/cli-release.log`，vitest 145 s，`build:cli`，`npm pack` + 临时目录安装 smoke：`version 0.2.52`、`init idempotent`、`hook recorded`、`doctor healthy`（其代码范围 CLI/core/shared/main 与最终 HEAD 相同） |
| `npm run performance:measure -- --compare beac4da8… --out <fresh>` | 通过（`Ratchet: passed`，候选 `72ec35cc` 干净工作区） | `<logs>/perf-measure.log`，产物 `$TMPDIR/scry-perf-compare-ToFCKDX8/{candidate,baseline,comparison,measure}.json`、`ratchet.md` |
| `npm run test:unit -- src/renderer/chat-scroll.test.ts src/renderer/conversation-view-restore.test.ts` | 通过（11 tests） | 本轮新增 4 + 更新 7 |
| `npm run typecheck:web` | 通过 | 修复后与重构后各一次 |
| `npm run test:side-chat:ui` | 通过（最终代码） | `<logs>/side-chat-ui-final.log`，步骤 `scroll`→`adoption` 全绿 |
| `scripts/session-performance-ui-smoke.mjs` | 通过（最终代码） | `<logs>/session-perf-final.log` |

本轮未触发也未修改 workload、collector、ratchet、baseline、`performance-paths.json`：

```
git diff --name-only cf25a103..HEAD -- scripts/performance-counters scripts/performance-ratchet.json \
  scripts/performance-ratchet scripts/performance-paths.json packages/turn-recorder-cli/package.json
# 空
```

## 首次失败台账（全部保留，含重跑结论）

1. **`desktop-remote-ui-smoke.mjs --session-opening-only`（首次运行）**
   `Error: Timed out: late history layout remains at bottom`（`<logs>/renderer-ui.log`，退出码 1，含完整 DOM 快照）。
   后续：同一命令重跑通过（`opening-only-run2.log`），同一代码的完整矩阵重跑也通过（`renderer-ui-run2/4.log`、`renderer-ui-final.log`）。
   **原因 UNKNOWN**：本轮没有采集隐藏窗口的帧回调与可见性状态，所以不能把这次超时归因于“隐藏窗口 rAF 重钉底”或“并发负载”。
   只有一条代码事实：该断言路径上的钉底函数本轮未改动（新增的 `transcriptGrowthAboveEdge` 只被行测量使用），因此不支持“新规则直接改坏该断言”。
   复发时的下一条诊断：保留失败 fixture 的 `exercise.cjs` 与 DOM 快照，并同时采集该窗口的 rAF 调用计数与 `visibilityState`，用它区分“帧回调被节流”与“钉底计算错误”。不把这次失败当作已通过抹掉。

2. **`session-capability-ui-smoke.mjs` 默认（第 2 次运行）— 真实集成缺陷**
   `Terminal restored: timed out: JSON.parse(sessionStorage.getItem('scry.session-right-surfaces.v1')).some(…'native-one')`（`<logs>/renderer-ui-run2.log`、隔离复现 `terminals-only-run1.log`）。
   原因：功能分支把本地工作台改为 durable `localStorage`（`right-surface-storage.ts` 的 `SURFACE_STORAGE_KEY = 'scry.session-right-surfaces.v2'`，旧 v1 只读一次做迁移），断言的写入侧仍盯着旧键。
   修复：`scripts/session-terminals-ui-check.mjs` 改读 durable 命名空间（提交 `107a9208`）；fixture 仍只种旧键，因此前面 `attaches === 1` 的断言继续证明一次性迁移。
   负控：把谓词改成 `'native-one-missing'` → 同一测试失败（`terminals-negative-control.log`），证明新断言读的是真实数据。修复后 `terminals-only-run2.log` 退出码 0。

3. **`session-performance-ui-smoke.mjs` — 真实回归（功能分支）**
   `Condition timed out: …turn-60… < 2`；锚点从 `84.03` 漂到 `394`（`<logs>/renderer-ui-run3.log`、`session-perf-run1.log`，行测量 trace 见 `session-perf-trace.log`：turn-59 跨顶边，`prev=240`，功能分支规则不再补偿它）。
   判定实验：把 `transcript.tsx` 的第一测量规则改回 main（`firstMeasurement ? rect.top`）→ 冒烟退出码 0（`session-perf-revert-anchor.log`）。
   但 main 规则会破坏侧边会话的精确恢复（见下条），所以两条合同都真实存在。

4. **`test:side-chat:ui` 的 `scroll` 步骤（main 规则下）— 反向证据**
   `a tab switch lost the long-transcript reading position: {"target":{… "offset":-80 …}}`（`<logs>/side-chat-ui-v1rule.log`）。
   证明“恢复锚点行自身的增长不得补偿”是必需行为，不能简单回退 main 规则。

5. **同一步骤的 `Error: CDP WebSocket 已关闭`（`<logs>/side-chat-ui-afterfix.log`，06:33）**
   已知事实（只列有证据的部分）：
   - 失败形态是 CDP 传输被关闭（`electron-security-cdp.mjs` 的 `socket.onclose` → `rejectPending`），不是断言不成立；
   - `~/Library/Logs/DiagnosticReports` 在该时刻没有 Electron 崩溃报告（现存最近报告为 `node-2026-10-29-070712.ips`，与 06:33 无关）；
   - 捕获到的 App stderr 只有 fixture 噪声 `session diff baseline not ready`，没有崩溃栈；
   - 同一 `scroll` 步骤随后通过（`side-chat-ui-run3.log` 07:04、`side-chat-ui-final.log` 07:20，后者是最终代码），完整矩阵最终也通过（`renderer-ui-final.log`）。
   **原因 UNKNOWN**：本轮没有证据把这次关闭归因于环境负载，也没有证据排除外部进程对本轮 App 的任意终止。`owned-app-processes.mjs` 只按登记的 pid 身份发信号，这只能说明“本轮没杀别人的 App”，不能说明“没有别的东西杀掉本轮的 App”。
   另需更正：`load average 22.98` 是 **07:01** 采样的 15 分钟均值，比 06:33 的失败晚约 28 分钟，**不是同一分钟**的观测，不能当作当时负载的证据。
   复发时的下一条诊断：失败瞬间记录 fixture App pid 是否仍存活、该时段的进程信号/退出日志与 renderer 崩溃事件，用它区分“进程被杀”与“传输层断开”。不宣称“已通过”覆盖首次中断。

（台账附注，非产品错误：上一轮曾用 `node --test` 跑一个 Vitest 的 CDP 测试文件，已改用 `npm run test:unit -- <file>`，3 项通过。）

## 两条滚动合同的修复（提交 `72ec35cc`）

`src/renderer/chat-scroll.ts` 新增纯函数 `transcriptGrowthAboveEdge`：

- 普通行（main 合同）：`firstMeasurement ? top : top + previousHeight` 小于顶边才补偿，即“顶边之上的行长大”时钉住下面内容 —— 由 `session-performance-ui-smoke` 的 turn-60 锚点断言钉住。
- 唯一豁免：`applyViewRestore` 刚定位的那一行（`data-restore-anchor` 标记，`transcript.tsx` 在下一测量消费并删除）。该行的读者位置就在它内部、且在顶边之上（实测 `offset = -80`），补偿把它推离记忆位置。

证据：`$TMPDIR/scry-app-driver-phpIdE/verification.json`（最终代码，side-chat `scroll`：`seeded 130`、`afterSwitch.anchorOffset -80`、`afterReopen.anchorOffset -80`、`turns 40`、`readsAfter 2`、`readsReopen 2`、`closeDeleted false`、`child record turns 130`；`out/main/index.js` sha256 前缀 `3244f9bdf112`）。
负控：`restoreAnchor && false` → `chat-scroll.test.ts` 的豁免用例失败（1 failed / 3 passed），恢复后 11/11 绿。

## 性能结论（计数器，不是毫秒）

候选 `72ec35cc`（干净）对比 `beac4da8`（temp detached worktree + 候选 harness、同一 `node_modules`），135 项全部 `measured`，没有 missing/unavailable；门禁项不变：`source-control.diff/subprocess.git` 8→8、`source-control.service.status-diff/subprocess.git` 10→10（五次重复值相同）。

`worse` 3 项，逐项判定：

| 指标 | beac4da8 | 72ec35cc | 判定 |
|---|---:|---:|---|
| `files.fixed-operations/io.read.payload.bytes` | 1398144 | 1398153 | +9 B / 1.4 MB，两侧自身重复跨度 32 B 与 41 B；delta 小于同侧跨度，**提示**是抖动，不是因果证明 |
| `trace.r4-cell/other.stringify-bytes` | 101122699 | 101122703 | +4 B / 101 MB，同侧跨度 28 B，同上只是提示 |
| `trace.r4-cell/total.stringify-bytes` | 156159839 | 156159843 | +4 B / 156 MB，同侧跨度 28 B，同上只是提示 |

`better` 2 项（`hash-update-bytes` −2、`total.hash-update-bytes` −2）同样落在同侧跨度内，因此不宣称“变快”，也不宣称哈希更新被优化。

“落在同侧重复跨度内”只能说明噪声量级不小于差值，不能证明差异的来源；本轮没有做重复对照实验去归因那几字节。

台账（`scripts/performance-ratchet.json` 记录的旧基线）另标出 5 项 candidate `worse`：其中 4 项与 `beac4da8` 的实测值**完全相同**（`io.readdir 20→20`、`persistence.archive/ipc.bytes 10558→10558`、`recorder.content-cold/io.stat.calls 44→44`、`workspace-choices-current-run/git.run.calls 10→10`，五次重复值一致），因此这些是 main 相对更早基线的既有漂移，不是本功能引入；第 5 项即上表第一行的字节差异。按既有规则不改基线、不加 raise、不改 workload。

限制：这是固定工作负载的 CPU/IO/IPC 计数，不代表用户毫秒体验；未做 L2/L3 宣称；未运行需要 `timing-run` 锁的毫秒基准；未分析用户日常性能日志（无上传）。机器在本轮多数时间处于高负载（其他会话并发跑 Electron fixture），**因此不能宣称这些计数整体免疫环境**：只有上表逐项比较过同侧重复跨度的那些差值有条件说是噪声量级，其余指标没有做环境对照。

## 未验证 / 不宣称

- 真实付费 Provider 账号、手机（iCTRL）真机、系统级焦点/剪贴板；本轮全部 App 证据来自隔离临时 HOME/userData/workspace 的隐藏实例。
- 未升版本、未打包、未安装；日常实例未更新，`/Applications/Scry.app` 仍是 `0.2.230`（`app.asar` 未变）。
- 未 push。
- 临时证据目录位于 `$TMPDIR`，可能被系统清理；表中路径为当次实测位置。

## 下一步（交回父会话）

源码冻结候选已成立，本轮不再有剩余门禁。按父会话决定，版本与安装阶段应把私有 CLI 一起升到 `0.2.53`（`normalizeTurnDiffSnapshot` 现在保留 `workspaceOverlap`，属于私有 CLI 运行合同变化），App 升到 `0.2.231`，但不 `npm publish`。

（后续已按此执行：版本 `0.2.231` / `0.2.53`、升版后全量门禁与 `install:mac:dev` 安装结果、首次失败与未验证项见 [final-delivery.md](final-delivery.md)。）
