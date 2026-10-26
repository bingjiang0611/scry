# R6e 阅读区：修流式旧文本 + iOS 18 可见行观测

分支 `design/ios-redesign`，基于 `cc2c8f4c`。授权范围同 R6。先读 [reports/R6d.md](reports/R6d.md) 末尾核验意见。

## 第 1 部分：流式不能显示旧文本（必须先做，单独提交）

1. **版本令牌。** 每个拆分结果记录它解析时对应的廉价版本令牌：该条目最后一个 `OutputLine.id`（coalesce 时会换成新 seq），加 `text.utf16.count`。归档条目用 `historyRevision` 加条目序号。`rows(id:)` 只在令牌与当前条目一致时使用拆分结果，比较是 O(1)，不比较全文。
2. **任务一定会重跑。** 两个页面的 `splitRevision` 要包含能反映文本变化的量（例如 `run.output.last?.id`、detached 输出的最后 id）。任何可见文本变化都必须让它变化。
3. **流式时不来回翻。** 流式条目是只追加的，不能每来一个分块就在「整行」和「拆分行」之间切换（那会把巨大单行又带回来）。要求：
   - 已解析的前缀块（除最后一块）继续作为稳定行显示；
   - 「最后一块的起点到当前文本末尾」作为一个尾行，直接用 `ConversationMarkdownText(source:)` 渲染（这一段短，解析开销小）；
   - 后台解析完成后，尾行再拆开。
   - 为此解析器需要给块记录源文本起点（偏移），`markdown-blocks.py` 的期望不能变。
   - 如果文本**不是**前缀追加（被替换或变短），就丢掉拆分，退回单行。
4. **检查（负对照）。** 在 Checks 里加一个只读检查，模拟 coalesce：同一行、count 不变、文本变长。断言：
   - 显示的拆分行文本拼起来等于当前全文；
   - 令牌不匹配时不用旧拆分；
   - 前缀块 id 不变。
   负对照：拿掉令牌比较后，检查要失败。
5. **真机。** `-uiMockMacRun` 或长流式 mock，观察 30 秒。每 5 秒截一次末尾：末尾文字必须在增长，并且和 mock 源一致。B 两档、A / C 默认字号保持通过。

## 第 2 部分：iOS 18 可见行观测，然后决定是否纠正

批准执行方提出的方向，只在 `if #available(iOS 18, *)`：

- **探针（DEBUG，只读）。** 在页面级 `LazyVStack` 加 `scrollTargetLayout()`，用 `onScrollTargetVisibilityChange(idType:threshold:)` 记录可见的行 id，和 `onScrollGeometryChange` 的读数并排。在 AX3 的 A、C 现场回答：空白时可见行集合是否为空？最后一个真实行的 id 是什么？空白在哪个事件之后出现？
- **纠正**（只有探针证明「跟随中 + 可见行集合为空，或不含最后一行」就是失败签名时才做）：
  - 在**这个事件**发生时，用 `proxy.scrollTo(最后一行 id, anchor: .bottom)` 纠正**一次**。
  - 触发来自可见性回调本身，不是轮询，也不是定时。
  - 同一次打开 / 同一次发送最多纠正一次，用一个计数器保证，并在报告里写明。
  - 不用 `scrollPosition(id:)` 绑定（R6 挂死的路线）。
  - `scrollTargetLayout` 加上后，iOS 18 下的 `ConversationScrollView` 行为要和 iOS 17 一样，iOS 17 不变。
- **防挂死门槛。** 加了纠正就重跑 R6b 的 200 次「输入 → 收键盘 → 上滑 → 下滑」，出现一次无响应就回退纠正，只留第 1 部分。
- **判定。** 探针不支持这个失败签名，就只写测量表，不加纠正，停。

## 不要做

R6 到 R6d 的禁止项全部有效（延时、重试、假高度、强制 `.id()` 重建、`LazyVStack` 改 `VStack`、嵌套 lazy、`scrollPosition(id:)`）。

## 验收与报告

- 第 1 部分：新检查及负对照、`markdown-blocks.py`、`tool-groups.py`、流式真机截图组（`r6e-stream-*`）。
- 第 2 部分：探针表；加了纠正时，附 R6 验收一节的回归（默认字号与 AX3，减少动态效果重复 A–C）和 200 次门槛结果。
- `apps/ios/docs/conversation.md` 按最终行为更新（流式尾行、令牌）。
- 报告写 `reports/R6e.md`。A/B/C 全过才把 STATUS 的 R6 行改「已提交」。用 bingjiang0611 的 noreply 身份提交并 push。
