# R6b 阅读区定位：iOS 18 边缘锚点方案

分支 `design/ios-redesign`，基于 `2aa3e07c`。先读 [reports/R6.md](reports/R6.md) 全文和末尾核验意见。用户授权范围同 R6：可以改 `ConversationScrollView` 的滚动 / 跟随逻辑，不改数据、协议、`RemoteRunStore`。

## 为什么换方案

R6 证明了两件事：

1. 按估算高度 `scrollTo` 会落到空行。
2. `scrollPosition(id:)` 能落对位置，但会挂死。挂死很可能来自**双向写入**：几何 / 拖拽 / revision 变化时反复写定位目标，定位又改变几何，形成循环。

iOS 18 有不依赖 ID 和高度的系统级做法：`defaultScrollAnchor(_:for:)` 让系统在初始和内容增长时自己贴住底部；`ScrollPosition.scrollTo(edge:)` 按边缘定位；`onScrollGeometryChange` 和 `onScrollPhaseChange` 给出真实的 offset / size / 视口和用户手势阶段。lazy 行的估算误差由系统在布局时修正，应用层不再参与。设备是 iOS 26，部署下限 iOS 17。

## 要做的事

**第 0 步：防挂死门槛（先做，不过就停）**

只改 `ConversationScrollView`，在 iOS 18+ 分支实现下面的结构，**先不管 A/B/C 是否修好**，真机做 200 次「点输入框 → 输入 → 收键盘 → 上滑 → 下滑」循环（可脚本化）。出现一次无响应就停，把复现写进报告，不进入第 1 步。

**第 1 步：结构**（`if #available(iOS 18, *)`；iOS 17 保留现在的实现不动，报告里写明 iOS 17 仍有已知问题）

- 初始：`.defaultScrollAnchor(.bottom, for: .initialOffset)`。删除 `onAppear` 里的 `scrollTo`。
- 跟随：`.defaultScrollAnchor(following ? .bottom : .top, for: .sizeChanges)`。内容增长时由系统贴底，阅读旧消息时以顶部为锚，不抢位置。删除 `onGeometryChange` 里的排队 `scrollTo`，以及 `revision` / `viewport.size.height` 变化时的 `scrollTo`。
- 判断「是否在底部」：`onScrollGeometryChange` 用 `contentOffset.y + containerSize.height >= contentSize.height - 30` 推出布尔值，替代 1pt 标记和 `ConversationBottom` preference。
- 何时停止 / 恢复跟随：只有**用户手势**能让 `following = false`（`onScrollPhaseChange` 处于 `.interacting` 且离开底部）；离开手势后回到底部附近则恢复 `true`。替代现在的 `DragGesture`。
- 主动定位：`@State var position = ScrollPosition(edge: .bottom)` 配 `.scrollPosition($position)`。**只在三个用户意图时写**：点「回到最新」、`followLatestRequest`（发送被接受）、`stopFollowingRequest`（加载更早历史，只改 `following`，不写 position）。写法统一为 `position.scrollTo(edge: .bottom)`。
- **单向数据流（硬约束）**：几何回调只能读、只能改 `following`，不能写 `position`；`position` 的写入点只能是上面三处。报告里列出所有写 `position` 和 `following` 的行。
- `browsingOlder`、`onFollowingChange` 回调、「回到最新」按钮样式和出现条件，对外行为保持不变。

**第 2 步：回归**（R6.md 验收一节全部，默认字号和 AX3 两档，真机）

- A：上翻 → 发送 → 看到回复并恢复跟随。
- B：`-route transcript -uiMockFirstScreen` 首屏落底（两档）。
- C：AX3 下已完成、历史、运行中三个页面打开即见最新内容。
- 阅读旧消息时流式新增不抢位置（`-uiMockMacRun` 上翻后观察 10 秒）；展开 / 收起思考和工具组锚点 y 差 ≤ 2pt；加载更早历史后位置保持。
- 减少动态效果打开重复 A–C。
- `ReaderPositionUITests` 三个用例：签名名额仍挡着就照实写，用真机重放补证据。

## 不要做

- 不用 `scrollTo(id:)` / `scrollPosition(id:)`，不按高度或 offset 计算目标位置后写回。
- 禁止项同 R6：延时、重试、假高度、强制 `.id()` 重建、`LazyVStack` 改 `VStack`、嵌套 lazy。
- 第 0 步不过不要继续试别的方案，停下来写报告。核验方会和用户决定是否改为「打开时一次定位、之后完全由用户控制」的产品取舍。

## 验收与报告

- README「验证」一节 + 全部 Checks；`npm run performance:measure`（跑不出写 unavailable）。
- `apps/ios/README.md`「Conversation positioning and freshness」按新实现更新（iOS 18+ 与 iOS 17 分别写）。
- 截图 `reports/R6/`：A 发送后、B 首屏 AX3、C 三页 AX3 深色、默认字号已完成会话。
- 报告追加到 `reports/R6.md` 新一节「R6b」：防挂死结果（次数、方式）→ 改动 → 写入点清单 → 回归结果 → 未验证项。不写 UDID / 团队 ID。STATUS 的 R6 行改「已提交」，push。
