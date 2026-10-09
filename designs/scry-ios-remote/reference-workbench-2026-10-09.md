# Scry iOS · Reference workbench

## D-2026-10-09-dark-workbench

- Scope / status：Scry iOS；confirmed（用户需求，成品待审），不升级为跨项目深色偏好。
- Feedback：本轮用户“优化 scry ios 的 ui 和 ux，按照图中来”，提供六张移动端 Pi 工作台截图。
- Reference：借鉴近黑画布、左对齐会话标题、无外框工具行、小圆角用户消息、上下分层的输入/模型区、深色工作目录面板。不复制社交平台覆盖层、视频控制或 Android 系统键盘。
- Reuse：现有 `Palette`、`RemoteHeader`、`ConversationChunk`、`MessageComposer`、原生 Sheet 和文件夹浏览合同；个人库按 scry/page 与 composer/component 检索未命中可复用项。
- Preserve：真实 lifecycle、离线禁发、审批菜单、附件限制、slash commands、草稿隔离、历史完整性与用量 provenance。没有 terminal/steer/主机切换 API，就不添加假入口；不伪造工具成功图标、上下文百分比或费用。

## Applied

- `Theme.swift` / `Info.plist`：暖中性深色表面与系统深色样式；语义色仅用于真实状态。
- `Components.swift`：紧凑左对齐顶栏；工具调用、结果和思考默认折叠成 44pt 可点击行，展开保留提供的文字；输入栏无卡片边框/阴影；附件/发送与模型设置分层；模型菜单触控高度至少 44pt；用量等宽数字。
- `ChatView.swift` / `SessionTranscriptView.swift`：用户消息小圆角，live/history 同色，标题取会话信息。
- `NewSessionView.swift`：一致的输入栏分隔与工作目录选择按钮。
- `PairView.swift` / `SignInView.swift` / `HomeView.swift`：去除浅色硬编码，校正深色下按钮和品牌图标对比。
- `ScryRemoteApp.swift`：DEBUG 预览不再被 mock run 的恢复路由覆盖。发现之前 `-route new|transcript -uiMockData` 会意外进入 ChatView；修复只影响 DEBUG preview，真实恢复逻辑不变。

## Evidence / limits

- 当前工作区 App + 新增 XCTest UI target：`xcodebuild build-for-testing` 成功；plist/project 解析成功；`git diff --check` 成功。构建包含其他任务的未提交 transport/history 改动，不代表它们通过本次验收。
- 实际原生模拟器对照：改动前浅色卡片；改动后深色 ChatView 和 NewSessionView。通过 AX 实际展开/折叠工具调用：完整文字出现，折叠后消失，value 回到“已折叠”。工作目录按钮实际打开原生深色文件夹 Sheet，显示授权目录和子目录。
- 新增 `ScryRemoteUITests/ConversationUITests.swift`：工具/思考展开、键盘与模型设置保留草稿、离线禁发、slash 插入，以及预览路由检查。**测试编译成功，运行未完成；不能称为通过。**
- 首轮 test build 因 XCTest query 使用错误失败，已改为 query.matching(identifier:)；第二轮卡在 iOS 26.5 的 DTServiceHub/lockdown 连接；新建隔离 iOS 26.3 模拟器的第三轮也在启动测试前超时，结果 bundle 不完整。两个 300 秒超时均检查了进程/日志后停止，没有扩大 timeout 或循环重试。
- 原生 AX 输入尝试没有获得文字/键盘变化的证据，未发送消息；键盘弹出/收起、输入栏与键盘坐标关系、多行输入、模型切换保留草稿、真实 Provider 和真机均未验证。
- 没有发布、安装到真机、推送、升版本或新增对外接口。
- 个人设计库登记 `P-SCRY-IOS-WORKBENCH`，build 完成，`dark workbench` 检索命中；check 仍因既有 `P-PI-MODEL-SELECTOR` 源文件缺失失败，未修改无关条目。

## Next use

移动端 coding 对话 → 先复用紧凑工具行与分层 composer → 检查长命令完整展开、离线禁发、模型/审批可操作、键盘不遮挡发送、历史不完整提示仍可见。恢复 XCTest 设备服务后执行：

```sh
xcodebuild test -project apps/ios/ScryRemote.xcodeproj -scheme ScryRemote \
  -configuration Debug -destination 'platform=iOS Simulator,id=<disposable-device>' \
  -derivedDataPath /tmp/scry-ios-reference-ui CODE_SIGNING_ALLOWED=NO \
  -parallel-testing-enabled NO
```

待用户验收具体版本；之后若要求终端或运行中 steer，先扩展真实 host/provider 合同，再做 UI，不用静态入口占位。
