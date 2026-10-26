# R6d 阅读区：收拾拆行的副作用 + 查 AX3 的 A/C

分支 `design/ios-redesign`，基于 `a312420c`。用户已授权的范围同 R6（可以改阅读区滚动 / 跟随与行结构，不改数据、协议、`RemoteRunStore`）。先读 [reports/R6.md](reports/R6.md) 末尾 R6c 的核验意见。

## 第 1 部分：拆行的三个修正（必须做）

1. **解析不在主线程同步做。**
   - 长正文的块解析要在后台完成（沿用 `parseForReading` 的 `@concurrent` 方式），由页面级状态持有结果。
   - 结果没回来之前，这条正文按原来的单行显示：归档用 `HistoryChunkView` 原样，live 用原 `ConversationChunk`。结果回来后再换成块级行，切换只发生一次。
   - live 流式时只有最后一条在变：已拆好的前缀块保持 id 和视图稳定，只重新解析变化的那一条。重新解析也在后台做，并按版本丢弃过期结果。
2. **渲染开销与文字总量脱钩。** body 求值时不能对完整正文做哈希、比较或解析。缓存按「条目身份 + 版本」取，版本必须完全决定内容，不能只用长度。上限改成按总字数（例如 ≤ 200 万字符）加条数双重限制，并写明数值依据。
3. **README 拆分。**
   - 把 `apps/ios/README.md` 中与会话阅读相关的章节（定位 / 新鲜度、Markdown、表格等）**原文搬到** `apps/ios/docs/conversation.md`，README 留一行链接。搬移用脚本证明逐字一致，单独提交。
   - 然后在新文件里改写定位一节和「每条消息完整布局」那句，按拆行后的真实行为写，包括「长正文按块成行、后台解析、解析完成前整行显示」。

测量：用 `PerformanceTrace` 或 signpost 记录 B fixture 打开时主线程上与解析相关的耗时，改前（`a312420c`）、改后各一次。毫秒数注明设备负载，不宣称 L2 以上的结论。`npm run performance:measure` 跑不出来就写 unavailable。

## 第 2 部分：AX3 下 A / C 的调查（先测量）

R6c 的现象：offset 越过真实内容，视口里没有行；向下滑仍空，上滑一次才出现。执行方提出的下一步可行，按这个做：

- DEBUG 临时只读探针（不提交），从底层 `UIScrollView` 同时读 `contentSize`、`contentOffset`、`adjustedContentInset`、`bounds`。和 SwiftUI `onScrollGeometryChange` 的读数并排记录。
- 时间点：打开页面时、Composer 由一行变两行时、键盘弹起 / 收起时、发送被接受时。
- 要回答三个问题：
  1. 真实可滚动范围是否小于报告的内容高度？
  2. 越界 offset 是在哪个事件之后出现的？
  3. 视口高度变化（Composer 高度、键盘、safe area）时，offset 是否被重新夹回合法范围？
- 判定：
  - 能指认出具体事件和机制，就做**最小修复**。只能用一处、不靠延时 / 重试 / 强制重建。修复前后用同一组探针读数对照，再回归 A/B/C 两档字号。
  - 指认不出，就只写测量表和卡点，**不改代码**，停。

## 不要做

- R6 / R6b / R6c 的禁止项全部有效。
- 第 1 部分不能让 B 退回失败。每个提交后都在 AX3 重测 B。

## 验收与报告

- 第 1 部分：B（两档）、A 默认字号保持通过；`markdown-blocks.py`、`tool-groups.py` 通过；流式长回复真机观察 30 秒，不跳、不闪、不重建前缀块；README 搬移的逐字证明。
- 第 2 部分：测量表 + 结论；修了就附 R6 验收一节的回归结果（默认字号与 AX3，减少动态效果重复 A–C）。
- 报告追加 `reports/R6.md` 的「R6d」一节，超过 20KB 时按已有做法拆文件。截图用 `r6d-` 前缀。A/B/C 全过才把 STATUS 的 R6 行改「已提交」，否则保持「需修改」。用 bingjiang0611 的 noreply 身份提交并 push。
