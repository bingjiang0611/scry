# iOS 启动即新建会话：交接（2026-10-27）

目标：打开 App 直接进入新建会话；左侧任务栏（现在的首页会话列表）默认收起，点 ☰ 才展开；点「新建会话」时，底部的会话框聚焦并弹出键盘。

- 设计稿（用户已确认方向）：<https://claude.ai/artifact/JbcSAQAGLaVQ39Tn2mFD3g>。这是私有画布，执行方可能打不开，仓库里的 [mockups/](mockups/) 是同一份源码。
- 落地规范：[SPEC.md](SPEC.md)。设计稿与 SPEC 不一致时，以 SPEC 为准。
- 进度：[STATUS.md](STATUS.md)。

上一轮改版（R1–R6e）的 token、组件和已知问题见 [../ios-redesign-2026-10-25/FINAL.md](../ios-redesign-2026-10-25/FINAL.md)。本轮在它的基础上做，不重做颜色、字体、动效。

## 协作方式

- **设计与核验方**（Claude，项目线程）：写规范、核验结果。
- **执行方**（另一个 agent）：按 SPEC 实现，推送到 `design/ios-launch-new-session`。
- 执行方做完一批，写 `reports/<批次>.md` 并 push，然后告诉用户。核验方在 STATUS.md 标 `已核验` 或在报告末尾写「核验意见」。
- 执行方只 push `design/ios-launch-new-session`。不 push `main`，不开 PR、不合入，合入由用户决定。

## 批次

| 批次 | 内容 |
|---|---|
| L1 | 启动 = 新建会话页、左侧抽屉（默认收起）、新建会话聚焦会话框、删除旧的「新任务」页 |

只有一批。做完后如果有设计稿没覆盖到的情况，写进报告，不要自己发挥。

## 硬约束

1. **证据不能说谎**（仓库 `CLAUDE.md` 第 1 条）。设计稿里的会话标题、项目名、模型名、「14:51 读取」都是示意，必须来自主机的真实数据。没有的数据不显示或显示现有的「未连接 / 先选择项目」文案，不能编。
2. **只改 UI 层**。不改 `RemoteRunStore`、`ExecutionTargetCoordinator`、`AppModel` 的状态语义，不改配对、连接、outbox、权限、`RemoteTransport` wire 格式。`AppModel.Route` 枚举保持不变（`.home` 和 `.newSession` 都保留，见 SPEC 第 2 节）。确实要新增只读派生属性或纯 UI 状态时，单独提交并在报告里说明。
3. 保留上一轮的诚实不变量：「已配对」与「已连接」的区分、运行状态只出现一次、有可恢复的运行时仍自动回到会话页（`resumeRecoveredRun`）、等待决定的横幅照常显示。
4. 触控区域 ≥ 44pt，文字对比度 ≥ 4.5:1，所有动画在「减少动态效果」打开时降级（用 `Motion`，不要新写时长）。
5. 不引入第三方依赖。新增或删除 Swift 文件要同步改 `apps/ios/ScryRemote.xcodeproj/project.pbxproj`。
6. 只提交本批相关改动，不做无关格式化或重构。`mockups/` 不要改。

## 验证

- 编译：`xcodebuild -project apps/ios/ScryRemote.xcodeproj -scheme ScryRemote -configuration Debug -sdk iphonesimulator build`。
- 离线检查：`python3 apps/ios/Checks/new-task-readiness.py`（要按 SPEC 第 6 节改路径）、`catalog-refresh.py`、`home-sections.py`、`markdown-blocks.py`、`visual-contracts.py`、`theme-motion.py`，以及 `-selfTest`。改版前就失败的项只报告，不修、不跳过。
- UI 测试：`xcodebuild test … -only-testing:ScryRemoteUITests`。`HomeUITests` 需要先打开抽屉（SPEC 第 6 节）。签名名额不够跑不了的话，至少保证编译通过并在报告里说明。
- 截图：DEBUG 预览参数（`-uiPreview -connected -uiMockData -route home|new`）在 iPhone 15 尺寸下截：启动态、抽屉展开、新建会话聚焦，各深浅两张，放 `reports/L1/`。截图里只能有 mock 数据。
