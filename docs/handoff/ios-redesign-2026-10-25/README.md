# iOS 界面重设计交接（2026-10-25）

目标：iOS（`apps/ios/ScryRemote`）的体验尽量与 Mac 端一致。设计稿已由用户确认：<https://claude.ai/artifact/WkPCeBVNnSvTDauRq84tHJ>（私有画布，执行方可能打不开；仓库内的 [mockups/](mockups/) 是同一份源码，[SPEC.md](SPEC.md) 是落地用的文字规范，以 SPEC 为准）。

## 协作方式

- **设计与核验方**（Claude，本会话）：写设计规范与批次文档，核验每批结果。
- **执行方**（另一个 agent）：按批次文档实现，推送到 `design/ios-redesign`。
- 执行方完成一批 → 写 `reports/<批次>.md` 并 push → 核验方在 [STATUS.md](STATUS.md) 标 `已核验`，或在报告末尾写「核验意见」并标 `需修改` → 执行方修改后再 push。
- 用户已授权执行方向 `design/ios-redesign` push。不 push `main`，不开 PR、不合入，合入由用户决定。
- 一次只做一批。下一批文档由核验方在上一批核验后写入本目录，执行方不要提前做。

## 批次

| 批次 | 内容 | 文档 |
|---|---|---|
| R1 | 基础层：颜色 token（深浅两套，跟随系统）、动效 token、字体角色 | [R1.md](R1.md) |
| R2 | 首页：去掉抽屉，首页 = Mac 侧栏（项目 / 动态） | [R2.md](R2.md) |
| R3 | 会话页：正文结构、头部、状态条、Composer 外壳 | R2 核验后写 |
| R4 | Sheet：需要你决定、会话总览、模型 · 推理强度选择 | R3 核验后写 |
| R5 | 动效收尾、减少动态效果、浅色与大字号走查 | R4 核验后写 |

## 所有批次共同的硬约束

1. **证据不能说谎**（仓库 `CLAUDE.md` 第 1 条）。设计稿里的数字（Token、费用、时长、思考秒数、上下文占用、工具计数）只是示意。Mac 主机没提供的值显示「Mac 未提供」或 `—`，不能显示 0、不能估算、不能为了填满版面去编。需要改主机协议才能拿到的数据，停下来写进报告，交给用户决定。
2. **只改 UI 层**。不改 `RemoteRunStore`、`ExecutionTargetCoordinator`、`AppModel` 的状态语义、配对 / 连接 / outbox / 权限逻辑，也不改 `RemoteTransport` wire 格式。确实需要新增只读派生属性时，单独提交并在报告里说明。
3. **保留 README 里的诚实不变量**：「已配对」与「已连接」的区分、运行状态只在状态条出现一次、停止需要确认、未知结果不冒充失败等。
4. 触控区域 ≥ 44pt；文字对比度 ≥ 4.5:1（大字 ≥ 3:1）；每个动画都要在「减少动态效果」打开时降级（见 SPEC 动效一节）。
5. 不引入第三方依赖；新增 Swift 文件要同时加进 `ScryRemote.xcodeproj/project.pbxproj`（两个 target 如有需要）。
6. 只提交本批相关改动，不做无关格式化或重构。设计稿源文件（`mockups/`）不要改。

## 验证（每批都要）

- 编译：`xcodebuild -project apps/ios/ScryRemote.xcodeproj -scheme ScryRemote -configuration Debug -sdk iphonesimulator build`（能真机就按 `apps/ios/README.md` 的真机命令）。
- 离线检查：`python3 apps/ios/Checks/new-task-readiness.py`、`python3 apps/ios/Checks/catalog-refresh.py`、`python3 apps/ios/Checks/markdown-blocks.py`，以及 `-selfTest`。
- UI 测试：`ConversationUITests`（`xcodebuild test … -only-testing:ScryRemoteUITests`）。本来就失败的用例只报告，不修、不跳过。
- 截图：用 DEBUG 预览参数（`-uiPreview -connected -route home|chat|… -uiMockData`）在 iPhone 13/15 尺寸下截深色和浅色两张，放 `reports/<批次>/`。截图里只能有 mock 数据，不能有真实会话内容。

## 回报格式（核验依据）

`reports/<批次>.md`：

- 本批每一项：`完成 / 部分 / 未做` + 一句话
- commit hash
- 改了哪些文件、为什么
- 跑过的命令与结果；首次失败与重跑都如实写
- 截图清单
- 与 SPEC 不一致的地方及原因、需要用户决定的事
