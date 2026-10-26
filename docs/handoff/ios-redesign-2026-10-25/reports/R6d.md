# R6d 阅读区：拆行副作用修正与 AX3 测量

分支 `design/ios-redesign`，基线 `a312420c`。提交：`9bf227a2` 只搬文档（README 拆分），`6e12e3b5` 后台拆行 + 本节验收用的真机截图。
结论先行：**第 1 部分完成并通过验证；第 2 部分查出了「不是越界 offset」的结论，但无法指认到可修的应用层事件，按 R6d 规则不改代码。A/C 在 AX3 仍失败，STATUS R6 保持「需修改」。**

## 1. 第 1 部分：拆行的三个修正

### 1.1 解析改到后台，解析完成前保持原单行

- 新增 `ConversationMarkdownParser.BlockCache`：键是「轮次 id + 条目序号」，版本是**完整原文**；容量双上限 **64 条 / 2,000,000 字符**（UTF-16 约 4 MB），超出按最旧先丢。依据：一条 10,865 字符的归档正文实测解析耗时 4.5 ms，60 条同规模正文已远超一屏可读内容；2M 字符上限让最坏内存占用可算（≈4 MB），而不是随会话历史增长。
- 新增 `ConversationMarkdownSplitter`：候选是 kind 为 Markdown 且超过 600 字符的条目；`ready()` 只读命中，`parse()` 走既有 `@concurrent parseForReading`，`Task.isCancelled` 后不写缓存。
- 新增 `ConversationSplitBlocks`（共用的后台驱动）：先把缓存命中一次性 publish，再逐条解析并逐条 publish。因此**已拆好的前缀条目 id 与视图保持稳定，只有真正变化的那条先从块行退回单行、解析完成后再换回块行**。
- `ConversationTurn` 增加 `splitBlocks` / `withSplitBlocks` / `splitCandidates`；`rows(id:)` 只在 `splitBlocks[entryIndex]` 存在时输出块行，否则输出原来那一行。`ChatView` 与 `SessionTranscriptView` 各持一份页面级 `@State`，由 `.task(id: splitRevision)` 驱动，`splitRevision` 只用计数/版本号，**不包含正文**。
- 归档走同一个驱动：`historyBody(split:)` 接收字典，历史条目 key 是 `history-<序号>`。

body 侧现在只剩一次字典查找：不哈希、不比较、不解析整段正文。

### 1.2 README 拆分（提交 `9bf227a2`）

`apps/ios/README.md` 已有 22,271 字节，超过仓库 20 KB 单文件门禁，任何编辑都会被 pre-commit 拒绝。本轮把三段与会话阅读直接相关的段落**原文**搬到 `apps/ios/docs/conversation.md`：

- `Conversation positioning and freshness: …`
- `Markdown tables: …`
- `Visual verification (2026-09-15): …`（会话截图证据）

逐字证明（提交前脚本）：三段在新文件各出现 **1** 次、在 README 中 **0** 次，且 README 只少了这三行、其余行逐行不变。README 从 22,271 → 19,923 字节，留一行链接。

随后在新文件里重写定位一节，按拆行后的真实行为描述：长正文按块成行、后台解析、解析完成前整行显示、缓存键与上限、流式只重解析变化的那条、取消不发结果。

### 1.3 主线程解析耗时（B fixture，10,865 字符的归档正文）

| 版本 | 首次 | 之后每次 body 求值 | 线程 |
|---|---|---|---|
| 改前 `a312420c` | **4.68 ms** | **0.20 ms**（每次仍需按完整正文取缓存） | 主线程 |
| 改后 | 4.51 ms（同一函数，移出主 actor） | 0（body 只查字典） | 后台 |

测量方式：临时 `CFAbsoluteTimeGetCurrent` 探针（已删除，未提交），同一台真机、同一 fixture，串行执行；设备为 iPhone 13 / iOS 26.5.2，负载为常规（无并发测量）。这是 L1 级计数（单次解析毫秒数），**不是** L2/L3 结论。

`npm run performance:measure`：`remote.loopback` 仍无可用计数器采集，记 **unavailable**。

## 2. 第 2 部分：AX3 下 A / C 的测量

DEBUG 只读探针（`Sheets/ScrollProbe.swift`，已删除、未提交）：窗口层级里找出所有 `UIScrollView`，读 `contentSize` / `contentOffset` / `adjustedContentInset` / `bounds`，与 SwiftUI 的 `onPreferenceChange` 读数并排打印；时间点为打开后 1.5 s、4 s，以及 `contentSize`、`contentOffset`、`adjustedContentInset`、键盘显示/隐藏变化时。

| 场景 | SwiftUI preference（尾标记 maxY） | UIKit contentSize | offset | bounds | adjustedInset | maxOffset | offset − maxOffset |
|---|---|---|---|---|---|---|---|
| C 归档 AX3（失败） | **infinity** | 3342.0 | 2943.33 | 388.33 | (0, 0) | 2953.67 | **−10.33** |
| C 归档 默认字号（通过） | 1100.83 → 551.88 → **562.07** | 1877.0 | 1304.67 | 562.0 | (0, 0) | 1315.0 | **−10.33** |
| A 实时长回复 AX3（失败） | 150.44 → 377.44 → **infinity** | 未取到（探针 attach 时该视图层级不存在） | — | 388.33 | — | — | — |

三个问题的回答：

1. **真实可滚动范围是否小于报告的内容高度？** 否。两个场景的 `offset` 都在 `[−inset.top, maxOffset]` 之内（`over = −10.33`，恰好差一屏底部约 10 pt），`contentSize` 也没有小于 `bounds`。失败不是「offset 越界」。
2. **越界 offset 出现在哪个事件之后？** 没有观察到越界 offset，因此无法归到某个事件。失败场景唯一稳定的差别是：**尾标记的 SwiftUI preference 变成 infinity**，即那个视图在访问树里没有布局出来（`ScrollProbe` 放在内容里时同样从不 attach，与之一致）；而通过场景的 preference 最终收敛到 `viewport − 0.9`。
3. **视口高度变化时 offset 是否被夹回合法范围？** 是。`bounds`/`adjustedContentInset` 变化后 `maxOffset` 被重算，`offset` 始终没有超过它（两个场景都停在 `maxOffset − 10.33`）。夹回机制本身没有失效。

**机制判定：** 可观测到的事实是「内容高度是估算值，而视口落在尚未实体化的行区间内」——`contentSize`（3342）大于实际已布局内容，`offset` 停在估算底部附近，但该区间的行从未被创建（因此 preference 为 infinity）。SwiftUI `LazyVStack` 内部如何决定「哪些行实体化」不可观测，**无法指认到具体应用层事件**。按规定：**本部分不改代码**，只留测量表；R6/R6b/R6c 的禁止项（延时、重试、伪造高度、强制 `.id()`、改回整屏 `VStack`、嵌套 lazy、`scrollPosition(id:)`）一条也没有用作「修复」。

已排除的一条：C 的内容只有 1863–3342 pt、最大单行 793 pt，拆行粒度不是成因；R5 已用单变量对照证明触发条件是 Composer 让视口从 399 降到 388.33。

## 3. 验收

| 项目 | 结果 | 证据 |
|---|---|---|
| B 归档（默认字号） | **通过** | `regress2.py b default`，尾行 y=…，视口内 |
| B 归档（AX3） | **通过** | 尾标题 y=476.2，视口 174.3–562.7 |
| A 实时长回复（默认字号） | **通过** | 发送后回复与尾标记都在视口内，`回到最新` 消失 |
| A 实时长回复（AX3） | **失败（与 R6c 相同）** | 回复不在访问树，视口空白 |
| C 归档 Chat（默认字号） | **通过** | `regress2.py c default` |
| C 归档 Chat（AX3） | **失败（与 R6c 相同）** | `r6d-c-transcript-ax3.png` |
| 流式 30 秒不跳不重建 | **通过** | 每 5 s 采样 6 次，回复与尾标记始终在树中，行数稳定 55（首样本 52） |
| `markdown-blocks.py` | 17/17 通过 | 解析与条目身份回归 |
| `tool-groups.py` | 12/12 通过 | 工具分组计数/截断回归 |
| Reduce Motion 的 A–C | **未做** | A/C 在 AX3 未通过，按 R6d 不宣称 |
| `ReaderPositionUITests` | **未运行** | 免费签名名额上限（3 个 App 已满），exit 65，执行 0 个用例 |

截图（`reports/R6/`，全部为 Mock 数据）：

- `r6d-B-default.png`、`r6d-B-ax3.png`：B 归档落在末尾。
- `r6d-A-default.png`：A 发送后仍在末尾。
- `r6d-C-transcript-default.png`：C 通过。
- `r6d-c-transcript-ax3.png`：C 在 AX3 仍空白（失败证据，故意保留）。
- `r6d-streaming-30s-default.png`：流式 30 秒后的末尾。

## 4. 未验证 / 限制

- A、C 在 AX3 仍失败；成因已缩小到「lazy 估算高度 + 未实体化区间」，但无法指认可修的应用层事件，本轮不改代码。
- 探针在 A AX3 场景没能 attach 到 `UIScrollView`（该行从未布局），所以 A 只有 SwiftUI 侧读数；C 的两档有完整对照。
- 拆行后每块是独立可选文本，跨块选择做不到（R6c 已写明）。
- 表格横向滚动、代码块、「本轮详情」未单独复测。
- XCTest UI 用例仍未执行（签名名额），不把编译通过当运行通过。

## 5. 状态

- STATUS 的 R6 行保持「需修改」：A/C 在 AX3 未通过。
- 代码保留后台拆行（有实测收益，且 B 两档保持通过）；`ConversationScrollView.swift` 与 R6c 相同，未改定位策略。
- 下一步（需设计方决定）：若要继续，应先证明「LazyVStack 的估算高度与实际实体化行的差」是否可用公开 API 观测（例如 `scrollTargetLayout` + `onScrollTargetVisibilityChange`，只在 iOS 18+ 使用），否则只能接受当前限制或改回更保守的行粒度。

## 核验意见（核验方，2026-10-26，R6d `6e12e3b5` / `cc2c8f4c`）

结论：**需修改**。第 1 部分有一个正确性问题必须先修；第 2 部分的提议批准，见 [R6e.md](../R6e.md)。

确认的部分：

- 解析已移出主线程。缓存的双重上限（条数 / 字数）、版本按完整原文校验、取消后不发布，都已核对。
- README 搬移单独提交、README 降到 19923 字节；`SessionTranscriptView` 拆分是为了过门禁，接受。
- 第 2 部分的测量很有价值：C 在 AX3 下 offset 在合法范围内，排除了「越界」假设。剩下的现象是：估算的内容高度里包含了没实例化的行，视口落在估算区，那里没有真实行。

**必须修的问题：流式回复会显示旧文本。**

- `RemoteRunStore.coalesce` 把连续的 `output` 分块拼进**最后一行**：`output.count` 不变，只换 `id`（新 seq）和 `text`。
- `ChatView.splitRevision` 只看 `output.count`，所以流式追加文字时后台任务不会重跑。
- `ConversationTurn.rows(id:)` 用 `split[entryIndex]` 时没有核对版本。结果是一条已经拆过的长回复，在流式期间会**一直显示拆分那一刻的旧内容**，新流入的文字看不到，直到出现新的分块类型或 lifecycle 变化。这违反「证据不能说谎」。报告里的「流式 30 秒行数稳定 55」恰好可能就是这个现象。
- `SessionTranscriptView` 的 live / detached 输出同样要查。
