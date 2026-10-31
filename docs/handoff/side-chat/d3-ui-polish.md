# D3 · 两处 UI 正确性收尾

状态：源码 0.2.227，功能 WIP 未提交、未推送、未升版本、未安装（日常实例仍是 0.2.229）。本文件只记录 D3 这两处
UI 问题的实际结果；整体交付状态仍以 [implementation-report.md](implementation-report.md) 与
[continuation-checkpoint.md](continuation-checkpoint.md) 为准，`implementation-report.md` 已达 20,000B 手写文件门限，
因此本轮记录单独成文。

## 1. 未决发送的原文只能“保存”、不能查看（阻塞）

**问题**：发送结果未确认时，原文与图片已经搬进持久回执，输入框清空，但回执只显示一句说明和「核对状态」按钮。
用户看不到自己提交了什么——`drafts-restored-receipt.png` 里就是空输入框加一句“原文与图片已保留”。批准“把提交内容
移出输入框”的前提是原文和图片**可访问**，而不是只存在于 `localStorage`。

**修复**：在共享 `ConversationViewBody` 的回执层加一个只读查看入口（`查看原文与图片`），打开真实模态
`PendingSubmissionDialog`：

- 原文用 `<pre>` 逐字显示，不走 Markdown、不解析斜杠命令，因此表情、`*`、换行都保持提交时的样子。
- 图片用现有 `.user-attachment` 缩略图，点击打开产品既有的 `ImageLightbox`（名称、像素尺寸、缩放盘），
  没有第二套图片查看器。
- 回执只读：只有一个关闭按钮，没有发送/重发；`not_sent` 与 `unresolved` 的区别仍由持久回执决定，
  `unknown`/缺失记录永远不会出现重发入口。
- 回执读的是 `pending` 快照本身，与旁边可编辑的新草稿完全分离，所以编辑新草稿不会改动提交的那一份。
- 模态用 `ModalFrame`（焦点锁、Escape、焦点归还），尺寸 `min(560px, 92vw)` × `min(76dvh, 640px)`，
  正文区自己滚动，不把面板内联撑开。

同时修正首条消息的空态：原来无论发送是否未决都显示“这是刚创建的侧边会话……发送第一条问题后才会开始它自己的记录”，
与下方回执自相矛盾。现在未决首条发送显示 `data-status="pending-first-send"`（「首条消息的发送结果还没有确认」），
只有真正没有未决发送的新侧聊才用 `new-side-chat`。

**App 内证据**（真实重启后，`$TMPDIR/scry-app-driver-DVGk5b/verification.json` 的 `drafts.content`）：

| 断言 | 实测 |
| --- | --- |
| 回执按钮 | `["查看原文与图片", "核对状态"]`，无「重新发送」 |
| 原文逐字 | `side chat pending 待核对原文🙂🀄️ *原样显示*`（含表情与 `*`，说明没经过 Markdown） |
| 图片 | `side-chat-pending.png`，`img.complete && naturalWidth > 0` |
| 图片预览 | 点击后 `.image-lightbox-name` = `side-chat-pending.png`，`naturalWidth` = 96（既有预览组件） |
| Escape / 焦点 | 关灯箱回回执；再 Escape 关闭回执并回到打开它的按钮（`focusReturned: true`） |
| 关闭后草稿 | 新草稿文字与新附件都在（`side-chat-newer.png` 仍在），命令身份不变（同一 `pendingCommandId`，`phase` 仍 `unknown`） |
| 未决首条空态 | `pending-first-send` 文案存在，`new-side-chat` 为空 |
| 核对不重发 | 点「核对状态」只多一次 `conversation:read`，`inputs()` 里没有该原文，轮次数仍 0 |

截图：`drafts-pending-content.png`（1600×? 正常窗口）、`drafts-pending-content-narrow.png`（真实 `setContentSize`
860×600：模态完整在视口内、关闭可点到、正文无横向溢出）、`drafts-pending-image-preview.png`、
`drafts-restored-receipt.png`。

## 2. 侧栏孤儿侧聊标题被元数据挤成一个字（可用性）

**问题**：`SideChatOrphanGroup` 的行把「主会话快照 · 截至第 N 轮」放在与标题同一 flex/grid 行；元数据是长句，
标题只剩一个字（`layout-wide-window.png` 里每行都是「侧」）。

**修复**：只在 `.sb-orphan-group .sb-sess` 上按侧栏既有形态改成两行——标题独占第一行、元数据退到第二行并保持
次要与省略号，行高自适应；分页与来源分组键不变，其他侧栏行不受影响。

**App 内证据**（`verification.json` 的 `orphan.orphan.rowLayout`，真实侧栏 DOM 量测）：

| 行 | 标题 | 标题宽度 | 截断 | 元数据在下方 | 行高 | 行/组横向溢出 |
| --- | --- | --- | --- | --- | --- | --- |
| 中等真实名 `核对快照边界` | 同名 | 141px | 否 | 是 | 42px | 0 / 0 |
| 默认名 `侧边会话` | 同名 | 141px | 否 | 是 | 42px | 0 / 0 |

截图：`orphan-sidebar-row-title.png`。原有的 20 行/页、21 个来源分页、来源分组键、打开后主视图、点选仍全部通过。

## 3. 本轮跑过的检查

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/renderer/components/PendingSubmissionDialog.test.tsx src/renderer/components/render.test.tsx src/renderer/side-chat-surface.test.tsx src/renderer/composer-pending.test.ts src/renderer/conversation-view-restore.test.ts` | 5 files / 284 tests 通过 |
| `npm run typecheck` | 通过（node + web） |
| `npm run test:side-chat:ui`（build + 快照夹具 + 竞态夹具 + `--dev-side-chat-only`） | 退出码 0，全部步骤通过 |
| `npm test`（`test:unit` + `test:shell`） | 446 files / 4651 tests 通过，4 skipped（原有 P0/P1/BILLING/性能相关性跳过），shell `PASS setup-scry-workspace` |

新增聚焦回归：`src/renderer/components/PendingSubmissionDialog.test.tsx`（原文逐字、图片 data URL 与文件名、
只读无重发按钮、状态文案随回执、只有图片时的说明）。App 级断言加在既有
`scripts/side-chat-draft-restart-checks.mjs` 与 `scripts/side-chat-orphan-checks.mjs`，没有新脚本，也没有放宽旧断言。

## 4. 明确不宣称

- 没有真实付费 Provider 账号验收；发送路径仍用既有 fixture Provider。
- 没有操作系统输入法验收；IME 行为沿用 D1 的旧结论，本轮未重跑。
- 未跑性能测量、发布 gate、打包或安装；未提交、未推送、未升版本。
- App 证据来自隔离隐藏临时实例（临时 HOME/userData/工作区），不代表用户当前实例已更新。
- 快照多页仍只有组件夹具证据；App 内本轮只复验单页读取。

## 5. 集成前两处有界性修正（在上述 UI 工序之后）

`implementation-report.md` 已到 20,000B 手写文件门限，本轮续记在本文，不再追加该文件。这两项只改源码与单元测试，
没有重跑 App UI 或全量 `npm test`，也不因此改变上面第 1、2 节的 App 内结论。

**列表来源匹配（`src/main/conversation-side-chat.ts`）**：原 `sourceIdentities()` 对每个侧聊子会话都遍历全部
owner 的 bindings，历史越长越慢（每个子会话 × 全部 owner）。现在改为 `childNamesSource()`：同种来源仍是精确
元组/id 比较，跨种（native ↔ 统一对话）只按被请求的那一个 owner id 查表并只读它自己的 bindings。围栏保持不变：
只接受完全相同的 provider/profile/cwd/nativeSessionId。

**孤儿行页码表（`src/renderer/components/SideChatOrphanGroup.tsx`）**：组导航会清空行页码表，但目录变化可能在同一个
组页码下替换掉被展示的组，旧的 `{...current.rows}` 会把这些组的历史页码永久留下。现在每次更新行页码都先用
`pruneRowPages()` 裁到当前展示的组键（`src/renderer/side-chat-orphan-page.ts`），上限是 6 个组（一页）。

| 检查 | 结果 |
| --- | --- |
| `npx vitest run src/main/conversation-side-chat-paging.test.ts src/renderer/side-chat-orphan-page.test.ts` | 2 files / 12 tests 通过 |
| `npx vitest run` 对全部侧聊相关单元（`conversation-side-chat*`、`conversation-service`、`side-chat-*`、`RightSurfacePanel.side-chat`） | 22 files / 155 tests 通过 |
| `npm run typecheck` | 通过（node + web） |

两个新增回归都是计数/负控，而不是只断言“看起来更少”：

- `conversation-side-chat-paging.test.ts` 的用例把 `store.list` 换成计数 Proxy，断言：按 native scope 列子会话时
  任何 owner 的 bindings 都未被读（0 次）；按收养会话 id 列时只读被请求的那一个 owner（1 次）；再增加 24 个无关
  owner 后两次调用仍是 0 / 1 次。把实现改回“遍历全部 owner”（两个方向分别验证）时该用例立即失败。
- `side-chat-orphan-page.test.ts` 的用例模拟目录在同一个组页码下被替换 10 次：裁剪后表内键数始终 ≤ 6，结束时只剩
  当前展示的 1 个组；同时给出负控——旧的展开写法同样跑 10 次会留下 10 个键。

未做：这两项没有在真实 App 里重放 UI，也没有跑性能测量，因此不声称任何毫秒级收益；省下的是“每个子会话 × 全部
历史 owner”的 bindings 读取和不再无界的行页码条目。

## 6. 提交前的文件大小门限修正（两处超限文件拆分）

`.githooks/pre-commit` 调用的 `scripts/check-staged-file-size.mjs` 对**被提交的整份内容**卡 20,000B，既有大文件不豁免。
本轮改到过、但此前只在"本轮新增文件"里核对过尺寸的两个文件因此超限，必须先按职责拆分再谈提交：

- `src/renderer/format.ts` 69,728B → 拆成 `format-types.ts`（Turn/McpStatus）、`format-text.ts`（路径/数字/时间与
  用户消息解析）、`format-usage.ts`（cache token 口径）、`format-calls.ts`（调用明细）、`format-files.ts`（文件足迹）、
  `format-hook-command.ts` / `format-hooks.ts`（Hook 命令证据与汇总）、`format-segments.ts`（分段）、
  `format-billing.ts`（用量分析）、`format-session-report.ts`（Markdown 报告）、`trace-batch.ts`（`applyTraceBatch`）。
  `format.ts` 自身只剩 1,818B 的 re-export 入口，67 个调用方的导入路径与导出名一字未改（无人直接引用新的 `format-*` 模块）；
  `src/renderer/format.test.ts`（90 用例，63KB）没有改一行，仍全量通过——这是"行为没变"的主要证据。
- `scripts/side-chat-draft-restart-checks.mjs` 26,078B → 图片 fixture 与 composer/持久化草稿读取抽到
  `side-chat-draft-state.mjs`；回执只读内容检查（逐字原文、真图已解码、复用产品 lightbox、关闭后焦点回归、860×600
  窄窗、以及读回执不得改写持久化记录/建轮次/动更新的草稿）抽到 `side-chat-pending-content-checks.mjs`。原文件 46 条
  `check(...)` 与 9 张截图逐一保留（只把 `NEWER_TEXT`/`NEWER_IMAGE` 改成入参），3 个子标签 + 工具标签的 durable 恢复、
  丢回复回执、不重放等断言全部留在原处。第 3 节写的"没有新脚本"指当时 UI 工序没有新增检查脚本；这里新增的两个
  `.mjs` 只是同一批断言的承载体，没有放宽任何一条断言。

`scripts/performance-paths.json` 的 `stream` sources 补上 `src/renderer/trace-batch.ts`（`applyTraceBatch` 的新位置），
`src/renderer/format.ts` 继续保留。没有改 workload、计数或基线；真实性能测量与 `npm run performance:measure`
留在主分支集成后做。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（node + web） |
| `npx vitest run src/renderer` | 109 files / 1141 tests 通过 |
| `npm test` | 446 files / 4654 tests 通过，4 skipped（原有 P0/P1/BILLING/性能跳过）；shell `PASS setup-scry-workspace` |
| `npm run test:side-chat:ui` | 退出码 0；`drafts` / `restart` / `drafts restored` 步骤全过，`verification.json` 仍记录回执原文逐字一致、图片 `imageReady: true`、lightbox 同名、`focusReturned: true`、更新的草稿未被改动、3 个子标签 + 纵览标签恢复 |
| `node scripts/check-staged-file-size.mjs`（临时 index 全量暂存当前改动） | 退出码 0（263 个改动文件全部 ≤ 20,000B，其中最大的是 `implementation-report.md` 19,990B） |
