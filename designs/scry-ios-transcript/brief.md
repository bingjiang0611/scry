# Scry iOS · 会话详情重设计 / 2026-10-13

## D-20261013-scry-ios-transcript

- 范围 / 状态：Scry iOS 会话详情（`SessionTranscriptView`，以及同一种会话屏 `ChatView`）；需求已确认。
- 选定：2026-10-13 用户回复“A”，选中方向 A（底部状态条）。基线：commit `b06c4ee`，`index.html` sha256 `e0e9d7a9…451b`。未回答的 A1（用量放长按）按设计稿默认实现。
- 实现差异：“长按回合 → 本轮详情”会与 Agent 正文的文字选择冲突，改为长按**用户气泡**打开系统菜单（复制 + 本轮详情），与 iMessage 一致；用户气泡不再支持局部选择，只能整段复制。本轮详情不显示来源。
- 用户原话：“手机发送消息和 mac 发送消息在手机端 UI 不一样，我理解应该是一致的，不区分；目前各种状态很乱，希望可以简洁些。重新设计会话详情的 UI，先出设计稿。”

## 任务

用户在手机上打开一段会话：读懂发生了什么，知道 Agent 现在是否在工作，必要时停止、回答或续聊。
成功的标志：同一段会话里每一轮长得一样；任何时刻屏幕上最多一处运行状态。

## 现状根因（代码证据）

同一个“回合”有 5 条渲染路径，各自带不同装饰：

| 路径 | 来源 | 额外装饰 |
| --- | --- | --- |
| `HistoryTurnView` | Mac/Provider 会话记录 | 无状态、无用量、无附件 |
| `completedTurnView` | 本机已完成的续聊 | 绿点“已完成”、用量 chip、附件 |
| `liveTurn` | 本机正在运行 | 彩色状态点 + 7 种文案 + 占位句 |
| `detachedTurn` | 本机发起后离开、再回来 | “以上为主机实时输出的缓存…”脚注 |
| `backgroundSend` | 未确认的发送 | `SendingLabel` |

所以“手机发的”看起来多了状态和用量，“Mac 发的”看起来什么都没有。
差异不是来源本身造成的，是数据形状不同（`RunHistoryTurn` 只有 `runId/userText/items`）加上各写各的视图。

运行状态同时可能出现在 5 处：标题副标题、顶部状态行（`session-runtime-status` / `liveRunBar` / `SessionRunStatusView`）、回合内状态点、composer 下方提示行（5 种）、横幅（历史错误 / 提交错误 / 只读）。还区分“Mac 上正在运行”与“任务正在运行”。

## 约束

- H1 证据不能说谎（CLAUDE.md）：失败 / 已停止 / 未读取到输出必须可见；缺用量不显示 0；`recorded` ≠ 已执行。
- H2 不伪造 Mac 侧数据：历史回合没有 lifecycle/用量/附件，UI 不能补出来。
- H3 离线禁发、停止二次确认、问题 sheet、附件限制、草稿隔离保持不变。
- H4 延续已认可的 dark workbench（P-SCRY-IOS-WORKBENCH）：近黑画布、无卡片 Agent 内容、44pt 工具行。
- S1 用户偏好：不区分消息来源；状态简洁。
- A1 假设：用户日常不需要逐轮看用量；需要时点开即可。待用户确认。

## 统一规则（三个方向共用）

1. 统一回合结构：用户气泡 + Agent 内容 + 可选尾部。所有来源共用气泡与内容组件，不显示来源；外层会话负责相同的行间距与懒布局。
2. 已结束且正常、有输出的回合：不显示状态或用量。用量 / runId 放进“本轮详情”（长按用户气泡）；不显示来源。缺用量写“Mac 未提供”。
3. 状态分层，每层只有一个位置：

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 0 静默 | 空闲、已完成、历史来源/快照说明 | 不显示；历史说明进入标题 `···` 的会话信息 |
| 1 进行中 | 发送中 → 等待开始（recorded/dispatched）→ 运行中 → 停止中；需要你决定 | 方向 A/B/C 各选一处 |
| 2 回合异常 | 失败、已停止、未读取到输出 | 该回合尾部一行 |
| 3 会话问题 | 连接中断、历史读取失败、更早记录未读、只读浏览 | 一条横幅（A 并入状态条） |

4. 颜色只用于需要行动或异常：蓝 = 运行中，琥珀 = 需要你，红 = 失败。删除“已完成”绿点。
5. 删除 composer 下方的 5 种提示行；运行中可写草稿由 placeholder 表达。

## 调研

研究问题：一个对话里，消息状态如何只在需要时出现、且不因发送端不同而不同？

| 来源 | 可观察事实 | 借鉴 | 不借 / 原因 | 动作 |
| --- | --- | --- | --- | --- |
| Apple iPhone User Guide · Send and reply to messages（support.apple.com，已看原文） | 同一发送者一种气泡；发送失败才出现提示并可重试；时间戳默认隐藏，左滑才显示 | 正常态静默、异常就地、元信息按需显示 | 蓝/绿气泡按传输通道区分：正是用户反感的“按来源区分” | 统一规则 1、2、层 2 |
| Apple HIG · Progress indicators（developer.apple.com，已看原文） | 后台操作或空间受限时用 spinner；不要给 spinner 加标签 | 运行中只用小 spinner + 短词 | — | 层 1 文案压到 2–4 字 |
| Scry Mac `ChatTurn.tsx`（项目内基线） | 运行状态在 Agent 标识行；完成后变成 tok/tools 小统计；所有用户消息同一气泡 | Mac 的“状态跟随回合”结构 | 完成后的统计行在手机上与历史回合不对称（历史无数据） | 方向 B；统计进详情 |
| P-SCRY-IOS-WORKBENCH（已认可方向） | 暗色工作台、折叠工具行 | 视觉保持不变 | — | 只改结构，不换视觉 |

查库：`library.py search` 以 scry / workbench / chat 检索，命中 P-SCRY-IOS-WORKBENCH 与 P-SCRY-CHAT-PREVIEW；page/component 级未命中可复用会话详情组件。
缺口：未看真机 ChatGPT/Codex iOS 运行态（无可访问原始画面）；方向 C 的“发送键变停止键”借鉴来自常识，标为未验证假设。

## 方向

见 `index.html`。同一内容、同一 6 个状态比较。

- A 底部状态条：所有进行中与会话问题都在 composer 上方一条。一眼就知道去哪看。
- B 回合尾部：状态跟着最新回合走，和 Mac 一致；会话问题用顶部横幅。
- C 输入框即状态：发送键变成停止 / 回答；最少的额外元素。

## 验收（实现阶段）

- 同一会话中历史回合、本机续聊、Mac 发起的回合截图对比，结构一致。
- 6 个状态下屏幕上运行状态只出现一处。
- 失败 / 已停止 / 离线 / 历史失败仍可见且可操作。
- 现有 XCTest（工具展开、离线禁发、草稿保留）仍通过。

## 实现与验证回执（2026-10-13）

- 已实现方向 A，成品待用户验收：`Components.swift` 共享气泡、回合异常与底部状态条；`ChatView` / `SessionTranscriptView` / `SessionRunStatusView` 删除重复运行状态。正常完成静默，等待开始不冒充执行。
- 失败、停止、结束但无输出及截断保留回合提示。实时缓存仍标明可能不完整；停止失败保留二次确认后的重试入口；只读条合并历史失败提示。未知错误文本完整换行，不用省略号掩盖原因。
- 本轮独立评审指出上述四个边界问题，已修复；用户气泡及行间距进一步统一。未改传输合同、权限、草稿键或附件限制。
- 最终版本模拟器渲染：iPhone 17 / iOS 26.5，Xcode 26.6。见 [运行中](implementation-running.png)、[历史读取失败](implementation-history-warning.png)。另核对 Mac 运行停止失败后底部仍有“停止”入口。均为 DEBUG fixture，不代表真实 Mac/Provider 链路通过。
- `xcodebuild build-for-testing` 通过，包含 App 和 UI 测试目标；App 内 `-selfTest` 69 项通过，其中新增 13 项状态/异常检查。未签名模拟器 Keychain 检查明确跳过。
- 反向验证：临时撤回“settled + 空输出”提示修复，`run.outcome.settledMissingOutput` 确实失败（`failures=1`）；恢复修复后 69 项通过（`failures=0`）。
- 新增 XCTest：手机/Mac 同一状态条、停止二次确认、停止失败重试、问题 sheet 重开、失败回合和长按缺失用量；更新离线提示断言。**只验证编译，尚未验证运行**：首次测试因 `DTServiceHubClient failed to bless service hub` 导致 runner 连接挂起；独立新模拟器复现同一错误，终止等待，未放宽断言或超时。
- 尚未验收：真实 iPhone + Mac 联动，长按菜单、问题 sheet 重开、草稿与工具展开的当前版本坐标交互，以及只读历史失败的实际交互。需恢复 Xcode 测试服务或在真机重放。
- Mac 历史仍不提供附件、用量和 lifecycle；本次未擅自扩展 `RunHistoryTurn`，不能承诺补齐这些数据。
- 日志保留在 `/tmp/scry-transcript-{build-final,selftest-final,control-selftest,test-isolated}.log`；测试模拟器仅本次创建，验证后删除。
- 设计库：本条沿用 `D-20261013-scry-ios-transcript`，不重复注册。全库仍有 5 个不属于本次的缺失来源：`P-PI-MODEL-SELECTOR`、`D-20260912-scry-ios-remote`、`D-20261008-scry-ios-continuity`、`P-SCRY-SESSION-HISTORY`、`D-20261010-scry-llm-sidebar`；未删除旧条目来凑通过。
