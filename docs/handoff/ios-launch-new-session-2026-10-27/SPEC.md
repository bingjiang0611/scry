# L1 规范：启动即新建会话 + 左侧抽屉

设计稿源码：[mockups/](mockups/)（`Main` 启动态、`Sidebar` 抽屉展开、`Typing` 新建会话聚焦、`MainDark` 启动态深色）。颜色全部用 `Theme.swift` 现有的 `Palette`，字体用 `Typography`，动效用 `Motion`，不新增 token。

## 1. 现状（改之前先读）

| 文件 | 现在做什么 |
|---|---|
| `ScryRemoteApp.swift` `RootView` | 按 `model.route` 切页面。`.home` → `HomeView`，`.newSession` → `NewSessionView`。根上挂了左边缘右滑 = `model.goBack()`。 |
| `HomeView.swift` | 首页 = Mac 侧栏：主机菜单、搜索、`HomeSessions`（项目 / 动态 tab）、底部 `HomeComposer`。还挂着刷新 toast、重命名 / 归档 / 删除弹窗、刷新详情 sheet，以及 `targets.setHomeVisible` 和首次 `refreshHome()`。 |
| `HomeComposer.swift` | 首页底部的 `MessageComposer`，用 `targets.newTaskStore`，发送成功后 `route = .chat`。 |
| `NewSessionView.swift` | 单独的「新任务」页：顶部 `RemoteHeader`，三行上下文（执行主机 / 工作目录 / Provider），底部 `MessageComposer`。`.task(id: paired ? targets.newTaskScope.id : nil)` 负责加载项目和 Provider，`Checks/new-task-readiness.py` 会去找这一行。 |
| `AppModel.swift` | `route` 默认 `.home`；配对成功后 `beginNewTask()` 再 `route = .newSession`；`goBack()` 回 `.home`；`canGoBack` 在 `.home` 时为 false。 |
| `ChatView` / `SessionTranscriptView` | 头部「新任务」菜单项：`beginNewTask(scope:)` 后 `route = .newSession`。返回键 `goBack()`。 |

## 2. 路由（不改 `AppModel`）

- 新增 `WorkspaceShell`（新文件 `WorkspaceShell.swift`）。`RootView` 里 `.home` 和 `.newSession` **都**渲染它：`case .home, .newSession: WorkspaceShell(focusComposer: model.route == .newSession)`。
- 这样：冷启动（route 默认 `.home`）= 新建会话页，抽屉收起，会话框不自动聚焦（不弹键盘）。`.newSession`（配对成功、会话页里点「新任务」、抽屉里点「新建会话」）= 同一个页面，会话框自动聚焦。
- 从会话页 / 设置 / 工具面板 `goBack()` 回到 `.home`，也就是新建会话页，抽屉收起。这是有意的：抽屉一律默认收起。
- `RootView` 的 `run` 计算属性：`.home` 现在也要用 `targets.newTaskStore`（会话框用它）。写成 `model.route == .newSession || model.route == .home ? targets.newTaskStore : targets.selectedStore`。抽屉里的会话列表仍按 `HomeView` 现在的方式拿 `targets.localStore`（`.environment(targets.localStore)` 只包在抽屉内容上）。改这一行前先确认等待决定横幅（`waitingElsewhere`、`pendingQuestions`）在 `.home` 上的行为和改前一致，不一致就停下来写进报告。
- `resumeRecoveredRun()` 不动：有可恢复的运行时照常跳 `.chat`。
- `RootView` 根上的左边缘右滑：在 `.home` / `.newSession` 上**不再**调用 `goBack()`，改由 `WorkspaceShell` 自己处理（打开抽屉，见第 4 节）。其他页面保持原样。

## 3. 新建会话页（抽屉收起）

对照 `mockups/Main.dc.html`、`MainDark.dc.html`。底色 `Palette.main`。

**顶栏**，高 48，左右 padding 6：
- 左：侧栏按钮，44×44，SF Symbol `sidebar.left`，`Palette.fg`，无障碍标签「展开侧栏」。点了打开抽屉。
- 中：执行主机胶囊。样式照搬 `HomeView.hostChip`（7pt 状态圆点 + `Typography.headerTitle` + `chevron.up.chevron.down`，`Palette.panel2` 胶囊，高 36）。文字是 `targets.newTaskScope.label`，没连接时 `ConnectionCopy.unconnected`。点了打开 `NewSessionView` 里现在的 `targetPicker`（把它搬过来）。
- 右：新建会话按钮，44×44，`Symbol.compose`，标签「新建会话」。行为同第 5 节。

**中间空白区**，垂直居中：44×44 圆角 14 的 `panel2` 方块（内放 `bubble.left` 一类图标，`Palette.dim`），下面标题「新建会话」（22pt semibold），再下面一行 `Palette.dim` 说明「描述任务，Mac 上的 Agent 会在所选项目里执行」。这些都是静态文案，不放任何数据。没连接时说明改成现有的 `ConnectionCopy.noGatewayForNewTask` / `targetUnavailable`（沿用 `NewSessionView` 顶部 Notice 的逻辑和文案，可以保留成 Notice）。

**底部会话框**：直接用 `HomeComposer` 现在的 `MessageComposer` 配置（顶部项目胶囊 + Provider 胶囊，附件 / 权限 / 模型 · 强度 / 发送）。外边距 12，底部留安全区。
- 从 `NewSessionView` 搬过来、`HomeComposer` 里没有的：`submitError` 的 Notice、「先选择工作目录 / 先选择 Provider」提示、`providerControlsNotice` + 重试按钮、斜杠命令参数（`slashCommands` 等）、`scenePhase` 回到前台时 `retryProviderControls()`。
- 加载项目和 Provider 用 `NewSessionView` 的写法：`.task(id: paired ? targets.newTaskScope.id : nil) { if paired { run.loadProjects(); run.loadProviders() } }`，**原样保留这一行文本**（离线检查会匹配它），`run` 指 `targets.newTaskStore`。
- 发送逻辑不变：`submit` 成功后清草稿、`targets.focusNewTask()`、`route = .chat`。
- `focusComposer == true` 时出现后自动聚焦输入框。`MessageComposer` 的 `@FocusState` 是私有的，给它加一个可选参数（比如 `autoFocus: Bool = false`，`onAppear` 里设 `inputFocused = true`），默认值不改变现有调用方行为。

## 4. 左侧抽屉

对照 `mockups/Sidebar.dc.html`。

- 宽度：`min(屏幕宽 × 0.85, 340)`。从左边滑入，底色 `Palette.sidebar`，右边 0.5pt `Palette.border`，阴影 `black 10%`、半径 30、x 8。
- 遮罩：抽屉右侧整个区域 `Color.black.opacity(0.28)`，点遮罩收起。无障碍上遮罩是一个「收起侧栏」按钮。
- 打开方式：顶栏 ☰；或在新建会话页从左边缘（起点 x ≤ 24）右滑，阈值沿用现在 `RootView` 的数字（水平 > 72 且 > 竖直 × 1.35）。收起方式：遮罩、抽屉顶栏的收起按钮、在抽屉上左滑（同样阈值，方向相反）。拖动过程中可以不跟手，到阈值直接开 / 关，先求稳定。
- 动画：`Motion.animation(.select, reduceMotion:)`。减少动态效果打开时直接出现 / 消失，不滑动。
- 状态：`@State private var drawerOpen = false` 放在 `WorkspaceShell`。不进 `AppModel`、不持久化，所以每次进入这个页面都是收起的。DEBUG 下加一个预览参数 `-drawerOpen` 让它初始为 true，方便截图和 UI 测试（写法参照现有 `applyUIPreviewArguments`）。
- 抽屉打开时收起键盘。

**抽屉内容**就是现在的 `HomeView`，去掉底部 `HomeComposer`：
- 顶栏：左边是现有主机菜单（`hostChip` + Menu），右边把齿轮换成收起按钮（`sidebar.left`，标签「收起侧栏」）。设置入口在主机 Menu 里已经有，另外在抽屉底部加一个齿轮按钮（见下）。
- 顶栏下面新增一行「新建会话」：高 44，圆角 12，`Palette.main` 底 + `Palette.border` 边框，`Symbol.compose` + `ConnectionCopy.newSession`，`Typography.rowTitle` semibold。
- 然后是现有搜索框、刷新失败横幅、进行中任务、后台发送、`HomeSessions`，全部不改。`HomeSessions` 里原有的「新建会话」行和项目内的新建按钮保留，行为按第 5 节。
- 底部固定一行：左边 `ConnectionCopy.panelProvenance(...)`（从 `HomeSessions` 底部挪过来，或保留原位都行，二选一，不要出现两次），右边 44×44 齿轮 → `model.route = .settings`。
- `HomeView` 上挂着的 toast、sheet、alert、confirmationDialog、`.refreshable` 全部保留。
- `targets.setHomeVisible(...)`：抽屉打开时 true，收起或页面消失时 false。首次 `refreshHome()`、`loadProjects()`、`loadProviders()`、`refreshArchived()` 放在 `WorkspaceShell` 的 `.task` 里，页面一出现就做（这样第一次打开抽屉时列表已经在了），行为与现在 `HomeView.task` 相同。
- 点会话行：先收起抽屉，再走现有 `open(row)`。点工具面板同理。

建议把 `HomeView` 改名或重构成 `SidebarDrawer`（只做「去掉 composer、换顶栏按钮、加新建会话行、加底部行」这几处），不要重写会话列表。

## 5. 「新建会话」的行为

抽屉顶部那一行、`HomeSessions` 里的新建行、新建会话页顶栏右上角，三处一致：

1. 调现有 `HomeView.newTask(scope, cwd)`（`beginNewTask` + 可选选中项目 + 清空草稿）。`beginNewTask` 返回 false（当前运行不能脱离）时什么都不做，和现在一样。
2. 收起抽屉（如果开着）。
3. `model.route = .newSession`，会话框聚焦、弹出键盘。已经在 `.newSession` 上时，直接让输入框重新获得焦点（比如给 `WorkspaceShell` 一个 focus 触发计数）。

会话页里的「新任务」菜单项（`ChatView`、`SessionTranscriptView`）已经是 `beginNewTask` + `.newSession`，不用改，自动落到新页面。

## 6. 删除和同步

- 删除 `NewSessionView.swift`，它的功能都已经搬进 `WorkspaceShell`。`G0Transport.RunProviderRef.selectionId` 扩展别的文件在用，要挪到别处（比如 `SelectionPickers.swift`）。`contextRow` 不再需要。
- `HomeComposer.swift`：合并进 `WorkspaceShell` 后删掉，或保留成新页面的会话框子视图，二选一。
- 改 `project.pbxproj`：去掉删除的文件，加上新文件。
- `Checks/new-task-readiness.py` 第 8 行的路径改成新文件；匹配的正则不要改。
- `Checks/device-observation.py` 第 56 行的视图名集合里有 `HomeView`、`HomeComposer`，按新的类型名同步。
- `ScryRemoteUITests/HomeUITests.swift`：现在用 `-route home` 后直接找 `home-search`。搜索框进了抽屉，启动参数加 `-drawerOpen`，或者先点 ☰（给 ☰ 加 `accessibilityIdentifier("sidebar-toggle")`）。保留原来的断言。
- 新增一条 UI 测试：`-uiPreview -connected -uiMockData -route home` 启动后，`home-search` 不可见、`message-input` 可见；点 `sidebar-toggle` 后 `home-search` 可见；点抽屉里的「新建会话」后抽屉收起、`message-input` 获得焦点。
- `apps/ios/README.md` 里描述首页结构的那一句同步成「启动即新建会话，会话列表在左侧抽屉」。

## 7. 文案

新增到 `HomeCopy.swift`：`openSidebar = "展开侧栏"`、`closeSidebar = "收起侧栏"`、`newSessionHint = "描述任务，Mac 上的 Agent 会在所选项目里执行"`。其他都用已有文案。

## 8. 报告要写什么（`reports/L1.md`）

- 改了哪些文件、为什么。
- 第 2 节 `run` 那一行改动后，等待决定横幅在新建会话页上的行为有没有变化。
- 编译、离线检查、UI 测试的完整结果（跑不了的说明原因）。
- `reports/L1/` 下的截图清单。
- 设计稿没覆盖、你做了判断的地方。
