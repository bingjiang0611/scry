# L1b：L1 核验后的修改

基于提交 `c5b9605e`。核验意见见 [reports/L1.md](reports/L1.md) 末尾。README 的硬约束照旧有效。

## 1. 恢复多主机时的等待决定横幅

- `ScryRemoteApp.swift`：`RootView.run` 恢复成改前的写法：`model.route == .newSession ? targets.newTaskStore : targets.selectedStore`。这样 `.home` 上的横幅、问题 sheet、`reachable` / `connectionObservation` 回写、`resumeRecoveredRun` 都和改版前完全一致。
- `WorkspaceShell.swift`：页面部分（顶栏主机胶囊、中间区、`NewSessionComposer`）显式用 `targets.newTaskStore`，做法是在 `page` 上 `.environment(targets.newTaskStore)`，`WorkspaceShell` 自己读 `paired` / `hasConnection` 的地方也改成读 `targets.newTaskStore`，不依赖外层注入。抽屉照旧 `.environment(targets.localStore)`。
- 报告里说明：单主机时 `selectedStore` 与 `newTaskStore` 是同一个对象，所以单主机行为不变；多主机时横幅回到改版前的来源。

## 2. 「新建会话」不丢输入

改 `WorkspaceShell.startNewSession(scope:cwd:)`：

- 目标 scope（传入的，或者没传时 `beginNewTask()` 会选的那个）**等于**当前 `targets.newTaskScope`，并且当前 route 已经是 `.home` 或 `.newSession`：不调 `beginNewTask`，不清草稿。有 `cwd` 就只 `chooseProject`。然后收起抽屉、`focusTicket += 1`、`route = .newSession`。
- 目标 scope 不同：照现在的逻辑走 `beginNewTask(scope:)`，但**不要**清草稿（草稿按 scope 分开存，切过去看到的是那个 scope 自己的草稿）。
- 判断「没传 scope 时会选哪个」不要复制 `beginNewTask` 的内部逻辑；抽屉顶部那一行已经传 `targets.newTaskScope`，页面右上角按钮也改成传 `targets.newTaskScope`，这样所有入口都有明确 scope。
- `ChatView` / `SessionTranscriptView` 的「新任务」菜单不改。

## 3. 抽屉展开时隐藏后面的页面

- `page` 加 `.accessibilityHidden(drawerOpen)`。
- UI 测试里抽屉展开时不再断言 `message-input` 存在或可点；需要的话先收起抽屉再断言。断言意图不变的改动在报告里逐条列出。

## 4. 去掉抽屉里重复的「新建会话」

`HomeSessions.swift` 里项目列表后面那一行「新建会话」按钮删掉（抽屉顶部已经有一行）。各项目右侧的 `+`（带 cwd 的新建）保留。

## 5. 验证

- 编译、`new-task-readiness.py`、`visual-contracts.py`、`theme-motion.py`、`home-sections.py`、`markdown-blocks.py` 照 L1 跑一遍。
- **真机走查（必须）**：按仓库 `CLAUDE.md`，用 `ictrl-phone-control` skill 通过 iCTRL 操作真实手机，安装本分支 Debug 版本，逐条记录结果，截图放 `reports/L1b/`：
  1. 冷启动：落在新建会话页，抽屉收起，不弹键盘。
  2. 点 ☰：抽屉展开；点遮罩收起；从左边缘右滑展开；在抽屉上左滑收起。
  3. 在会话框里输入几个字，打开抽屉点「新建会话」：抽屉收起，键盘弹出，**刚才输入的字还在**。
  4. 点页面右上角新建按钮：同上，字还在。
  5. 抽屉里点某个项目右侧 `+`：项目胶囊切到该项目，键盘弹出。
  6. 抽屉里点一个会话进入，再返回：回到新建会话页，抽屉收起。
  7. 打开「减少动态效果」重复第 2 步：抽屉直接出现 / 消失，不滑动。
  8. 打开 VoiceOver，抽屉展开时左右滑动焦点：只在抽屉和「收起侧栏」之间移动，不会走到后面的会话框。
  截图里只能有 mock 数据（`-uiPreview -connected -uiMockData`），不能有真实会话内容。真机或 iCTRL 不可用就如实写明哪几步没验证，不要用模拟器替代，也不要标成通过。
- UI 测试：真机上能跑就跑 `-only-testing:ScryRemoteUITests`；跑不了照实写原因。

## 6. 交付

写 `reports/L1b.md`（改了什么、走查 8 步各自的结果、检查结果），`STATUS.md` 加一行 L1b 标「待核验」，只 push `design/ios-launch-new-session`。
