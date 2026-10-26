# R6c 阅读区：行粒度假设（先测量，不成立就停）

**用户 2026-10-26 已确认继续。** 分支 `design/ios-redesign`，基于 `84cb5556`。授权范围同 R6。先读 [reports/R6.md](reports/R6.md) 全文，尤其是末尾 R6b 的核验意见。

## 假设

前三条路线都在改「怎么滚」。R6c 改「被滚的东西」：现在一条 Markdown 回复是 LazyVStack 里的**一行**，长回复可能有几万 pt 高。lazy 栈拿已布局行的高度去估未布局的行，一个巨大的行会让估算整体失真，于是不管用哪种方式滚到「底部」，落点都可能是空的。

## 第 0 步：测量（只测不改，不过就停）

DEBUG 下临时加只读测量，不提交。对 A、B、C 三个失败现场各记录一次：

- 顶层行数；每行实际高度（`onGeometryChange` 读每个 `ConversationTurnRow` 的高度），给出最大行高、中位数，以及最大行高 / 视口高的比值；
- 空白时视口范围内**应该**出现的是哪一行（按 id），这一行是否已经实例化。

**判定：**

- A、B、C 中至少两项满足「空白时视口落在某个高度 > 2 倍视口的行里，或这类行正处在估算区」→ 假设成立，进入第 1 步。
- 否则假设不成立：写报告（数据表 + 结论），**不要改任何生产代码**，停。

## 第 1 步：把长回复拆成块级行（仍是一层 lazy）

- 在 `ConversationTurn.rows(id:)` 把 `output` / 归档正文条目按 `ConversationMarkdownParser` 的块拆成多行。每个 Markdown 块（段落、标题、列表、代码块、表格）一行，id = 轮次 id + 条目 id + 块序号。行仍然由页面级的那一个 LazyVStack 直接持有，**不嵌套 lazy**（README 的约束不变）。
- 解析结果按 `source` 缓存，不要在 body 里重复 `parse`（可以放在 `rows(id:)` 里做一次，或用有上限的缓存；缓存键要包含完整 source）。
- 视觉保持不变：块间距 12、左侧竖线连续、who 行和页脚位置不变。竖线现在是每行各画一段，要确认块与块之间不断开。
- 流式输出时，只有最后一块的内容在变，前面的块 id 稳定，不能整轮重建。
- 推理（reasoning）、工具组不拆。
- 长按「本轮详情」、文本选择在拆行后仍然可用。跨块选择做不到时写进报告。
- `ConversationScrollView` **先不改**，用原实现重测 A/B/C。只有拆行后仍有一项失败、且测量显示行高已正常，才允许在这里做最小调整，并说明依据。

## 不要做

- R6、R6b 的禁止项全部有效：延时、重试、假高度、强制 `.id()` 重建、`LazyVStack` 改 `VStack`、嵌套 lazy、`scrollPosition(id:)`。
- 不改 Markdown 解析规则、`markdown-blocks.py` 的期望，不改 `RemoteRunStore`。

## 验收

- 第 0 步的测量表（不论成立与否都要有）。
- 进入第 1 步时：R6.md 验收一节全部（默认字号与 AX3，减少动态效果重复 A–C）。另外：`markdown-blocks.py`、`tool-groups.py` 通过；表格横向滚动、代码块、长回复截断提示与「本轮详情」真机可用；`npm run performance:measure`（跑不出写 unavailable）。长回复拆行后的滚动是否更顺不做毫秒宣称。
- 修好了就更新 `apps/ios/README.md`「Conversation positioning and freshness」与「每条消息完整布局」那句（改成块级行）。修不好就回退，README 不动。
- 截图放 `reports/R6/`（r6c- 前缀）；报告追加到 `reports/R6.md` 的「R6c」一节。成功时 STATUS 的 R6 行改「已提交」，失败保持「需修改」；push。
