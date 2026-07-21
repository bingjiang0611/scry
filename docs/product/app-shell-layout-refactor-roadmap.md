# App Shell 与分栏布局重构路线

访问日期：2026-07-04

本文把 X 推文里的三栏布局 / Window Splitter 参考资料，转成 scry 可长期迭代的前端架构路线。结论先行：**现在应该趁一次重构窗口做整页级 App Shell 重构，但它必须是受控的产品级重构，不是无边界视觉翻新**。

## 背景

触发点：

- 现在很多 AI 工具页面是三栏结构：左侧菜单，中间内容，右侧 AI Agent / 详情面板。
- 这类布局需要支持拖拽、隐藏、恢复、键盘操作、合理利用空间。
- 仅用自然语言描述“分栏可拖拽”容易做成临时代码；更可靠的参考是 WAI-ARIA Window Splitter pattern 和 CSS grid track 模型。

scry 正好已经是这个形态：

- 左侧：会话 / 项目 / Skills / MCP。
- 中间：Chat / Graph / Segments / Diagnostics / Analytics 主视图。
- 右侧：OverviewPanel，展示本会话总览、选中事件详情、billing / diff / diagnostics。
- 当前已经有左侧栏和右侧面板的拖拽宽度状态。

## 当前状态

已有能力：

1. `App.tsx` 维护 `sidebarWidth`、`panelWidth`、`resizingPane`。
2. 左侧和右侧 splitter 都使用 `role="separator"`。
3. splitter 已有 `aria-orientation="vertical"`、`aria-valuemin`、`aria-valuemax`、`aria-valuenow`。
4. splitter 已支持鼠标 / pointer 拖拽。
5. splitter 已支持 `ArrowLeft` / `ArrowRight` 键盘调整。
6. CSS 已有 `--sidebar-w`、`--overview-panel-w`、`--pane-resizer-w`。

关键代码：

- `src/renderer/App.tsx`：pane 宽度状态、拖拽处理、键盘处理、左右 separator。
- `src/renderer/styles.css`：`.app`、`.main-area`、`.pane-resizer`、`.sidebar`、`.panel-resizer`。
- `src/renderer/components/OverviewPanel.tsx`：右侧详情面板。
- `src/renderer/components/Sidebar.tsx`：左侧工作区 / 会话导航。

判断：

scry 的分栏不是从零缺失，而是已经做到了 Window Splitter 的半成品状态。真正缺的是把交互语义、状态持久化、折叠恢复和组件边界补齐。

## 本次决策修订

旧判断是“不做整页视觉大翻新”。这个判断现在推翻。

新的判断：

1. **要做一次整页级重构**：既然 scry 是长期使用、长期迭代的软件，现在继续只做局部 splitter polish 会把 `App.tsx` 巨型控制器和 shell 结构债继续留下。
2. **重构对象是 App Shell，不是执行语义**：可以动整体布局、视图 chrome、左右面板组织、splitter、主视图挂载方式、CSS 分层；不改 trace、billing、MCP、session、normalize、SQLite 语义。
3. **允许整体视觉重新整理**：可以趁这次把 Chat / Graph / Segments / Diagnostics / Analytics 的外层框架统一起来，但不要把每个业务视图内部都顺手重做。
4. **不要变成 layout engine 项目**：这次重构可以为未来 docking / preset 留接口，但不直接做 VS Code 式任意拖拽停靠。
5. **一次重构窗口内完成 shell 切换**：AppShell、PaneSplitter、顶层 grid tracks、右栏挂载、composer 空间关系应尽量在同一个重构窗口闭环，避免长期半新半旧。

## 为什么仍然需要重构

长期迭代的核心风险不是 flex 还是 grid，而是 `App.tsx` 正在变成巨型控制器。

现在 `App.tsx` 同时承担：

1. 顶层布局。
2. 会话列表和工作目录状态。
3. trace stream 缓冲与合并。
4. running / busy / stop / new session。
5. MCP / Skills / Diagnostics / Billing 状态。
6. view 切换。
7. chat 渲染。
8. composer 与 slash command。
9. 左右 splitter 和宽度状态。
10. 右栏选中事件详情。

这个结构短期能跑，长期会导致三个问题：

1. **改 UI 容易碰业务状态**：布局改动会穿过 trace、session、MCP、billing 等无关逻辑。
2. **复用困难**：左栏 splitter 和右栏 splitter 已经相似，但逻辑散在 `App.tsx`。
3. **新增视图成本变高**：Graph、Segments、Diagnostics、Analytics 都会继续挤进同一个顶层文件。

因此，重构是必要的。但重构目标应是“降低长期迭代摩擦”，不是“为了 grid 重写页面”。

## 为什么现在要做整页级重构

局部修补 splitter 只能解决“能不能拖”的问题，解决不了“长期能不能迭代”的问题。现在做一次整页级 App Shell 重构是合理的，原因：

1. **App Shell 已经是产品骨架**：左栏、主区、右栏、composer、视图切换共同决定 scry 的使用效率，不是装饰层。
2. **现有结构的债会越滚越大**：如果继续在 `App.tsx` 里叠功能，后续新增审批、MCP trust、billing guardian、multi-agent adapter、layout preset 都会互相牵扯。
3. **三栏工具的体验需要整体设计**：右栏宽度、主区阅读宽度、composer 宽度、Graph 详情区、Diagnostics 面板不是独立问题，应该一次性建立统一规则。
4. **现在已有足够 prior art**：代码里已经有 splitter、右栏、多个主视图、MCP / billing / diagnostics 面板，重构不是拍脑袋重画，而是把已出现的模式收束成正式架构。
5. **重构窗口比长期零碎改更安全**：shell 层是横切面，与其每次功能改一点布局，不如集中做一次可验证的结构迁移。

这次重构可以动：

- 顶层 `.app` / `.main-area` 布局模型。
- `AppShell`、`PaneSplitter`、`useResizablePane`。
- 左栏、主区、右栏的挂载关系。
- Chat / Graph / Segments / Diagnostics / Analytics 的外层 view chrome。
- composer 与右栏共存时的空间规则。
- CSS token、shell tracks、panel chrome、focus / hover / active 状态。

这次重构不动：

- SDK stream 归一化语义。
- `TraceEvent` 字段含义。
- cost / billing / MCP / diagnostics 的数据来源。
- SQLite schema，除非另有明确功能需求。
- main / preload IPC 契约，除非 shell 拆分确实需要只读 UI 状态。
- 业务视图内部算法和统计口径。

## 目标架构

目标边界：

```text
App.tsx
  只做 provider wiring、顶层状态组合、全局 modal 挂载

AppShell.tsx
  管左栏 / splitter / 主区 / splitter / 右栏
  不知道 trace 如何归一化
  不知道 MCP 如何测试

ChatView.tsx
  管 chat turns、composer、slash command、右栏开关入口

useAgentSession.ts
  管 turns、trace buffer、busy/running、start/stop、turn done/error

useWorkspaceState.ts
  管 cwd、projects、recent、sessions、activeSessionId

useIntegrations.ts
  管 skills、MCP、diagnostics、usage、billing、git diff

useResizablePane.ts
  管 width、min/max、collapsed、restoreWidth、localStorage、keyboard 行为

PaneSplitter.tsx
  只渲染 WAI-ARIA separator，并调用 useResizablePane 暴露的 action
```

这次重构应该把 shell 层一次性切到新结构，但状态 hooks 可以分阶段抽。目标是：**外壳一次成型，业务状态逐步瘦身**。

## 路线

### R0：重构前基线

目标：在动 shell 前固定可回归基线，避免重构后不知道哪里坏了。

范围：

1. 记录当前关键行为：
   - Chat 发送 / 停止 / streaming。
   - 历史会话加载。
   - Chat / Graph / Segments / Diagnostics / Analytics 切换。
   - 左右栏拖拽。
   - 右栏显示选中事件详情。
   - slash command 菜单。
   - MCP / Skills modal。
2. 截取重构前主要屏幕：
   - 空工作区。
   - Chat 有会话。
   - Graph 视图。
   - Diagnostics 视图。
   - 右栏选中事件。
3. 列出不能改变的语义：
   - cost 仍标注来源。
   - MCP live status 仍区分配置态和真实连接态。
   - 文件足迹仍保留盲区说明。

验收：

- 有一份 smoke checklist。
- 有重构前截图或至少人工确认记录。
- 明确哪些问题属于本次重构范围，哪些不是。

### R1：一次性建立新 AppShell

范围：

1. 新增 `AppShell.tsx`。
   - 使用明确的 shell slots：`sidebar`、`main`、`rightPanel`、`composer`、`modals`。
   - 统一控制 shell class、pane id、collapsed class、view chrome。
   - 支持 `rightPanelVisible` 和未来 `leftPanelCollapsed`。

2. 顶层布局改为明确 tracks。
   - 推荐用 CSS grid 表达：`sidebar | splitter | main | splitter | panel`。
   - main 内部仍可按 view 使用 flex / grid。
   - composer 不再用脆弱的宽度补偿式 `calc` 贴右栏，而是归属 main track。

3. 新增 `useResizablePane`。
   - 输入：`id`、`defaultWidth`、`min`、`max`、`step`、`side`。
   - 输出：`width`、`collapsed`、`startResize`、`nudge`、`collapse`、`restore`、`setToMin`、`setToMax`。
   - 支持 `localStorage` 持久化。
   - 支持折叠前宽度 `restoreWidth`。

4. 新增 `PaneSplitter`。
   - 渲染 `role="separator"`。
   - 设置 `aria-orientation="vertical"`。
   - 设置 `aria-controls`。
   - 设置 `aria-valuemin`、`aria-valuemax`、`aria-valuenow`。
   - 可选设置 `aria-valuetext`，例如 `340 px` 或 `collapsed`。
   - 支持 `ArrowLeft` / `ArrowRight`。
   - 支持 `Home` / `End` 到 min/max。
   - 支持 `Enter` 折叠 / 恢复。

5. 左侧栏和右侧栏复用同一套 splitter。

验收：

- 鼠标拖拽行为和现在一致。
- 左右箭头行为和现在一致。
- `Home` / `End` 可用。
- `Enter` 可折叠 / 恢复。
- 刷新 app 后宽度保留。
- ARIA 属性完整，separator 能明确指向控制的 pane。
- Chat / Graph / Segments / Diagnostics / Analytics 都挂在新 shell 中。
- 不改 trace、MCP、billing、session 数据语义。

### R2：统一视图外层与信息密度

目标：趁 shell 重构，把各主视图的外层结构统一，提升长期可维护性和使用手感。

范围：

1. 统一 view header。
   - 每个 view 有一致的标题区、状态区、辅助 action 区。
   - 不在每个 view 内复制零散 toolbar 结构。

2. 统一 panel chrome。
   - 右栏、Graph detail、Diagnostics 卡片遵循同一套边框、背景、标题密度。
   - 保留工具软件的高信息密度，不做营销式 hero / 大卡片。

3. 重新整理 composer 空间。
   - composer 属于主内容轨道。
   - 右栏开关不应造成 composer 文本区跳动或遮挡。
   - streaming 时底部空间稳定。

4. 收敛 CSS 层级。
   - shell / pane / view / component 四层命名。
   - 移除只服务旧 shell 的补偿样式。
   - 避免继续把所有布局规则堆在全局选择器附近。

验收：

- Chat 视图行为不变。
- Graph / Segments / Diagnostics / Analytics 切换不变。
- 右栏开关不变。
- composer 宽度不被右栏遮挡。
- 主视图外层结构一致。
- 没有明显文字重叠、按钮挤压、面板跳动。

### R3：抽出 ChatView

目标：把未来迭代最多的主战场从 `App.tsx` 移出。

范围：

1. 新增 `ChatView.tsx`。
2. 接管：
   - chat turn list。
   - `AssistantTurn` / `UserMessage` 渲染。
   - filter bar 状态入口。
   - composer。
   - slash command menu。
   - send / stop 入口。
3. `App.tsx` 只传入必要状态和 action。

验收：

- 发送任务、停止任务、新建会话、历史会话加载行为不变。
- slash command 行为不变。
- streaming 渲染不抖动。
- filter 行为不变。

### R4：拆状态 hooks

目标：把长期变化频繁的状态域从顶层组件拆开。

范围：

1. `useAgentSession`
   - `turns`
   - `running`
   - `busy`
   - `selected`
   - trace buffer / rAF flush
   - `start` / `stop` / `newConversation`
   - turn done/error 监听

2. `useWorkspaceState`
   - `cwd`
   - `projects`
   - `recent`
   - `activeSessionId`
   - `pickSession`
   - `pickRecent`
   - `chooseFolder`
   - `deleteSession`

3. `useIntegrations`
   - skills
   - MCP metadata and live status
   - usage
   - stats
   - billing state
   - diagnostics
   - git diff

验收：

- `App.tsx` 成为组合层，而不是巨型控制器。
- hooks 之间依赖方向清楚。
- 不引入全局状态库，除非后续状态共享明显失控。

## 何时需要真正的 layout engine

这次做整页级 App Shell 重构，但仍不做完整 layout engine。只有满足下面任意两个条件时再评估：

1. 支持多个右侧面板同时存在。
2. 支持底部 panel。
3. 支持用户拖拽调整 panel 停靠位置。
4. 支持 workspace layout presets。
5. 不同 view 需要独立保存布局。
6. 需要类似 VS Code 的 activity bar / side bar / panel / auxiliary bar 模型。

如果只是“左栏可拖、右栏可拖、右栏可隐藏、主视图外层统一”，`PaneSplitter + AppShell + grid tracks` 足够。

## CSS grid 的使用判断

CSS grid 应成为这次 shell 重构的主要布局工具之一，但不应被当成目标本身。

适合使用 grid 的位置：

1. 顶层 shell tracks：`sidebar | splitter | main | splitter | panel`。
2. Graph 视图内：主图和右侧详情。
3. Segment 卡片内：左摘要 / 中说明 / 右指标。

不必强行改成 grid 的位置：

1. 简单纵向堆叠。
2. 已经稳定工作的 flex toolbar。
3. Chat stream 主列表。

判断标准：

- 如果布局本质是二维 tracks，用 grid。
- 如果布局本质是一维排列，用 flex。
- 如果只是为了“看起来现代”，不改。

## 设计原则

1. **工具优先，不做营销页式布局**
   scry 是高频桌面工具，布局应安静、稳定、可扫描。

2. **用户空间记忆优先**
   用户拖过的宽度应保留。折叠后恢复到上一次宽度，而不是固定默认值。

3. **键盘行为必须是一等能力**
   splitter 不是鼠标专属控件。Arrow、Home、End、Enter 都应可用。

4. **ARIA 不是装饰**
   如果写了 `role="separator"`，就要补齐控制目标和数值语义。

5. **不要让布局重构碰执行语义**
   trace、billing、MCP、session 是 scry 的可信数据层。布局重构不应改变这些语义。

6. **一步一个可验证切片**
   每次重构都应能通过视觉检查、键盘检查、核心任务 smoke test。

## 测试与验证

每个阶段至少验证：

1. `npm run typecheck`
2. `npm test`
3. 开发窗口 smoke test：
   - 切换 Chat / Graph / Segments / Diagnostics / Analytics。
   - 拖拽左侧栏。
   - 拖拽右侧栏。
   - 键盘调整 splitter。
   - 折叠 / 恢复右栏。
   - 发送一条短任务并确认 streaming 正常。
   - 停止运行中的任务。
   - 切换历史会话。

可选补充：

- 给 `useResizablePane` 写纯逻辑单测。
- 用 Playwright / browser-use 对 splitter 键盘行为做轻量检查。

## 不做清单

当前不做：

1. 不引入大型 docking/layout 库。
2. 不做 VS Code 式任意面板拖拽。
3. 不把业务视图内部算法和统计口径顺手重写。
4. 不改变 trace / billing / MCP / session 数据语义。
5. 不为了抽象而引入全局状态库。
6. 不把 splitter 动效做得很花。高频工具里，拖拽反馈要快、稳、低噪音。
7. 不做营销页式视觉翻新：允许整体 shell 重新设计，但不做大 hero、大插画、低密度展示卡片。

## 参考资料

外部资料：

1. X 推文：向阳乔木，`@vista8`，2026-07-03。
   https://x.com/vista8/status/2072847622977790397

2. WAI-ARIA Authoring Practices Guide：Window Splitter Pattern。
   https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/

3. MDN：`grid-template-columns`。
   https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/grid-template-columns

4. 演示站点：rss.qiaomu.ai。
   https://rss.qiaomu.ai/

内部资料：

1. `src/renderer/App.tsx`
   - 当前 splitter 状态、拖拽、键盘处理、左右 separator。

2. `src/renderer/styles.css`
   - 当前 app shell、pane resizer、sidebar、panel 相关样式。

3. `src/renderer/components/Sidebar.tsx`
   - 左侧导航和会话入口。

4. `src/renderer/components/OverviewPanel.tsx`
   - 右侧详情面板。

5. `src/renderer/components/ExecutionGraph.tsx`
   - Graph 视图内也有主区 / 详情区布局需求，后续可复用 splitter 经验。
