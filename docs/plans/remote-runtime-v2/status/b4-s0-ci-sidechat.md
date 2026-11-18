# B4-S0 · CI：side-chat 与统一对话 Electron smoke 失败

日期：2026-11-12。来源：草稿 PR #73 第一次在本分支跑 macOS UI 门禁；维护者本机 Linux 复现到另一处。都在 `scripts/electron-security-smoke.mjs` 的进程内模式（`SCRY_HOST_DAEMON` 未设置）：现象 1、2 在 `--dev-side-chat-only`，现象 3 在 `--dev-unified-conversation-only`。

## 现象

1. macOS CI（job `packaged-electron (2)`，run 43258312810，head e937910）：layout 第 7 步 `Provider text was not shown verbatim`。侧聊子对话发出 `side chat reply <img src=x onerror=alert(1)>` 后，子对话正文里根本没有这一轮，最新可见的是更早一轮被中断的 `hold scope-a`。
2. 本机 Linux：execution 步 `sendChildPrompt` 报 `the send stayed disabled for a registered Provider`，composer 显示「运行中可继续输入，新消息将加入队列 … 当前轮仍在投递」，而 `conversations.read` 已经显示上一轮 accepted、没有 activeRunId。
3. macOS CI（run 43269678102，head f7d7876，与 e937910 的 App 代码相同）：这次 side-chat 通过，失败的是之后的 `--dev-unified-conversation-only`：`Timed out: scrollable transcript follows the bottom`（`scripts/unified-conversation-smoke.mjs:159`）。

## 原因

现象 1、2 是同一个产品缺陷：**统一对话的一轮在 main 里收口后，没有任何可靠的通知让窗口重读这条对话**。不是本分支引入的回归：`origin/main`（41cb921）在同一环境下同一步失败（见下表），相关代码（`conversation-service.ts`、`conversation-read.ts`、`ConversationView.tsx` 的刷新条件）本分支没有改动语义。

进程内收口顺序是 `store.settle`（写 accepted）→ `active.delete(runId)` → `persistRunData` → `turn_recorded` → `runTraces.settle`（流终态）。窗口（`ConversationView`）只在三种情况下重读：

- `conversation_changed`：只有建立、改名/存档、分支、删除才发，**一轮收口不发**；
- `turn_recorded`：只在窗口当前页的 `activeRunId` 等于该 run 时才刷新，而且 SQLite 不可用时 `recordTurn` 返回 false，根本不发；
- 流终态：快照已经 `done` 时 `seed` 立即触发一次刷新，之后真正的终态事件被当作「迟到的第二个终态」忽略。

窗口在 run 进行中读到的任何一页都可能成为最后一页：

- 证据（本机，带临时埋点，未提交）：窗口在发送后 `refresh` 于 …098276 开始；main 在 …098363 写 accepted 并移出 active 集合，…098364 发 `turn_recorded`；窗口收到时它的页还没有 activeRunId（`active: null`），于是忽略；…098418 这次读返回 rev 33、最后一轮 **pending**、**没有 activeRunId**——`readConversationPage` 先读 store、再 `await` 历史投影、最后用当时的 active 集合算摘要，读到的是收口前的记录和收口后的 active 集合。这一页显示「投递结果尚未确认，且没有可关联的运行；请重启核查」，不订阅流，也不再匹配任何 `turn_recorded`，从此不再刷新。持久化记录里这一轮是 accepted/completed。这就是 macOS 的现象 1。
- SQLite 加载失败（本机 Electron 用了 Node ABI 的 better-sqlite3，日志「sqlite 初始化失败，观测分析降级」）时没有 `turn_recorded`，窗口只剩流终态这一条路；若订阅快照已是 `done`，刷新读到「pending + active」（「当前轮仍在投递」），之后再无事件。这就是现象 2。

另有一个 smoke 缺陷：layout 第 7 步 `wait(\`window.scry.conversations.read(...).then(...)\`)` 在 renderer 里同步求值 `!(Promise)`，Promise 恒为真，所以这一等待立刻返回，从未等到这一轮完成。它不是失败原因（失败时记录早已 completed），但让这一步依赖后面 15 s 的正文等待。

### 现象 3 是另一个原因

现象 3 不是上面的陈旧页：它前一步（第 157 行）已经确认两轮都渲染出来、并停在底部；失败发生在随后把视口缩到 1100×700 之后，要求转录仍贴底且溢出 > 32 px。侧聊的现象 1 则是新一轮根本没有渲染（埋点里 DOM 的 run 列表没有它；`origin/main` 失败时滚动位置已在底部 5271/5471、可视 200，仍没有这一轮），与滚动无关。所以两者不是同一个原因，只是都表现为「最新输出没在可见底部」，先后出现取决于时序。

现象 3 的机制与 `origin/main` 的 d9d9c6e（#45「preserve bottom following for queued automatic scrolls」）修掉的缺陷一致，本分支从 main 分出时早于它：贴底时 `scrollTo` 产生的 scroll 事件排队，若视口先缩小，事件到达时离底部的距离变大，`chatBottomStickinessAfterScroll` 把它当成用户上滑，停止跟随。本分支的跟随/窗口化转录代码（`chat-scroll.ts`、`ConversationView` 的滚动、`RemoteChatPresentation`）没有改动，与 d9d9c6e 的父提交逐字相同。本机 Linux/Xvfb 上没有复现这一步（见下表），所以这条因果来自机制和 main 的修复，不是来自本机失败。

## 修复

- 产品（`src/main/conversation-service.ts`、`conversation-service-deps.ts`、`bootstrap/session-catalog.ts`）：`ConversationService` 新增可选依赖 `onTurnSettled(conversationId)`，在一轮的记录收口**并且**该 run 移出 active 集合之后调用（正常终态与启动失败两条路径）；`createSessionCatalog` 把它接到 `publishDataUpdated({ kind: 'conversation_changed', conversationId })`。窗口已有的 `conversation_changed` 刷新随即读到一致的终态；侧栏的项目重载也收到同一通知。daemon host 用同一个 `createSessionCatalog`，因此 daemon 模式同样发出（经 app-event-feed 按对话键合并）。通知是观测附加路径：抛错只记录告警，不改变已记录的结果。
- smoke（`scripts/side-chat-layout-checks.mjs`，第 7 步移到 `side-chat-untrusted-text-checks.mjs` 以保持文件 < 20 KB）：把无效的 Promise 等待换成在 node 侧轮询 `conversations.read`，上限仍为 40 s，超时直接失败。没有放宽任何断言：正文必须原样包含 `<img src=x onerror=alert(1)>`，且不得出现 `img`/`script` 节点；execution 步的发送门禁检查保持「输入后立即读」不变。

- 渲染（`src/renderer/chat-scroll.ts`、`components/RemoteChatPresentation.tsx`、`chat-scroll.test.ts`）：移植 d9d9c6e 的渲染部分，内容与 main 相同。贴底时记下自己设的 offset；之后恰好停在这个 offset 的 scroll 事件算作自己的，不算用户离开，只消费一次；Remote chat 传元素本身以便同一身份查找。d9d9c6e 里的 smoke 改动没有移植。

未做：`readConversationPage` 的读撕裂（旧记录 + 新 active 集合）仍可能让某一次读短暂显示「没有可关联的运行」；有了收口通知，随后的那次读会覆盖它（`refreshGeneration` 只提交最新一次）。是否把摘要与记录做成同一快照，留给维护者决定。`ConversationView` 里依赖 `turn_recorded` 的刷新现在与新通知重复，未删除，以免改变刷新时序。

## 测试

| 测试 | 内容 |
| --- | --- |
| `src/main/bootstrap/session-catalog-settle-notice.test.ts` | 真实 `createSessionCatalog` + `ConversationStore` + `ConversationService`，只替换 Provider 启动。accepted 终态与「启动前失败」两条路径：各发一次本对话的 `conversation_changed`，在通知那一刻发起的读看到最后一轮 accepted/not_sent、无 `activeRunId`、无 `blockedReason` |

| `src/renderer/chat-scroll.test.ts`（main 的版本） | 自己的贴底事件在视口缩小后到达仍保持跟随；真实上滑会取消跟随并消费待定事件；没改变 offset 的贴底不认领事件；Remote chat 用元素身份 |

先失败后通过：修复前 `session-catalog-settle-notice.test.ts` 2 个用例都失败（`expected [] to have a length of 1 but got +0`），修复后 2/2 通过；`chat-scroll.test.ts` 在本分支修复前 2 个新用例失败（6 通过），移植后 8/8 通过。

## 本机运行记录

环境：Ubuntu 容器，`xvfb-run -a`，非 root 用户 `scrysmoke`，临时 HOME；未使用 `--no-sandbox`。Electron 42.10.1。better-sqlite3 只在本 worktree 内用 `electron-rebuild -o better-sqlite3` 换成 Electron ABI（node-pty 的 Electron 头文件下载被代理拒绝，未重建；本 smoke 不用终端）。单元测试时换回 Node ABI。

| # | 代码 | SQLite | 结果 |
| --- | --- | --- | --- |
| 1 | e937910 | 降级（Node ABI） | 失败：execution，`side chat write qoder2` 发送被「当前轮仍在投递」挡住（首跑） |
| 2 | e937910 | 可用 | 失败：layout 第 7 步，与 macOS CI 同一错误；记录里该轮 accepted/completed |
| 3 | e937910 + 临时埋点 | 可用 | 失败：layout 第 7 步；埋点给出上面的时间线 |
| 4 | origin/main 41cb921 | 可用 | 失败：layout 第 7 步，同一现象 |
| 5 | 修复（smoke 仍带只在失败时触发的临时诊断，未触发） | 可用 | 通过：全部步骤（execution → adoption），untrustedText `text: true`、`img: 0`、`script: 0` |
| 6 | 同上 | 降级（与第 1 次同一个二进制） | 通过：全部步骤 |
| 7 | 产品修复 + smoke 等待修复（拆文件前） | 可用 | 通过：全部步骤 |
| 8 | 最终提交 cfedfc8（含滚动移植） | 可用 | 通过：全部步骤 |

统一对话（`--dev-unified-conversation-only`，即 CI 的现象 3 那一步）：

| # | 代码 | 结果 |
| --- | --- | --- |
| U1 | e937910（未修） | 通过：第 159 行未复现 |
| U2 | 收口通知修复，未含滚动移植 | 通过 |
| U3 | 最终提交 cfedfc8 | 通过 |

另跑了 `--dev-unified-conversation-only --workspace-start`（收口通知修复后）一次，通过。现象 3 在本机三次都没有复现，无法给出失败率；macOS 上是否消失只能看 CI。

其他：受影响单元测试 `src/daemon src/main/conversation* src/main/bootstrap src/main/remote/app-event-feed` 121 个文件 651 个用例通过（Node ABI；先用 Electron ABI 跑时 `host-process.test.ts` 因 SQLite 不能加载而缺 `turn_recorded`，换回 Node ABI 后通过，与本改动无关）；`npm run typecheck` 通过。`src/renderer` 单元测试 123 个文件中 121 个通过；`MarkdownLayout.test.tsx`、`SessionRename.test.tsx` 失败于本机以 root 启动 Electron fixture 被 Chromium 拒绝（`Running as root without --no-sandbox`），未改用 `--no-sandbox`，这两项未验证，与本改动无关。

`npm run performance:measure`（L1 计数；改动触及 `conversation-service.ts`、`chat-scroll.ts`、`RemoteChatPresentation.tsx`）：
- 收口通知提交前对 HEAD 比较：129 个已测指标 124 个不变，4 个下降，1 个 `worse`：`files.fixed-operations/io.read.payload.bytes` 取最大值 +14 B，两侧 5 次区间重叠（基线 1361522–1361550，候选 1361528–1361564）。
- 最终提交对 e937910 比较：135 个已测指标 132 个不变，1 个下降，2 个 `worse`：`trace.r4-cell/other.stringify-bytes` 与 `total.stringify-bytes` 取最大值 +12 B，两侧区间重叠（如 other 基线 121983553–121984489，候选 121983565–121984501）。
- 这些 `worse` 都是工作负载内容逐次变化的噪声，不是新增工作；Ratchet 两次都 passed。计数场景没有覆盖一轮收口的通知或贴底事件，也没有做毫秒测量。新增的真实工作是每轮收口一次 `conversation_changed`：窗口多一次对话读与一次项目列表重载。

## 未验证

- macOS：只能由 PR #73 的 CI 验证，本机没有 macOS。
- 现象 3 本机未复现；滚动移植对它的效果只能由 CI 验证。
- 真实 Provider、真机、daemon 模式下的 side-chat / 统一对话 smoke 均未运行。
- d9d9c6e 中与 side-chat 相关的 smoke 改动（滚轮落点、输入前恢复主体）没有移植；本分支与 main 合并时以 main 为准。
