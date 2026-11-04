# D1 交互验收记录（未通过最终验收）

D1 只做一件事：让真实 App 里的侧边会话按真实指针、键盘、IME 输入和真实窗口尺寸跑完，把跑不通的地方修到能跑。没有提交、没有升版本、没有安装。

## 一、D1 前半段（已被父级否决的旧结论，保留记录）

D1 第一个执行者用 `Emulation.setDeviceMetricsOverride` 改视口，并让 Qoder/OpenCode 按「前端尚不支持」被拒绝；父级否决了这种做法：

- 本构建里 `Emulation.setDeviceMetricsOverride` 不改变真实 CSS `vw/vh`，所以「窄窗口单列」只证明了组件级数字，没有真实窗口证据。
- 五目标发送是已批准合同。旧 `conversationTarget()` 拒绝 Qoder/OpenCode 是实现缺陷，不是产品边界；「三成功、两拒绝」不能作为验收标准。

保留的修复（仍然有效）：

- **历史窗口有界且可回退**：`side-chat-history-window.ts`（游标栈 + 单页窗口 + `historyRowRange`）与 `hooks/useSideChatHistory.ts`（请求令牌、scope/source 变化重置、`fenceHolds` 围栏）。历史不再「截断 160 行后禁用加载更多」。
- **越界续延加栅栏**：创建、未知命令核对、页签校验都在首个 await 前固定 `scopeKey/sourceKey`，回包后只写回原 scope（`dispatchForScope`），不改当前主区提示、焦点和记录；`records` 只保留已打开 ID。
- **子会话 UI 缺陷**：标题只出现一次；来源行压成一行；子输入框贴住列底；空状态改为 `new-side-chat`；Provider 芯片在容器查询下 `max-width: min(168px, 42cqi)`。
- **预算拒绝可分类**：`conversation-history-text.ts` 抛 `HistoryReadBudgetExceeded`，只有这一类映射成 `SideChatBudgetRefusal`；未知错误保持 unavailable。

## 二、本轮（REVIVE 续作）修掉的两处真实缺陷

### 1. 发送目标被错限成三 Provider

`src/renderer/conversation-handoff.ts` 把**发送目标**和**旧捕获迁移来源**混成一条合同。现在拆开：

- `conversationTarget()` 是发送目标，五种 Provider 都返回真实目标（`pi` 保留 `agentProfileId`）；未注册的 agent 才拒绝。
- `legacyAdoptionSourceTarget()` 是旧捕获的迁移来源，仍只允许 Claude/Codex/Pi，并给出来源侧理由（旧入口只有这三家可接管的归档）。`src/renderer/app-view.tsx` 的迁移来源改用后者，去掉了 `as 'claude'|'codex'|'pi'` 的类型伪装。
- 主线本来就接受五种目标：`src/main/conversation-request.ts` 的 `parseTarget` 与 `conversation-service.send` 的 `supportsHistoricalInput` 都按 adapter 能力判断，Qoder/OpenCode 适配器都声明了 `historicalContext: true`。

### 2. 窄窗口两套布局互相打架

- `styles-agent-roster.css` 里旧的 `@media (max-width: 1180px)` 把右侧面板变成固定浮层并隐藏分隔条，与新的实测 `.narrow-single-column` 单列布局在同一窗口上同时生效。
- 旧浮层规则加 `:not(.narrow-single-column)`，只在实测策略不认领的窗口上保留原行为。
- `side-chat.css` 的单列规则原来输给 `codex-alignment-dialogs.css` 的四类选择器（`minmax(0,1fr)` 五列网格 + `position: static` + 分隔条 `display: block` 都生效），现在用同形状选择器（`.app.right-panel-surface.narrow-single-column:not(...)`）声明单列网格、隐藏分隔条、面板占满列，没有 `!important`，也不依赖打包顺序。
- 实测结果：1100 px 窗口下面板 862 px = 1100 − 230（侧栏）− 8（分隔条），主区 `display: none`，面板自己的「隐藏右侧工作区」按钮能真实点击回到会话。

## 三、真实窗口尺寸验收（不再是 emulation）

`scripts/smoke-app-entries.mjs` 的隔离入口在 `--dev-side-chat-only` 下额外接受一份临时 JSON 请求，用真实 `BrowserWindow.setContentSize()` 改本测试实例的窗口尺寸并回执 `getContentSize()/isVisible()`。生产 main 模块不变，renderer 不获得新权限，用户窗口不参与。

| 尺寸 | 断言 | 实测 |
|---|---|---|
| 1400×900 | 双栏、分隔条在、主区与面板同时可见 | `narrow=false`，面板 520 px，`mainDisplay=grid` |
| 1100×900 | 实测单列、面板占满列、主区不占位 | `pane=panel`，面板 862 px，列宽 864，`pageOverflow=0` |
| 1100×900 → 隐藏面板 | 面板自己的隐藏键真实可点，回到会话 | `pane=main`，`slotDisplay=none` |
| 860×720（最小窗口） | 仍单列、侧栏不塌、无横向滚动 | 面板 622 px = 860 − 230 − 8，芯片 126 px |
| 1200×600（低窗） | 输入框在视口内且贴底、正文可读、六个工具面板都在 | `bottomGap=0`，正文 218 px，「添加 Surface」菜单 8 项（侧边会话 / 历史 / 纵览 / 文件 / Diff / 源代码管理 / 终端 / Agents）且未被裁切 |
| 浅色 / 深色 | 真实 `scry.theme` 重启路径渲染，对比度 ≥ 4.5 | 15.94 / 15.07 |

同一模块还重放了：页签键盘导航保持唯一选中；IME 组合期间回车不派发、提交不丢字（Chromium 组合事件，不是 macOS 系统候选窗验收）；Provider 文本 `<img src=x onerror=alert(1)>` 原样显示且 DOM 中 `img`/`script` 为 0。

## 四、五目标发送 / 续接（本轮验收里程碑）

`scripts/side-chat-execution-checks.mjs` 原本把 Qoder/OpenCode 的拒绝写成通过条件。现在改成对五种目标各发两次：

- 第一次：该 Provider 的新原生会话，冻结来源正文只投递一次（fixture `historicalContext` 非空、`outgoingPrompt` 只出现一次来源标题），`resume=null`；
- 第二次：`resume` 等于该 Provider 刚创建的原生 session，`historicalContext=null`（不重发冻结上下文）。

实测（2026-10-28，`--dev-side-chat-only`）：10 次真实发送，5 个互不相同的原生 session（codex/claude/qoder/opencode/pi），全部 `delivery=accepted` 且有原生 turn id；父会话正文与父 fixture 运行次数在整段过程中不变；子会话标题跟随首个问题。

## 五、负控（证明断言不是空转）

| 被破坏的实现 | 结果 |
|---|---|
| 把 `conversationTarget()` 改回三 Provider 拒绝 | 五目标验收失败：`side chat write qoder1` 被拒（`此 Agent 尚不支持跨 Agent 接续`），草稿保留、`fixtureRuns=0`、无新轮次。改回后重跑通过。 |
| 旧的 `@media (max-width: 1180px)` 浮层规则不加 `:not(.narrow-single-column)` | 1100 px 下面板不再是 862 px 的整列，改为固定宽浮层；「面板占满列」断言失败。 |
| 旧的组件级 `Emulation` 断言 | 已删除；换成真实 `setContentSize` + `innerWidth/innerHeight` 相等断言，emulation 下的补丁断言不再能通过。 |

## 六、顺手修掉的既有失败

- `src/renderer/side-chat-history-window.test.ts` 无法通过类型检查（`nextHistoryLoad`/`previousHistoryLoad` 返回未收窄的联合）。改为返回收窄类型，行为不变。
- `scripts/side-chat-execution-checks.mjs:verifySideChatRestart` 使用了未解构的 `click`，只在「重启后没有自动选中子会话」时暴露。已补上解构。
- 统一对话模式 `scripts/conversation-agent-switch-smoke.mjs` 仍断言「被拒绝的发送后输入框保留原文」。这条早于本轮已落地的持久回执合同（`composer-pending.ts` 把已提交文字与图片移入回执，输入框不留第二份可编辑副本）。已改为断言更强的合同：输入框为空、回执里保留原文与图片、界面显示「待核对、不自动重发」、未确认状态下不提供「重新发送」、fixture 未收到输入、轮次数不变。⚠️ 该断言是旧合同的遗留，改动依据是新的回执设计，需要复核者确认这是想要的用户体验。

## 七、仍未验证（本轮到此为止，未宣称完成）

- **归档 / 删除指纹预览**与**父会话删除后子会话可发现性 + 冻结正文可读**：只跑到「删除预览 / 父删除」这一段的部分路径，没有在真实 App 里完整重放。
- **来源在持有预览 / 创建 / 历史查询期间切换**：栅栏单元测试在（`side-chat-scope.test.ts`），但挂载状态的竞态没有真实 App 证据。
- **长历史滚动锚点**：当前最多补读三页、找不到就落到最旧已加载轮次；这仍不是精确恢复，且没有「超出默认窗口的真实长正文」证据。
- **快照查看器的 Unicode 分页、ModalFrame 焦点/Escape 归还**：未重放。
- **未发送文字/图片 + pending 提交的 App 重启读回**：入口检查只证明了重启后页签、同一子会话、空草稿、无重放；「草稿与回执跨重启读回」没有真实重启证据。
- **双实例并行**没有在本轮重放（`side-chat-runtime-checks.mjs` 覆盖的是父/子并行、独立停止与审批归属）。

## D2 addendum — ownership, orphan view, long-transcript anchor, snapshot limits

Real isolated App runs (`--dev-side-chat-only`) after the D2 work. Every step below asserts
inside the harness; the run log is the evidence, not a summary written after the fact.

- **Retained-surface ownership** (`runtime`): hiding the workbench leaves zero child bodies and
  zero child composers in the DOM, the hidden child's stream subscription is released again
  (subscribe ≤ unsubscribe), the run itself stays active and only the sidebar badge shows its
  attention; reopening shows the *same* run id and re-subscribes.
- **Close tab is a view action** (`runtime`): closing the tab dispatches no `conversation:delete`
  and no `agent:stop`, and reopening the same child id returns to the same run.
- **Main-view ownership** (`orphan`): a side chat opened as the main view renders the same
  child-owned surface (`data-side-chat-variant="main"`) — its own provider chip, composer,
  captured parent title and 查看来源快照 action — instead of the host's global chat props, and
  offers no workspace picker. `SideChatSurface` carries a `variant`.
- **Delete survives** (`orphan`): the source is archived and deleted through the shipped
  fingerprint-preview dialog (`ConversationDeleteDialog`, confirm `确认删除 Scry 副本`, result
  `逻辑入口已删除`); the child record, its own turn and its frozen body stay readable, and the
  child is listed under `[data-side-chat-orphans]` by its own id, grouped by its source key with
  a bounded batch (`data-orphan-rows-more`, 20 rows per reveal) rather than a flat list.
- **Snapshot viewer** (`orphan reader`, real App): the same child is paged as a reader —
  13 parent turns / 26 messages fit one page under the production budget and page limits, so
  both paging buttons are disabled, `data-snapshot-state` reads `complete`, exactly one
  `conversation:readSideChatSnapshot` is dispatched and no `conversation:read`; Unicode and
  emoji survive, Escape returns focus and the child draft is untouched.
- **Multi-page paging is component-fixture only**: `scripts/fixtures/side-chat-snapshot-pages.ts`
  builds a real sealed artifact through `sideChatFixture`/`sendTurn`/`readSideChatSnapshot`,
  and `scripts/side-chat-snapshot-ui-smoke.mjs` renders it in the isolated fixture to prove two
  pages (40 + 2 rows), `partial → complete`, real pointer and key paging, the ≤40-row bound and
  Escape focus restore. This is labeled component evidence: the real App cannot reach a second
  page under the current budget, so no App run claims multi-page paging.
- **Long-transcript anchor** (`scroll`): a 130-turn child is paged back to its oldest page,
  then a real tab switch away and back restores the same turn by run id, and closing the last
  tab and reopening the child restores it too (`afterReopen` offset and `turns` are asserted,
  not just "a scroll happened"). The fixture measures turns, not rows, so a 40-turn page is a
  real page and not an alias for the row count. The restore now stores the anchor ordinal, so
  it asks for the exact window in one bounded read instead of walking a fixed page budget, and
  a restore never re-applies against the window a read is still replacing.
- **Polish**: the header no longer repeats the workspace (it is the composer's readonly label),
  so the captured parent title keeps the row instead of truncating to `s…`.

Budget finding: with the current handoff budget a frozen prefix is capped (messages and
per-message bytes), so in the App a snapshot body cannot exceed one page for a target without a
history retrieval tool; the App evidence therefore proves readability, Unicode integrity and
`data-snapshot-state`, while paging is proven by the component fixture above.

### D2 closure（本轮，Node 22.22.1）

上一版记录的阻碍（restore 打开历史时找不到父 scope、`layout`/`restart`/草稿跨重启无证据）已解决，原因是
“打开历史前先关闭全部页签”破坏了准备状态，以及原生来源子会话的归属键缺一半。现在：

- `--dev-side-chat-only` 一次跑完 `execution`、`runtime`、`history`、`scroll`、`orphan`、`orphan reader`、
  `orphan paging`、`restore`、`layout`、`drafts`、`restart`、`drafts restored`、`adoption`，全部本步断言通过，
  退出码 0（`npm run test:side-chat:ui` 里的 build、快照组件夹具、竞态组件夹具同样通过）。
- 多页签：重启前后保存行与页签条同为 1 个工具页签（纵览）+ 3 个子会话页签（草稿/回执/普通），顺序与激活页签
  一致；重启后的读取发生在任何修复/重开动作之前。历史动作本身不关闭任何页签（实测 1 → 2）。
- 来源竞态：生产 `useSideChatWorkspace` 在隔离窗口里以“按需放行”的 API 重放 preview/create 结果/页签校验/
  历史页/窄化/丢失回执在切换父会话后作答；破坏 `fenceHolds` 时第一项立即失败。此为组件夹具证据。
- 原生来源 → 统一对话：用户显式切换父会话 Provider 后，子会话 id/runId/页签存活，窗口只有 1 个 body，
  新对话 scope 的 `listSideChats({ids})` 与历史对话框都能列出切换前的子会话；后端规范来源匹配按精确
  provider/profile/cwd/session 双向扩展，附双向别名回归与负控（去掉扩展即失败）。
- 子会话文件证据隔离：子会话自己写入的 `side-chat-pi2.txt` 只在子会话正文出现，父正文不含，子输入框无
  工作区选择器。不把这外推为文件系统沙箱。
- 剩余限制：快照多页仍只有组件夹具证据（App 内单页可读、Unicode、`data-snapshot-state`、Escape 焦点归还）；
  真实付费 Provider 账号未探测；完整发布 gate、打包、性能测量未运行；未提交/推送/升版本/安装。

## D3（最新，取代上面的 D2 结论）

D3 的两处 UI 正确性收尾（未决发送原文只能保存不能查看、孤儿侧聊标题被元数据挤成一个字）已实现并在隔离真实
App 内验证，不再以本节 D2 的“剩余限制”描述当前状态。实测表格、截图路径与跑过的检查见
[d3-ui-polish.md](d3-ui-polish.md)。之后的两处有界性修正（列表来源匹配不再按 owner 全量扩展、孤儿行页码表只
保留当前分页的组）也记录在同一文件，属于集成前的源码修正，未重跑 App UI 或全量 `npm test`。
