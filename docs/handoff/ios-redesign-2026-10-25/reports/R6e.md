# R6e 收尾：流式不再显示旧文本

分支 `design/ios-redesign`，基线 `cc2c8f4c`。用户决定本批只做第 1 部分，AX3 下 A/C 空白按 [FINAL.md](../FINAL.md) 记为已知问题。

## 1. 问题与修法

`RemoteRunStore.coalesce` 把连续的 `output` 分块拼进**最后一行**：`output.count` 不变，只换 `id`（新 seq）和更长的 `text`。R6d 的 `splitRevision` 只看 `output.count`，所以流式追加时后台任务不重跑；`rows(id:)` 也不核对版本，结果是一条已拆分的长回复在流式期间一直显示**拆分那一刻的旧内容**。

改动：

1. **版本令牌。** `ConversationTurn.splitToken(lineID:text:)` = 条目最后一行的 id + 该条目的 UTF-16 长度；归档条目沿用页面 revision 与条目序号构成的 turn id。比较是 O(1)（id 是整数，长度只算一次）。
2. **`splitRevision` 随文本变化。** `ChatView` 加入 `run.output.last?.id`；`SessionTranscriptView` 同时加入 `run.output.last?.id` 与 `run.detachedOutput.last?.id`。coalesce 每次都给最后一行新 seq，所以每个分块都会让任务重跑。
3. **流式不来回翻。** 解析器给每个块记录源文本起点（UTF-16 offset，`ConversationMarkdownBlock.start`）。渲染规则集中在一个纯函数 `ConversationSplitPlan.render(source:token:)`：
   - 令牌一致 → 用完整拆分（块行）；
   - 令牌不一致但当前文本更长且无 CRLF → **已解析的前缀块保持稳定**，并把「最后一块起点到当前末尾」作为一条尾行，文字取自**当前**文本，用 `ConversationMarkdownText(source:)` 渲染；
   - 文本被替换或变短 → 退回单行，等新解析。
   因为尾行永远从当前文本切片，append-only 的分块**不可能**把旧文本留在屏幕上，也不会退化成一条巨大的单行。
4. **检查与负对照。** `apps/ios/Checks/split-versioning.py` 编译真实的 `ConversationSplitPlan.render` 与 `ConversationTurn.splitToken`，模拟 coalesce（同一行、count 不变、文本变长）：5 项断言全过——令牌一致用拆分；令牌不一致时前缀块 id 不变（`[0]`）、显示文本等于当前全文、尾行含新流入文字；文本被替换则退回单行；令牌随文本变化。负对照：把 `if token == currentToken` 删掉后，检查输出 `FAIL stale plan did not fall back to prefix + tail`，exit 1。

## 2. 真机

流式观察需要一个「同一行持续增长」的 DEBUG 夹具：通过**真实的** `RemoteRunStore.coalesce` 每 0.7 s 追加一段到同一 `OutputLine`，40 段封顶，mockMode 下不触达任何 Provider。

**该夹具不能提交**：它必须写在 `RemoteRunStore.swift` 里（`output` / `lifecycle` / `prompt` 是 `private(set)`，`mockMode` 是 `private`，扩展文件改不了），而该文件已有 282 KB，超过仓库 20 KB 单文件门禁且既有大文件不放行。所以截图来自「已提交源码 + 本地临时夹具」的构建，夹具内容如下，可原样复现：

```swift
if ProcessInfo.processInfo.arguments.contains("-uiMockStreamGrowth") {
  prompt = "流式增长检查"
  output = [.init(id: 1, kind: "output", text: "第0段仍在增长。")]
  lifecycle = .running
  Task { @MainActor [weak self] in
    for step in 1...40 {
      try? await Task.sleep(nanoseconds: 700_000_000)
      guard let self, self.mockMode, self.lifecycle == .running else { return }
      let json = #"{"seq":\#(step + 1),"at":0,"runId":"mock-stream-growth","kind":"output","text":"第\#(step)段仍在增长。"}"#
      let chunk = try! JSONDecoder().decode(G0Transport.RunOutputChunk.self, from: Data(json.utf8))
      Self.coalesce(chunk, into: &self.output)
    }
  }
}
```

这属于需要决定的事项：拆 `RemoteRunStore`，或接受该夹具只存在于本地。

- 流式 30 秒，每 5 秒读一次页面并截图，可见的最高段号：**3 → 11 → 19 → 27 → 35 → 40**（5 s、10 s、15 s、20 s、25 s、30 s）。末尾文字在增长，且与 mock 源（「第 N 段仍在增长。」逐段追加）一致；没有出现旧的截断内容。
- 截图：`reports/R6/r6e-stream-00s.png` … `r6e-stream-25s.png`（6 张，Mock 数据）。

回归（真机，同一构建）：

| 场景 | 结果 |
|---|---|
| B 归档 默认字号 / AX3 | 通过 |
| A 长实时回复 默认字号 | 通过 |
| C 归档 Chat 默认字号 | 通过 |
| A / C AX3 | **仍失败**（已知问题，本轮不做，见 FINAL.md） |

## 3. 检查

| 命令 | 结果 |
|---|---|
| `python3 apps/ios/Checks/split-versioning.py` | 5 项通过 |
| 同上，`--source` 指向去掉令牌比较的副本 | **FAIL**（exit 1，负对照成立） |
| `markdown-blocks.py` | 17 项通过（解析与块身份未变） |
| `tool-groups.py` | 12 项通过 |
| Xcode `build-for-testing`（提交源码，无夹具） | **TEST BUILD SUCCEEDED** |
| `ReaderPositionUITests` | 未运行（免费签名名额 3/3，exit 65，执行 0 个；与 R6d 相同） |

## 4. 副作用与限制

- 为过 20 KB 单文件门禁，按职责移动了视图代码：`ConversationMarkdownText`、`conversationFlowBlock()`、`TurnUserBubble`、`TurnOutcomeNote` 移到 `Components.swift`；`ConversationMarkdownInline` / `ConversationMarkdownTableView` 由 `private` 改为模块内可见（被移动的视图引用）。行为未改。
- 尾行的 offset 以 CRLF 归一化后的文本计算；源码含 `\r\n` 时不走尾行路径（退单行等新解析），流式模型输出不含 CRLF，所以真实流式路径覆盖完整。
- 若文本被**替换**成更长内容，令牌不一致的那一帧可能短暂显示「旧前缀 + 新尾行」，下一个任务跳转即修正；append-only 的增长不存在这个问题。
- AX3 的 A/C 仍空白，按用户决定不再修，未用任何禁止手段。
- `performance:measure` 未跑（本轮无热路径计数变化；`remote.loopback` 采集器仍 unavailable）。

## 5. 状态

- STATUS 的 R6 行改为「已提交（部分：AX3 A/C 已知问题）」。
- 生产代码只改阅读区的拆分/版本令牌与视图文件归属；`ConversationScrollView.swift` 未改。
