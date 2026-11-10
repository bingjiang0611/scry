# c0e009e 验证报告：未读角标 / 新会话 / 删除文案 / 只收集证据项

验证对象：`c0e009ec`（`fix(remote): clear unread marks for sessions on screen; new session in daemon mode`，分支 `claude/scry-performance-optimization-46ngcf`）。
本目录只放验证报告与证据，不改产品代码。

## 结论

| 项 | 进程内 | daemon |
|---|---|---|
| 隔离（临时 userData） | PASS | PASS |
| A1 切走会话后回复 +1 | PASS | PASS |
| A2 打开会话角标消失 | PASS | PASS（`attentionViewed` 日志子项无法验证，见 A2） |
| A3 聚焦停留不增加 | PASS | PASS |
| A4 失焦 +1 / 切回消失 | PASS | PASS |
| A5 主窗格 X + 侧边会话不计未读 | PASS | PASS |
| B 普通会话聚焦无角标/未读点 | PASS | PASS |
| C 新会话按钮无原始错误、进空白新会话、开新 Provider 会话 | PASS | PASS |
| D 删除失败文案可读 | 未执行（原因见 D） | PASS |
| E1 头部按钮被 `.chat-transcript` 盖住 | 未复现 | 未复现 |
| E2 运行中停止是否显示“本轮已中断” | 证据 5/5 | 证据 5/5 |
| E3 统一会话运行中再发 | PASS | PASS |

`report.json` 自报：进程内 `passed 11 / failed 0 / skipped 1`，daemon `passed 12 / failed 0`。

## 验证环境与方法

- 独立 worktree（detached `c0e009ec`）+ 每模式一份全新临时 userData/HOME/workspace；不触碰日常实例。
- 两种模式对照：进程内不设 `SCRY_HOST_DAEMON`；daemon 设 `SCRY_HOST_DAEMON=1`。
- Provider：仓库自带 codex smoke fixture（`SCRY_ELECTRON_SMOKE_PROVIDER=1`）。
- 隔离自证：`scry.db`/`-wal`/`-shm` 句柄、daemon 目录（`daemon.lock`/`enroll.sock`/`local.sock`）、daemon 进程 lsof 中的 db/socket/ledger 全部落在临时 userData；`realUserDataLeaked: []`。
- 取证方式：main entry 外包一层 instrumented 模块（只记录 `app.setBadgeCount`、`webContents.send`、`agent:viewSessions`/`agent:newSession`/`agent:unreadSessions` 的 IPC），业务代码未改。脚本见 `harness/`。
- 运行环境：macOS，用户 `test`，Node v24.18.0，npm 11.16.0，Electron 42.10.1。

### 环境限制（影响解释，不代表产品问题）

1. 宿主 Aqua 前台是 `loginwindow`，`app.focus()`/osascript 拿不到真实 OS 焦点。聚焦信号由 fixture 覆写 `BrowserWindow.prototype.isFocused()` 并注入 `focus`/`blur` 事件——产品读取的窗口焦点信号为真，OS 级前台焦点为模拟。
2. daemon 模式用 `SCRY_TEST_APP=1` 隐藏窗口（否则 macOS Safe Storage 提示会卡住宿主窗口加载），daemon supervisor entry 用 `app.getAppPath()` 覆写到该 worktree。
3. 结论仅对 codex smoke fixture 成立；真实 Provider 的会话 id 形态、审批交互未覆盖。

### 复现方式

`harness/harness.mjs` 顶部的 `root` / `evidenceRoot` 是本次机器的绝对路径，需改成自己的 checkout；`harness/verify.mjs` 的 `import` 同样指向上面的 worktree。改好后：

```bash
node harness/verify.mjs inprocess   # 不设 SCRY_HOST_DAEMON
node harness/verify.mjs daemon      # 设 SCRY_HOST_DAEMON=1
```

## A. 统一会话角标

步骤：A1 打开统一会话 C1 后切到普通会话、触发 C1 回复；A2 点回 C1；A3 停在 C1 发消息；A4 切到别的应用再切回；A5 主窗格普通会话 X 与侧边会话同时可见，各发一条。

| 项 | 进程内 | daemon |
|---|---|---|
| A1 | `unreadSessionKeys` 1 条、`badgeCount 1` | 同 |
| A2 | `[]`、badge 0；`agent:viewSessions` 3 次 | `[]`、badge 0；`agent:viewSessions` 记录存在 |
| A3 | `[]`、badge 0 | 同 |
| A4 | `badgeBackground 1` → `badgeAfterRefocus 0` | 同 |
| A5 | 三阶段快照均空、`dots 0`、badge 0 | 同 |

**A2 的 daemon 日志子项没有通过。** 要求“daemon 日志见 `attentionViewed`”，但这一版 daemon 没有该日志：`src/daemon/local-endpoint.ts:101` 的 `attention: { viewed: … }` 直接清 set，无任何 `console` 输出；`grep attentionViewed daemon/app.log` 0 命中，属能力缺失而非实现失败。

替代证据（证明 daemon 侧确实收到清除）：A1 让 daemon 未读集合变 1 条，A2 打开会话后 `agent:unreadSessions` 返回空——主机侧只有 `viewSessions → attentionViewed` 一条清除路径；A4 再交叉一次：后台只记 1 条（不是 2 条），重新聚焦后清 0。

**A5 观察（两模式一致，未定性）：** 断言点 `unreadSessionKeys` 恒空、未读点 0，但 badge 在 X 回复收尾出现一次瞬态 `1 → 0`：进程内 `1794325666156`(1) → `1794325666173`(0)，约 17 ms；daemon `1794325793091`(1) 随即归 0。成因未在源码层确认（`src/main/dock-badge.ts` 的 `markAttention`/`clear` 竞态与 `clear` 内 `sync()` 都可能写入该对）。按“只收集证据”未修。

证据：`inprocess/report.json`、`daemon/report.json`（`results[A1..A5]`、`badgeLog`、`badgeByStep`），截图 `*/screens/*-A1-badge-plus-one.png`、`*-A2-cleared.png`、`*-A3-no-unread.png`、`*-A4-*.png`、`*-A5-side-chat-no-unread.png`。

## B. 普通会话聚焦（daemon 与进程内对照）

步骤：聚焦窗口，打开普通会话 `desktop remote write one`，发送并等回复结束。
预期：无角标、无侧栏未读点。
实际：两模式均 `after: []`、`dots: 0`、badge 0；该步 badge 时间线全 0。
结论：PASS。

## C. 新会话按钮

步骤：打开统一会话 C1，点侧栏“新会话”，检查无原始 IPC 错误、进入空白新会话，再发一条消息。
预期：无 `Error invoking remote handler` 等原始字符串；空白新会话；消息进入新 Provider 会话而非续接上一个。

daemon（PASS）：

- `rawErrorVisible: false`；`agent:newSession` 返回 `true`；
- 空白页有 composer、`turns: 0`；
- 侧栏行 `["对话 8e68bac4","对话 dc3a387f","desktop remote write one"]` → 增加 1 行；
- 原会话 `seedTurnsBefore 3 → seedTurnsAfter 3` 不变；
- 决定项（`archive-evidence.json`）：该轮 run 归档在新原生会话 `smoke-session-remote-run-…-3`，与 seed `smoke-session-remote-run-…-0` 不同，`newProviderSessionConfirmed: true`。

进程内对照（PASS）：smoke `inputs.jsonl` 中该次输入 `resume: null`、`sessionId` 与旧会话不同；归档同样指向新的 `smoke-session-run-…-3`。

说明：早前一版验证判 FAIL 是观测手段问题（daemon 下 `focusedRunSnapshot` 不带会话 id、宿主 `listSessions` 返回 0 条）。改为“侧栏行 + 原会话轮数不变 + 归档 sessionId”后结论成立。

## D. 删除对话框文案

- 进程内：**未执行，不标为通过**。原因：进程内删除会成功，走不到失败文案分支。
- daemon：PASS。让统一会话删除失败后 alert 文案为：
  `后台服务尚未提供这项功能（conversation:delete）。结果不能假定为未删除，请关闭后刷新证据核对；不会自动重试。`
  `rawWrapper: false`，未出现 `Error invoking remote handler`。
- 截图：`daemon/screens/daemon-D-delete-error-copy.png`。

## E. 只收集证据（未改代码）

### E1 头部按钮是否被 `.chat-transcript` 盖住

步骤：打开统一会话，对每个可见 toolbar 按钮中心坐标执行 `document.elementsFromPoint(x,y)`；分别在选项面板闭合、展开两态测量；记录按钮与 `.chat-transcript` 各级祖先的 `z-index/position/overflow/transform/isolation`。

结果：**两模式均未复现遮挡**（`coveredCount: 0`）。

| 模式 | 状态 | 可见按钮 | 被盖住 | 中心命中栈顶 |
|---|---|---|---|---|
| 进程内 | 闭合 | 2 | 0 | `btn` / `summary`（对话选项） |
| 进程内 | 展开 | 5 | 0 | 全部是按钮自身 |
| daemon | 闭合 | 2 | 0 | 同上 |
| daemon | 展开 | 5 | 0 | 同上 |

关键样式：`.chat-transcript` 计算值 `position: static; z-index: auto; overflow: hidden auto; transform: none; isolation: auto`；toolbar 与按钮同为 `static/auto`；下拉面板 `.unified-management` 为 `position: absolute; z-index: 20; background rgb(21,21,21)`，因此面板绘制在 transcript 之上。把 transcript 滚到 `scrollTop 0` 与 `60`（内容顶到面板下方）后重测，命中栈顶仍是 `btn`。

容易误判的点：`<details>` 关闭时面板子元素仍有非零 `getBoundingClientRect`，但不参与绘制与命中测试。最初一版测量未做 `checkVisibility` 过滤，把“面板关闭时的隐藏按钮”算成 covered；加可见性过滤后为 0。若原始复现是在面板关闭态取样，结论可能是该假阳性。

未覆盖：该次测量期间页面上只有一个会话 toolbar（主窗格）；侧边会话的 embedded toolbar 当时不在激活标签，未测。

证据：`inprocess/e1-header-occlusion.json`、`daemon/e1-header-occlusion.json`、`e1-container-styles.json`（单次探针输出，脚本未随附），截图 `*/screens/*-E1-closed.png`、`*-E1-options-open.png`。

### E2 运行中点停止是否显示“本轮已中断”

步骤：普通会话运行中点停止，每模式 5 次；每次记录运行中 turn 文本、主进程 `agent:stopState`/`agent:turnDone` 顺序，离开再打开该会话复看一次。

| 指标 | 进程内 | daemon |
|---|---|---|
| 运行中的 turn 缺“本轮已中断”（5 次） | 5/5 缺 | 5/5 缺 |
| 重新打开后缺提示（5 次） | 0/5 缺 | 0/5 缺 |

典型顺序：

- 进程内：`agent:session → agent:focusedRun → agent:stopState(interrupt_requested) → agent:dataUpdated → agent:turnDone → agent:stopState(settled)`
- daemon：`agent:session → agent:stopState(interrupt_requested) → agent:dataUpdated → agent:turnDone → agent:stopState(settled)`（daemon 无 `agent:focusedRun`）

文本对照：运行中 tail 结尾 `…chunk 1 … 在新会话中分支`；重开 tail 为 `…chunk 1 本轮已中断，不代表任务完成。 …`。状态条出现 `停止中 已请求 codex 取消当前轮次，等待 Provider 收口`。

归档侧：被停止的 5 个 run 在 trace archive 中 `status: interrupted`，即“中断”事实已落盘，只是运行中的视图不显示该提示。

证据：`*/report.json` → `results[E2].actual.attempts`，截图 `*/screens/*-E2-stop-1..5.png`。

### E3 统一会话运行中再发

两模式一致：发送按钮 `disabled: true`；空输入时 `title="发送"`，输入文字后 `title="当前轮仍在投递"`；状态条文案 `运行中 可继续输入，新消息将加入队列 00:00 停止本轮`。

观察（不改）：状态条说“可继续输入，新消息将加入队列”，但发送按钮实际禁用，两处语义不一致。

截图：`*/screens/*-E3-send-while-running.png`。

## 附：daemon 启动期能力不可用日志（证据，不修）

daemon 模式的 main 日志中共 73 条 `Error occurred in handler for …: daemon_capability_unavailable`：

| 次数 | 通道 |
|---|---|
| 31 | `workspaceSelection:read` |
| 18 | `agent:usageStats` |
| 16 | `agent:gitDiff` |
| 4 | `agent:listCommands` |
| 1 | `agent:unreadSessions` |
| 1 | `conversation:delete` |
| 1 | `agent:invalidateProviderContext` |
| 1 | `agent:runControls`（`Error: provider…`，文案不同） |

都发生在 daemon 握手/能力快照就绪前，属于设计上的“能力未知”。渲染端对 `unreadSessions` 已 `.catch(() => {})`（`src/renderer/app-state.ts:85`）；`conversation:delete` 的失败在 D 中显示为可读文案。其余通道（`workspaceSelection:read`、`usageStats`、`gitDiff`、`listCommands`）在 UI 上是否降级为提示、是否造成可见闪烁，本次未逐个确认。

是否由 `c0e009e` 引入：未验证。该提交对通道门控的改动只涉及 `agent:viewSessions`（改为进程内通道）与 `agent:newSession`（新增 daemon 本地 op），没有触碰上表其余通道；但未用父提交做对照运行。

## 证据清单

```
README.md
e1-container-styles.json
harness/harness.mjs
inprocess/
  steps/{isolation,A1..A5,B,C,D,E1,E2,E3}.json
  badge-timeline.json
  ipc-signals.json
  archive-evidence.json
  e1-header-occlusion.json
  app.log
  screens/*.png
daemon/
  steps/{isolation,A1..A5,B,C,D,E1,E2,E3}.json
  badge-timeline.json
  ipc-signals.json
  archive-evidence.json
  e1-header-occlusion.json
  app-log-excerpts.txt
  screens/*.png
```

- `steps/*.json`：单项的 expected/actual/pass 原文（与 `verify.mjs` 的 `record()` 输出一致）。
- `badge-timeline.json`：每次 `app.setBadgeCount` 的时间戳与计数（`badgeLog`），以及按步骤归因的每步最大值（`badgeByStep`：事件归到“开始时间不晚于它”的最近一步，末尾事件可能落进下一步）。
- `ipc-signals.json`：`agent:session`/`agent:focusedRun`/`agent:stopState`/`agent:turnDone`/`agent:unreadSessions` 的生命周期事件、`agent:viewSessions`/`agent:newSession`/`agent:unreadSessions` 的 IPC 收据；进程内另附 C 那一次的 smoke provider 输入（含 `resume: null` 与新 `sessionId`）。
- `archive-evidence.json`：C 的原生会话 id 判定依据（`newProviderSessionConfirmed`）。
- `e1-header-occlusion.json`：E1 每按钮中心坐标、命中栈、按钮与 `.chat-transcript` 各级祖先的计算样式。
- `e1-container-styles.json`：单独一次探针的下拉面板/transcript 容器样式（脚本未随附）。
- `inprocess/app.log`：进程内 main 进程 stdout/stderr 全文（1.4KB）。
- `daemon/app-log-excerpts.txt`：daemon main 日志摘录（原文 442 行，超过 20KB/文件提交预算，按开头 + 错误行摘录）。

### 为什么证据是拆分的，以及少了两样

`scripts/check-staged-file-size.mjs` 限制单文件 20,000 字节，PNG 除外。因此：

- 原始的 `report.json`（约 100KB/模式）按单项拆成 `steps/*.json`，并把 `badgeLog`/IPC 收据/输入拆成 `badge-timeline.json` 与 `ipc-signals.json`；`ipc-signals.json` 里 `sessionKeys` 只保留会话 id 尾段，`inputs` 只保留 C 那一次。
- daemon 原始日志 442 行（36KB）无法整文件提交，改为 `app-log-excerpts.txt`；进程内日志 1.4KB 全文保留。
- **步骤驱动脚本 `verify.mjs` 未随附**：它单文件 37KB，超过同一预算；事后重构拆分会让它不再是产生这批证据的那个脚本。`harness/harness.mjs`（instrumented main entry、临时 userData/焦点 fixture/daemon 环境）才是难以重写的部分，已随附；`verify.mjs` 的每一步在 README 与本目录 JSON 里有 expected/actual 原文。

## 清理与仓库状态

- 测试 App 与测试 daemon 均已退出（两轮 `teardown`：`appAlive:false`，`daemonAlive:false`；`pgrep -f scry-verify-c0e009e` 为 0）。
- 用户日常实例（`/Applications/Scry.app`，`user-data-dir=/Users/test/Library/Application Support/scry`）未停止、未重启。
- 本目录所在分支 `claude/scry-verify-c0e009e` 从 `c0e009ec` 拉出，只包含本报告与证据。
- 截图按本次明确要求随报告提交；仓库默认约定是截图留在本地工作区（见 `.gitignore` 注释）。截图只含临时 fixture 工作区内容（`/tmp/scry-verify-*`、smoke provider、`README.md` fixture），不含真实会话或内部资料。
