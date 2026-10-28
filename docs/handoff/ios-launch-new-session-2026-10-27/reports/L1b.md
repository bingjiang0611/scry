# L1b 执行报告：核验后的四项修改 + 真机走查

基线 `c5b9605e`（L1）。本次提交包含 L1b 第 1–4 项修改、一处真机走查发现的拖动缺陷修复、UI 测试断言调整，以及 `reports/L1b/` 下的真机截图。

## 1. 改了哪些文件，为什么

### 1.1 恢复多主机时的等待决定横幅来源（L1b #1）

| 文件 | 改动 |
|---|---|
| `apps/ios/ScryRemote/ScryRemoteApp.swift` | `RootView.run` 回到 `model.route == .newSession ? targets.newTaskStore : targets.selectedStore` |
| `apps/ios/ScryRemote/WorkspaceShell.swift` | 删掉 `@Environment(RemoteRunStore.self) private var run`；改为 `private var run: RemoteRunStore { targets.newTaskStore }`；`page` 上显式 `.environment(run)` |

`.home` 上读 `RootView.run` 的路径（等待决定横幅、问题 sheet、`reachable` / `connectionObservation` 回写、`resumeRecoveredRun`）恢复成改版前的 `targets.selectedStore`；新建会话页自己需要的那份 store 由 `page` 注入，不依赖外层。

单主机为什么不变：`ExecutionTargetCoordinator` 只有本地目标时，`selectedStore` 与 `newTaskStore` 是同一个对象，两个来源指向同一实例，行为逐字相同。多主机时两者才分离，此时横幅重新读「会话列表当前选中 scope」的 store，与 L1 之前一致。

### 1.2 「新建会话」不再丢输入（L1b #2）

`WorkspaceShell.startNewSession(scope:cwd:)` 改为：

- 目标 scope 等于 `targets.newTaskScope`：不发 `beginNewTask`，不清草稿，只 `detachFocusedRun()`（把可能的运行中任务留在后台，和以前一样可能返回 false 并中止）；有 `cwd` 只 `chooseProject`。
- 目标 scope 不同：走 `beginNewTask(scope:)`（其中含 `resetNewTaskContext()`），但不清草稿 —— 草稿按 scope 分开存，切过去看到的是那个 scope 自己的草稿。
- 两种路径收尾相同：`setDrawer(false)`、`focusTicket += 1`、`route = .newSession`。

入口都显式传 scope，不再复制 `beginNewTask` 的 scope 推断：页面右上角按钮 `startNewSession(scope: targets.newTaskScope)`，抽屉顶部「新建会话」行传 `targets.newTaskScope`，项目右侧 `+` 传 `project.scope` + `project.cwd`。`ChatView` / `SessionTranscriptView` 的「新任务」菜单未改。

`detachFocusedRun()` 直接沿用原 `beginNewTask` 的第一行语义；同 scope 路径唯一被去掉的是 `resetNewTaskContext()`（它才是清草稿/附件/项目/Provider 的那一步）。

### 1.3 抽屉展开时隐藏后面的页面（L1b #3）

`WorkspaceShell.page` 加 `.accessibilityHidden(drawerOpen)`。UI 测试断言逐条调整见第 3 节。

### 1.4 去掉抽屉里重复的「新建会话」（L1b #4）

`HomeSessions.swift` 删掉项目列表后面那一行 `Button { onNewTask(targets.newTaskScope, nil) }`；各项目右侧的 `+`（带该项目 cwd）保留。

### 1.5 真机走查发现并修复：页面空白区的左边缘右滑打不开抽屉

`WorkspaceShell.page` 的 `simultaneousGesture(DragGesture(...))` 挂在没有背景的 `VStack` 上。SwiftUI 只对命中测试通过的位置派发手势，而页面中部是纯文本/留白，于是「从左边缘右滑」只在文字或控件上生效，落在空白处时整个手势不触发。

真机证据（同一构建，`reports/L1b/` 之前的一轮操作）：`swipe{x:22,y:500}`（中部空白）无任何变化；`swipe{x:20,y:640}`（落在元数据文字上）立刻展开抽屉。

修复：`page` 加 `.contentShape(Rectangle())`。修复后 `swipe{x:18,y:500}` 正常展开（截图 `2c-edge-swipe-open.png`）。这一项不在 L1b 四条之内，属于走查第 2 步的验收失败，按最小改动在 `page` 上补齐命中区域，未改阈值（72 / ×1.35）和 reduce-motion 分支。

## 2. UI 测试断言逐条变化（L1b #3 要求）

| 位置 | 原断言 | 现断言 | 意图是否变化 |
|---|---|---|---|
| `launchHome()` | `message-input` 存在 | 删掉；改为 `sidebar-close` 存在 | 是：helper 用 `-drawerOpen` 启动，此时抽屉展开、页面已无障碍隐藏，不能同时断言页面元素 |
| `testLaunchShowsNewSessionWithCollapsedDrawerAndFocusesComposer` | 启动后 `message-input` 存在；点 ☰；点抽屉行；`message-input` 可点 | 启动后 `message-input` 存在 + **无键盘** + 抽屉收起；**输入 `keep this draft` 并收起键盘**；展开抽屉；断言 `message-input` **不可点**；点抽屉行；键盘出现、抽屉收起、`message-input` 可点且 `value` 仍是 `keep this draft` | 是：新增 L1b #2（草稿不丢）与 #3（抽屉展开时页面不可及）的覆盖 |
| `testNewTaskInProjectKeepsSelectedProjectAndClearsDraft` → `...AndDraft` | 项目 `+` 后草稿被清空（`XCTAssertFalse contains`） | 项目 `+` 后草稿仍在（`XCTAssertTrue contains`），项目胶囊为 `scry` | 是：L1b #2 明确要求不清草稿，旧断言编码的正是被否掉的行为 |
| `testTabsSearchScopesAndSettings` 等 | `app.buttons["sidebar-toggle"].tap()` | `openDrawer()`（同一动作，改名便于阅读） | 否 |

`testNewTaskInProjectKeepsSelectedProjectAndDraft` 里读 `input.value` 发生在点项目 `+` 之后，只有抽屉已经收起、页面重新可访问时该查询才成立，所以它同时覆盖「点完收起抽屉」。

## 3. 真机走查（iPhone 13 / iOS 26.5.2，iCTRL）

构建：`-sdk iphoneos`，`DEVELOPMENT_TEAM=<个人团队 ID>`，`PRODUCT_BUNDLE_IDENTIFIER=com.scry.remote.local`（与用户已装的 `com.scry.remote` 分开，避免覆盖），启动参数 `-uiPreview -connected -uiMockData -route home`，只出现 mock 数据。

| 步骤 | 结果 | 证据 |
|---|---|---|
| 1 冷启动：新建会话页、抽屉收起、不弹键盘 | 通过 | `1-launch.png`；`page_source` 里无 `home-search`，`keyboard.visible=false` |
| 2 点 ☰ 展开 / 点遮罩收起 / 左边缘右滑展开 / 抽屉上左滑收起 | 通过（右滑需 1.5 的修复） | `2a-drawer-open-toggle.png`、`2b-dimmer-collapse.png`、`2c-edge-swipe-open.png`、`2d-drawer-swipe-close.png` |
| 3 输入后经抽屉「新建会话」：收起、弹键盘、字还在 | 通过 | `3a-typed.png`（已输入）、`3b-drawer-over-draft.png`、`3c-new-session-drawer-row.png`；`keyboard.visible=true`，`TextField, value: '草稿-不要丢'` |
| 4 页面右上角新建按钮：同上 | 通过 | `4-top-new-button.png`；键盘保持、`value` 仍为草稿、抽屉收起 |
| 5 抽屉里点项目 `+`：胶囊切到该项目、弹键盘 | 通过 | `5a-drawer-before-project-new.png`、`5b-project-new-session.png`；胶囊由 `ios` 变 `scry`，键盘弹出，草稿保留 |
| 6 进会话再返回：回到新建会话页、抽屉收起 | 通过 | `6a-session-entered.png`、`6b-back-to-new-session.png`；返回后无键盘、抽屉收起、草稿仍在 |
| 7 打开「减少动态效果」重复第 2 步 | 部分验证（见下） | `7e-reduce-motion-open.png`、`7f-reduce-motion-closed.png`；同一构建关掉该开关的对照是 `2a`/`2b` |
| 8 VoiceOver 展开抽屉后左右滑动焦点 | 部分验证（见下） | `8a-vo-start.png`：旁白开启、焦点框落在 ☰；`8b-vo-next1.png`：合成滑动未移动光标 |

第 7 步为什么只算部分：开关本身在真机上切换并确认（设置里 `Switch, label: 'Reduce Motion'` 由 `0` 变 `1`，再复原），抽屉在减少动态效果下仍能开合并截图留证；但「直接出现/消失、不滑动」是帧级属性，手上没有可比对时序的工具（iCTRL 无录像接口，单张截图往返约 0.3 s，比抽屉动画还慢），两次 `tap` 的 settle 统计在开关前后都是 `samples=2 / waited_ms≈270`，分辨不出差异。该性质目前由代码路径（所有抽屉动画都经 `Motion.animation(..., reduceMotion:)`，减少动态效果时返回 nil）和 `theme-motion.py` 通过支撑，未做帧级观测。

第 8 步为什么只算部分：旁白已开启，打开 Scry 后焦点框确实出现并被截图（`8a-vo-start.png`），但 iCTRL 的合成手势不会移动旁白光标（两次 `swipe` 都返回 `settle.screen_changed=false`，前后截图 60450 / 60451 字节，`8b-vo-next1.png`），无法由本机驱动遍历；核验方选择的处理是如实记为部分验证，不做人工代跑。另外，iCTRL 的 `page_source` / `find_element` 不反映无障碍隐藏标记（`page` 里显式 `.accessibilityHidden(true)` 的装饰图标仍出现在树里，`home-search` 在抽屉收起时仍能以 `offscreen` 被 `find_element` 找到），所以那份树也不能当作 #3 的证据。

## 4. 检查结果

| 检查 | 结果 |
|---|---|
| `xcodebuild -sdk iphonesimulator build` | BUILD SUCCEEDED（1 条既有 `onChange(of:perform:)` 弃用告警，`ScryRemoteApp.swift:152`） |
| `xcodebuild -sdk iphoneos build`（真机） | BUILD SUCCEEDED，安装到 iPhone 13 |
| `Checks/new-task-readiness.py` | PASS，7 项，0 失败 |
| `Checks/visual-contracts.py` | PASS，47 文件 |
| `Checks/theme-motion.py` | exit 0 |
| `Checks/home-sections.py` | PASS，25 项 |
| `Checks/markdown-blocks.py` | PASS，17 项 |
| `-only-testing:ScryRemoteUITests/HomeUITests`（模拟器） | 未跑起来：`DTServiceHubClient failed to bless service hub`，与 L1 同一环境阻塞（宿主机 Developer Mode 未开启），900 s 后中断 |
| 同上（真机） | 未跑起来：设备已达「免费开发者描述文件应用数量上限」（已占 `com.baobingjiang.ictrl.uitests.xctrunner`、`com.baobingjiang.etch.mobile`、`com.scry.remote.local`），安装测试 Runner 报 `MIInstallerErrorDomain Code=13` |

`catalog-refresh.py`、`-selfTest` 的 3 项失败是 L1 已记录的既有问题，本次未动。

## 5. 未验证 / 限制

- 第 7、8 步如上：只到「功能正常 + 焦点框可见」，帧级动画与焦点遍历顺序未观测。
- UI 测试整体未运行，`HomeUITests` 的新断言（草稿保留、抽屉展开时输入框不可点、`收起键盘` 按钮）都只有代码评审证据。
- `page` 的 `.accessibilityHidden(drawerOpen)` 无自动化断言：真机 UI 测试受免费名额限制，iCTRL 快照不反映该标记。若将来跑 UI 测试发现 XCUITest 仍能看到 `message-input`，需要换成 `.accessibilityAddTraits(.isModal)` 一类机制，这一点写在这里备查。
- 多主机分支（不同 scope 的 `beginNewTask(scope:)` 路径）未在真机验证：mock 只有一个主机。该路径与 L1 相同，唯一差别是不再清草稿。
- 真机走查期间的设备改动：`com.scry.remote.local`（本分支 Debug）已安装；iCTRL Runner 因免费描述文件到期重新签名并覆盖安装（新描述文件到 2026-11-04，资源与 entitlements 校验未变）；期间打开过的「减少动态效果」和「旁白」都已复原关闭。

## 核验意见（2026-10-28，核验方）

结论：**已核验**。

- 四项修改都按 L1b 做了，代码看过：`RootView.run` 恢复原样，新建会话页自己用 `targets.newTaskStore`；同一 scope 下只 `detachFocusedRun()`，不重置、不清草稿；`page` 对 VoiceOver 隐藏；列表里重复的新建行已删。
- 1.5 节空白区右滑打不开抽屉，是走查发现的真问题，`contentShape` 的修法是最小改动，接受。
- 第 7、8 步记成部分验证、UI 测试没跑起来，这些都如实写了，放进 FINAL.md 的已知问题。
- 报告里的个人开发团队 ID 已改成占位（核验方改的）。
