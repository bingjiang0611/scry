# Context 历史可视化 · 方案

状态：设计提案（分支 `feat/context-history-visualization`，未实现、未合入）
参考：仓库根 `context-history-7205/index.html`（单会话离线回放分析页）
设计稿：[Scry Context 历史设计稿](https://claude.ai/artifact/1MQPUa3DzEhyqQ7Ry4vLc9)（私有链接；三张画板：最大化视图、入口与窄态、证据降级状态；数据均为虚构示例）

## 1. 目标与边界

把 `context-history-7205` 这类“一次性离线分析页”变成 Scry 内置能力：在任一会话里回答四个问题。

1. context 是怎么一路涨上来的，离窗口还有多远？
2. 每次压缩前，是什么占满了窗口？压缩后留下了什么？
3. 哪些不显眼的事件改变了 context（单条 edit、系统/工具声明更新、窗口变化、模型切换）？
4. 这些数字里，哪些是 Provider 给的精确值，哪些是 Scry 估算的，哪些根本无法得知？

不做的事：

- 不做 tokenizer 级实测，不还原历史请求 payload；类别组成始终标 `estimated`。
- 不为补齐数据发起任何模型请求或 probe。
- 不把分类之和缩放到原生总量，不把超过窗口的分类之和解释成“真的溢出”。
- 不扫描、收编 Scry 之外启动的会话（与 `app-sessions.json` 现有边界一致）。

## 2. 参考页拆解

`context-history-7205` 由一份内嵌 JSON（约 3 MB）和纯前端渲染组成，结构可以直接映射为 Scry 的数据合同：

| 参考页模块 | 内嵌数据 | 在 Scry 中的对应 |
| --- | --- | --- |
| 顶部四格统计（回放范围、完整压缩次数、压缩前总量区间、最新状态） | `source`、`compactions`、`points[-1]` | Context 视图头部摘要 |
| “增长、压缩，再增长”曲线（原生总量 / 分类之和 / 窗口容量 / 用户输入点；真实时间 ↔ 消息序列；拖动条） | `points[]`、`windowSchedule`、`userInputs` | 主曲线 |
| 压缩卡片（压缩前总量、摘要大小、压缩前/后组成条） | `compactions[]` + `beforePoint/afterPoint` 的 `categories` | 压缩时间线卡片 |
| State inspector（所选时刻：原生 vs 估算、类别表、两种占比） | `points[n].categories`（含 `tool-output.children` 按工具拆分） | 右侧详情 |
| “容易被漏掉的上下文事件” | `edits[]`、`kind = system-update / custom_message`、窗口变化 | 事件列表 |
| “如何还原 · 数据可信度与边界” | `method.*` | 证据说明（折叠） |

参考页最值得保留的三条纪律：两条线不是同一把尺子；“组成占比”和“窗口占比”分母不同、分开展示；压缩摘要请求自身的 usage 不是压缩后 context 大小。

参考页里用户输入原文、URL、内部需求单号、源文件路径等是该次分析的私有内容，内置功能默认不展示原文（见第 7 节）。

## 3. 现有数据能支撑什么

| 证据 | 现有来源 | 质量 | 覆盖 |
| --- | --- | --- | --- |
| 每次请求的 context 占用 | `TraceEvent.contextTokens`（`stage = context_usage` 或 `result`），`contextUsageEvidence()` 绑定模型窗口 | `exact` / `inferred` | Claude（assistant usage）、Codex（last request usage）、Qoder（ratio 换算 → `inferred`）、Pi（RPC usage）、OpenCode（聚合，可能 unavailable） |
| 模型窗口 | `modelUsage[].contextWindow` | 随 Provider | 窗口变化可从相邻样本的 window 差异得到 |
| 压缩事件 | `stage = context_compaction`，`ContextCompaction { trigger, preTokens, postTokens }`；旧 Pi 归档走 `compaction_end` | `preTokens` 通常 exact；`postTokens` 多数缺失 | Claude `compact_boundary`、Codex、OpenCode、Pi |
| 用户输入时刻 | `Turn.userText` + turn 起点 | exact | 全部 |
| 消息/思考/工具调用/工具输出正文 | trace archive、`ToolContent`（含 `storage: truncated/omitted` 与 `contentRef`） | 正文可能截断 | Scry 启动的会话 |
| 分支与压缩保留点 | Pi 原生 v3 session 的 `parentId` / `firstKeptEntryId`（`pi-native-history.ts` 已能读当前分支） | exact | 仅 Pi 原生记录 |

结论：

- **原生总量曲线 + 压缩标记 + 窗口线**：现有 trace 已足够，几乎零新增采集，可先上线。
- **分类组成**：需要一个新的 main 侧 projection，用归档正文重新估算；Claude 等没有“压缩后保留哪些消息”信息的 Provider，压缩后组成只能是 `partial`。
- **单条 context edit、系统/工具声明增量**：目前只有 Pi 原生记录能可靠识别，其他 Provider 显示 `unavailable`，不推断。

## 4. 产品形态

### 4.1 入口

1. **纵览面板的上下文条（`.ctx-gauge`）**：整条可点，hover 显示“查看 context 历史”。有压缩时，条上追加一个小计数“压缩 ×N”。
2. **纵览「会话」页签的压缩计数**（`OverviewSessionSummary`）：点数字直接跳到 Context 视图并定位到最近一次压缩。
3. **右侧 surface 菜单**新增「Context」项，复用 `RIGHT_SURFACE_DEFINITIONS`，支持最大化。

没有任何 context 证据的会话：入口仍在，打开后显示 unavailable 说明（为什么没有、哪个 Provider），不显示空图或 0。

### 4.2 Context 视图（右侧 surface，默认 380px，可最大化）

窄态（380px）只显示：头部摘要 + 迷你曲线 + 压缩列表；点任一处展开到最大化。最大化后为完整布局：

1. **头部摘要**：模型与窗口、当前占用（exact/inferred 徽标）、压缩次数（auto/manual 分开）、压缩前峰值区间、回放覆盖范围（N 轮 / M 次请求 / 起止时间）。
2. **主曲线**
   - 实线：原生总量（Provider usage；证据质量用线型区分：exact 实线、inferred 细实线 + 徽标）。
   - 虚线：分类组成之和（estimated，可开关，默认开）。
   - 琥珀虚线：窗口容量（随 `windowSchedule` 阶梯变化）。
   - 竖线 + 菱形：压缩（auto 蓝 / manual 灰），hover 显示 `preTokens → postTokens`，`postTokens` 缺失时写“压缩后大小未上报”。
   - 圆点 U1…Un：用户轮次，hover 显示轮次序号、时间、首行摘要（默认折叠原文，见隐私）。
   - X 轴可切“真实时间 / 请求序列”；底部拖动条联动 inspector。
   - 断档：两次样本之间缺 usage 时画断线而不是插值。
3. **压缩时间线卡片**（横向滚动）：每张卡写“压缩 #k · 时间 · 触发方式”，压缩前总量 / 窗口占比，压缩前、后两条组成条，按钮「压缩前」「压缩后」跳转 inspector。
4. **State inspector**（所选时刻）
   - 两个大数：原生总量（含 % 窗口）与分类组成估算（含 % 窗口），并排但视觉上明确是两把尺子。
   - 组成条 + 类别表：类别 / 估算 tokens / 组成占比 / 窗口占比；「工具输出」可展开到按工具名拆分（bash、read、mcp:xxx…）。
   - 右栏解释卡：点类别显示定义、估算规则与“可能的来源”（如工具输出 Top 5 调用，点击跳到对应轮次的工具卡）。
5. **事件列表**：压缩、窗口变化、模型切换、context edit、系统/工具声明更新、usage 断档，各自带来源与证据质量；点击定位曲线。
6. **证据说明（折叠）**：本会话实际用到的来源（trace archive / Provider 原生记录 / turn record）、哪些类别是估算、哪些 Provider 能力缺失。

### 4.3 类别

沿用参考页的 11 个类别 id，避免第二套命名：`system-prompt`、`context-files`、`skills`、`tool-definitions`、`user-messages`、`assistant-messages`、`assistant-thinking`、`tool-calls`、`tool-output`、`extensions`、`compacted-data`。

Provider 拿不到的类别（例如 Claude SDK 不暴露 system prompt 与工具定义长度）显示为灰色 `unavailable` 行，并从组成占比分母中剔除，在表尾注明“未计入 N 类”。不用 0 填。

## 5. 数据合同（草案）

新增 `src/shared/context-history.ts`：

```ts
export type ContextEvidenceQuality = 'exact' | 'inferred' | 'estimated' | 'partial' | 'unavailable'

export interface ContextHistoryPoint {
  n: number
  ts: string
  runId: string
  kind: 'request' | 'user' | 'before-compaction' | 'after-compaction' | 'context-edit' | 'system-update'
  window: number | null
  native: { tokens: number; quality: 'exact' | 'inferred'; source: string } | null // 缺失是 null，不是 0
  estimate?: { total: number; quality: 'estimated' | 'partial'; categories: ContextCategoryEstimate[] }
}

export interface ContextCategoryEstimate {
  id: ContextCategoryId
  tokens: number | null // null = unavailable，不进入组成占比分母
  children?: { label: string; tokens: number }[]
  reasons?: ('content_truncated' | 'provider_missing' | 'not_replayable')[]
}

export interface ContextHistoryCompaction {
  number: number
  ts: string
  trigger: 'auto' | 'manual' | null
  preTokens: number | null
  postTokens: number | null
  beforePoint: number
  afterPoint: number | null
  summaryUsage?: { input: number; output: number } // 摘要请求自身用量，仅作说明
}

export interface ContextHistory {
  sessionId: string
  revision: string // 归档/原生记录指纹，作为缓存键的一部分
  provider: ProviderId
  capability: CapabilityEnvelope<{ native: boolean; composition: boolean; edits: boolean }>
  windows: { ts: string; window: number; basis: string }[]
  compactions: ContextHistoryCompaction[]
  userTurns: { number: number; ts: string; point: number; runId: string }[] // 不含原文
  points: ContextHistoryPoint[]
  sampled: { total: number; returned: number } // 下采样诚实标注
}
```

## 6. 实现路径

### 6.1 main

- `src/main/context-history.ts`：从会话归档（`session-history` / `transcript-archive`）构建 `ContextHistory`。
  - 原生曲线：遍历 `contextUsageEvidence()` 与 `contextCompactionOf()`，与 Overview 现有口径一致，保证两处数字对得上。
  - 组成估算：在 worker 中重放（复用 `transcript-parser-worker` 的模式），文本 chars/4、thinking 取可见估算与 `reasoningTokens` 较大者、图片沿用 Provider 固定估计；`ToolContent.storage !== 'complete'` 时类别标 `partial` 并给出 reason。
  - Pi：基于 `pi-native-history.ts` 的分支读取，按 `firstKeptEntryId` 还原压缩后保留集，`context-edit` 与 `system-update` 可用。
  - 其他 Provider：压缩后组成 = 摘要（若可得）+ 无法确认保留集 → `partial`。
- IPC：`handleTrusted('agent:contextHistory', …)`，入参只接受 sessionId（+ 可选 `{ from, to, maxPoints }`），main 重验 session 属于 catalog。
  - 有上限：默认返回 ≤ 1200 点，用 LTTB 下采样并强制保留压缩前后、用户轮次、事件点；`sampled` 字段如实标注。
  - 不同步 I/O；同一 session 并发请求合并；缓存键 = sessionId + revision + 估算规则版本，LRU 上限 8。
  - 在 `scripts/performance-paths.json` 映射到新用户路径“打开 context 历史”。
- 运行中会话：不实时重算组成；曲线随新的 `context_usage` 增量追加，组成显示“截至 hh:mm 的估算 · 刷新”。

### 6.2 preload / renderer

- `window.scry.contextHistory(sessionId, range?)` typed API。
- `right-surface.ts` 新增 `context` kind；组件 `ContextHistoryPanel.tsx` + `context-history.css`，只用现有 CSS 变量（`--bg/--panel/--panel2/--border/--fg/--dim/--accent/--warn`），类别色作为新的局部变量组，不新增全局 token。
- 曲线用手写 SVG（参考页同款），不引入图表库；点数已在 main 侧受限。
- 键盘：曲线可聚焦，左右键逐点移动，Home/End 跳首尾，PageUp/PageDown 跳上一/下一次压缩。

### 6.3 导出（P3）

「导出分析数据」导出 JSON（与 `ContextHistory` 同结构）；可选导出离线 HTML 快照（复用参考页 CSP：`default-src 'none'`）。默认不含用户输入原文，导出前提示内容可能敏感。

## 7. 隐私与证据诚实

- 默认不展示用户输入原文；U 点 hover 只显示轮次序号、时间、所属 run。用户在视图内点“显示输入摘要”后才展示首行（与对话正文同源，不额外存储）。
- 类别组成永远带 `估算` 徽标；inferred 原生值带 `推断` 徽标；缺失为 `暂无`，不画 0。
- 压缩摘要请求的 usage 只在卡片说明里出现，并写明“不是压缩后 context 大小”。
- 下采样、截断正文、Provider 不支持的能力都在证据说明里列出。

## 8. 分期

| 期 | 内容 | 依赖 | 验收要点 |
| --- | --- | --- | --- |
| P1 | 原生曲线、窗口线、压缩标记与卡片（仅原生数字）、用户轮次点、事件列表（压缩/窗口/模型切换/断档）、入口 | 仅现有 trace | 与 Overview 上下文条最新值一致；无证据会话显示 unavailable；5 个 Provider fixture 各一条 |
| P2 | 分类组成估算、inspector、压缩前/后组成、工具输出按工具拆分；Pi 的 edit/system-update | 新 projection + worker | 用 7205 同源 Pi fixture 回归：每次压缩前原生总量逐条等于 `tokensBefore`；截断正文标 partial |
| P3 | 导出 JSON / 离线 HTML、运行中增量刷新、iOS 只读查看（按 iOS 自身设计语言单独出稿） | P2 | 导出不含原文；性能路径 `worse` 有说明 |

## 9. 待决问题

1. 入口放右侧 surface（本方案）还是做成会话级独立页面？右侧 surface 与现有工作区一致、实现成本低，但最大化前空间有限。
2. P1 是否允许在不估算组成的情况下也展示压缩卡片？（本方案：允许，组成条位置显示“组成估算在 P2 提供”。）
3. Claude 路径的 system prompt / 工具定义长度拿不到，是否接受这两类长期 `unavailable`？
4. 是否需要跨会话对比（例如同一项目里各会话的压缩频率），还是先只做单会话。
