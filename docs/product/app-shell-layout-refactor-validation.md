# App Shell Layout Refactor Validation

更新日期：2026-07-04

## 范围

本次重构按 `docs/product/app-shell-layout-refactor-roadmap.md` 推进 R0-R4，目标是拆清 renderer 的 App Shell、分栏、Chat view、workspace 状态、agent session 状态和 integrations 状态。重构只改变前端结构与必要布局语义，不改变 trace、billing、MCP、session、SQLite 或 main/preload IPC 契约。

## R0 基线清单

重构前必须保持的核心行为：

- Chat：会话消息列表、实时 streaming、发送任务、停止任务、slash command 菜单。
- Graph：拓扑节点、右侧详情面板、详情分栏拖拽。
- Segments / Diagnostics / Analytics：视图切换和现有数据展示。
- 左侧栏：项目/会话列表、历史会话加载、新建会话、删除会话。
- 右侧栏：Overview、账单卫士、MCP 信任、选中事件详情、sessionId、git diff、diagnostics。
- 数据语义：trace 归一化、cost/billing 来源、MCP live/config 状态、文件足迹盲区说明不变。
- 后端契约：`src/main`、`src/preload`、`src/shared` 只读验证，不改 IPC channel、payload、SQLite schema。

## 结构变更

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| R1 AppShell / splitter | 新增 `AppShell`，顶层布局改为 grid tracks：sidebar / splitter / main / splitter / right panel。 | `src/renderer/components/AppShell.tsx`、`src/renderer/styles.css` |
| R1 PaneSplitter | 新增统一 `PaneSplitter` 和 `useResizablePane`，支持鼠标拖拽、Arrow、Home、End、Enter、localStorage 持久化、ARIA `aria-controls`。 | `src/renderer/components/PaneSplitter.tsx`、`src/renderer/hooks/useResizablePane.ts` |
| R2 view chrome | 顶栏、view tabs、过滤条、agent/cwd/panel pill 抽为 `ViewChrome`。 | `src/renderer/components/ViewChrome.tsx` |
| R2 composer 空间 | 右侧 OverviewPanel 移到 shell 右栏 track，composer 属于 main track，不再依赖 `calc(100% - panel width)` 补偿。 | `src/renderer/App.tsx`、`src/renderer/styles.css` |
| R3 ChatView | Chat 列表、composer、slash menu、CLI picker、send/stop 入口抽为 `ChatView`。 | `src/renderer/components/ChatView.tsx` |
| R4 hooks | 抽出 `useAgentSession`、`useWorkspaceState`、`useIntegrations`。 | `src/renderer/hooks/*.ts` |

## Review 修复

| 来源 | 问题 | 处理结果 |
| --- | --- | --- |
| 代码结构 review | `McpTrustPanel` 异步导入报告期间切 cwd，可能写入错误 cwd。 | `setCurrentMcpGuardReport` 使用当前 render 的 `cwd` 闭包，避免落到完成时的 `cwdRef.current`。 |
| UI / 功能 review | Chat view 同时渲染外层空 `.body` 和 `ChatView` 内部 `.body`。 | `App.tsx` 仅在 `!cwd` 或非 Chat 视图渲染外层 `.body`，Chat 独占 `ChatView` body/composer。 |
| UI review | 右栏 splitter 折叠后，顶栏“面板”按钮仍显示开启，且点击不能恢复宽度。 | 新增 `panelVisible` 和 `toggleOverviewPanel`，按钮只代表真实可见；折叠后再点会 restore。 |
| UI review | Graph / Segments 顶栏存在无效“面板”按钮。 | `ViewChrome` 增加 `canTogglePanel`，仅 Chat 视图展示右栏按钮。 |
| UI review | Graph turn 箭头仍会收起节点树。 | `TurnBlock` 移除 open state，箭头改为 `aria-hidden` 的纯视觉提示。 |
| 可访问性 review | collapsed splitter 的 `aria-valuenow` 可能落到 min/max 之外。 | `PaneSplitter` collapsed 时用 `min` 作为 `aria-valuenow`，并保留 `aria-valuetext="collapsed"`。 |
| 稳定性 review | 快速切 cwd 时 `listMcp(cwd)` 旧请求可能覆盖新目录状态。 | `useIntegrations` 为 MCP metadata 加 request sequence guard，与 `gitDiff` 同口径。 |

## 命令验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck:web` | 通过 |
| `npm test -- src/renderer/hooks/useResizablePane.test.ts src/renderer/components/render.test.tsx` | 通过，50 tests |
| `npm run typecheck` | 通过 |
| `npm test` | 通过，217 passed，3 skipped |
| `npm run build` | 通过 |
| `git diff --check` | 通过 |

## 运行验收

computer-use 在本轮恢复后不可用：MCP 调用返回 `unsupported call`，macOS `System Events` / `cliclick` 也受辅助功能权限限制，无法稳定驱动窗口焦点。为避免继续被 Space / 前台窗口状态干扰，改用 Electron 官方 DevTools Protocol 验收：

```bash
npm run dev -- --remoteDebuggingPort 9444
curl -s http://127.0.0.1:9444/json/list
```

CDP 目标确认：`title=scry`，`url=http://localhost:5173/`，`document.readyState=complete`。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 冷启动 welcome | 通过；sidebar、welcome、OverviewPanel 三 tab 渲染，无 ErrorBoundary。 | `/tmp/scry-cdp-resumed.png` |
| 历史会话加载 | 通过；点击最近 `sample-workspace` 后进入 `/workflow-orchestrator 12345678` 历史会话。 | `/tmp/scry-cdp-sample-workspace.png` |
| Chat | 通过；消息流、composer、sessionId、context、hooks、工具统计和右侧面板正常。 | `/tmp/scry-cdp-sample-workspace.png` |
| Graph / 拓扑 | 通过；`TURN 01/02`、工具树、右侧详情提示正常；不再显示 Chat composer 或右侧会话面板。 | `/tmp/scry-cdp-graph.png` |
| Segments / 分段 | 通过；段落摘要、legend、segment cards 对齐；不显示 Chat composer 或右侧会话面板。 | `/tmp/scry-cdp-segments.png` |
| OverviewPanel tabs | 通过；`纵览` / `账单卫士` / `MCP 信任` 可切换，内容中文化，无 ErrorBoundary。 | `/tmp/scry-cdp-panel-tabs.png` |
| Analytics / Diagnostics | 通过；sidebar 导航可切换，聚合统计和诊断页渲染正常。 | `/tmp/scry-cdp-diagnostics.png` |
| splitter ARIA | 通过；sidebar / right panel 两个 `role=separator` 均有 `aria-controls`、`aria-valuemin/max/now/text`。 | CDP DOM probe |
| splitter 键盘 | 通过；右栏 separator 聚焦后 `Enter` 折叠为 `0px` 且 `aria-valuetext=collapsed`，再次 `Enter` 恢复；`ArrowLeft` 将 right pane 从 340px 调整到 356px。 | CDP `Input.dispatchKeyEvent` |
| useAgentSession 状态机 | 通过；activeRun 恢复、trace batch 后 turnDone、error hint、clearTurns 丢弃旧 run 残余事件、stopRun 标 done、历史会话替换均有纯测试覆盖。 | `src/renderer/hooks/useAgentSession.test.ts` |

本轮后续 backend 验收补跑了真实应用内 start/stop：

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 真实 start | 通过到 SDK runner；prompt `只回复 OK，不读文件、不调用工具` 触发 `SessionStart` / `UserPromptSubmit` hook trace，并拿到 sessionId `507c53f8-069e-4d11-812e-018db216b433`。 | `/tmp/scry-stop-path.png` |
| stop | 通过；`stop()` 返回 `true`，约 602ms 收到 `agent:turnDone` 且 `stopped=true`。 | CDP event probe |
| 会话/用量刷新 | 通过；`usageStats().turns` 增加，`stats().totals.turns` 增加，`listSessions(cwd)` 和 `listProjects()` 出现 `scry` 新会话。 | CDP IPC probe |

限制：真实模型回复未完成；第一次 start 曾收到 `Claude Code process terminated by signal SIGKILL`，第二次进入 hook/init 后因外部 API retry/stop 以 `error_during_execution` 收束，cost 为 0。本轮只把 start/trace/stop/session/usage/stats/history 链路作为已验证，不声称 Claude 已成功输出 `OK`。

## 截图对比

当前截图证据：

- `/tmp/scry-ui-after-unlock.png`：解锁后旧 dev/HMR 状态曾出现 React ErrorBoundary（`Should have a queue`），干净重启后未复现。
- `/tmp/scry-ui-electron-after-wait.png`：干净重启后系统截图显示 app 正常渲染。
- `/tmp/scry-cdp-resumed.png`：CDP 冷启动 welcome 截图。
- `/tmp/scry-cdp-sample-workspace.png`：CDP 历史会话 Chat 截图。
- `/tmp/scry-cdp-graph.png`：CDP Graph 截图。
- `/tmp/scry-cdp-segments.png`：CDP Segments 截图。
- `/tmp/scry-cdp-panel-tabs.png`：CDP 右侧面板 tab 截图。
- `/tmp/scry-cdp-diagnostics.png`：CDP Diagnostics 截图。

若后续需要严格“拖拽鼠标”级验收，可在 macOS 辅助功能授权恢复后再跑 computer-use；本轮已用 CDP 完成 DOM、截图和键盘 splitter 的 runtime smoke。

## 剩余风险

- `useIntegrations` 覆盖的状态面较宽，但保持了原 IPC 调用和数据刷新时机；后续若继续细拆，可再按 billing / MCP / diagnostics 分层。
- 本轮后续追加了 `src/main` 结构拆分；后端验证见 `docs/product/backend-structure-refactor-validation.md`。
- `useAgentSession` 是从旧 `App.tsx` 平移出的核心 streaming/session 编排，本轮通过现有 renderer/main 测试和 typecheck 间接覆盖；后续可以补专门 mock `window.scry` 的 hook 级竞态测试。
