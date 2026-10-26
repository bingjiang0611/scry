# R6e 收尾：只修流式旧文本

**用户 2026-10-26 决定收尾：本批只做第 1 部分，第 2 部分取消。** AX3 下 A / C 空白记为已知问题，见 [FINAL.md](FINAL.md)。

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

## 第 2 部分：取消

用户决定收尾，不做 iOS 18 可见行观测和纠正。不要改 `ConversationScrollView`。

## 不要做

R6 到 R6d 的禁止项全部有效（延时、重试、假高度、强制 `.id()` 重建、`LazyVStack` 改 `VStack`、嵌套 lazy、`scrollPosition(id:)`）。

## 验收与报告

- 第 1 部分：新检查及负对照、`markdown-blocks.py`、`tool-groups.py`、流式真机截图组（`r6e-stream-*`）。
- `apps/ios/docs/conversation.md` 按最终行为更新（流式尾行、令牌）。
- 报告写 `reports/R6e.md`。STATUS 的 R6 行改「已提交（部分：AX3 A/C 已知问题）」。用 bingjiang0611 的 noreply 身份提交并 push。
