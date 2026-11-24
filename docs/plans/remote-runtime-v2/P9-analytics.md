# P9 · 分析：合并「LLM 性能」与「分析」，修正统计（设计）

状态：已定（维护者 2026-11-24）。界面以 UI 设计稿为准：源文件在 [ui-mockups/analytics/](ui-mockups/analytics/README.md)，在线版本是 [Scry 分析](https://claude.ai/artifact/G69JhhGExKRtiS9xyyxEde)。布局以设计稿为准，数据口径和行为以本文为准。任务单 W22。

## 1. 目标

- 侧栏只保留一个入口「分析」。原来单独的「LLM 性能」入口和弹窗删掉，「分析」页默认打开「LLM 性能」标签，另一个标签是「成本与用量」。
- 两个标签用同一套行身份，都是「Agent → 模型」。网关（cc-switch、radius、openai-codex 等）只作为模型的副标题显示，不再当成 Provider。
- 修正 §3 列出的统计问题。
- **显示规则只有一条：没有数据就不显示**，见 §4。

不做：
- 把终端里直接运行的会话（turn recorder 写在 `~/.scry` 下的数据）导进统计。两个页面现在都只统计在 Scry 内发起的轮次，第一版保持这样，见 §7。
- 改 1386 秒这一类首段回复的口径。

## 2. 页面

**侧栏**：一个「分析」入口，原来的「LLM 性能」入口删掉。

**顶部**：
- 标题「分析」，右边两个标签：「LLM 性能」（默认）和「成本与用量」。
- 右侧是 Agent 筛选（全部 / 各 Agent）和时间范围。
  - LLM 性能：1 小时、24 小时、7 天、30 天。
  - 成本与用量：24 小时、7 天、30 天、90 天。
- 切换标签时，Agent 筛选保持不变。

**LLM 性能标签**（设计稿 `Main.dc.html`）：

- 四张汇总卡片：轮次、输出速度、首 token、首段回复，后三项都是中位数。
- 模型对比表。
  - 列：模型 · Agent（副标题是网关）、轮次、输出速度分布、输出速度（token/秒）、首 token（秒）、首段回复（秒）。
  - 表头旁写一次「数值都是中位数」，各格子下面不再加小字。
  - 行按 Agent + 模型分组，同一模型经不同网关的轮次各自成行，网关写在副标题里。
- 选中一行后，下方显示这个模型的趋势图：每轮一个点，可以切换三项指标。
  - 不画中位线。
  - 时间轴按本地时间。
- 页面底部有可折叠的「指标口径」说明，内容见 §5。

**成本与用量标签**（设计稿 `Cost.dc.html`）：

- 页面顶部写一句：「金额按 API 价格折算。」
- 四张汇总卡片：
  - 轮次；
  - Token（输入 · 输出）；
  - 成本；
  - 平均每轮，按已定价的轮次计算。
- **每日成本图**：
  - 每个 Agent 一条平滑曲线，主线下方加淡色面积；
  - 可以切换「成本 / Token」两种度量；
  - 没有活动的日子画 0，曲线不断开；
  - 查不到价格的用量不计入成本曲线。
- **按 Agent 表**：
  - 列：Agent · 模型 · 网关、轮次、Token、成本、占比。
  - Agent 行下面展开模型行，网关写在模型的副标题里。
  - 查不到价格的行，成本和占比两格留空。

## 3. 要修的统计问题

审计时基于 main `ca95a72b`，行号以那个提交为准。

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 1 | 网关、配置名被当成 Provider：cc-switch、radius、unknown 单独成行 | `src/shared/billing.ts:5-12` 的 `billingProviderForUpstream`；`billing-ledger.ts:75-76,103-104`、`pi-usage.ts:87`、`pi-run.ts:267`、`usage-ledger-repair.ts:50-52` | 分清 Agent、厂商（由 Pi 的 `api` 类型或模型族推出）和网关三个字段。页面按 Agent → 模型分组，网关只作副标题。没有网关信息时，副标题不写。 |
| 2 | 0 Token 的记录被定价成 $0.00，于是出现 0.0% 的占比和图上的灰点 | `official-api-cost.ts:18-26`、`span-ledger-usage.ts:254-258` | 输入和输出都是 0 的记录不计入任何统计。 |
| 3 | 没有活动的日子和查不到价格的日子都画成断线 | `span-ledger-usage.ts:278-280`、`AnalyticsChart.tsx:217-219,241-245` | 没有活动的日子画 0。成本曲线只累计已定价的金额；查不到价格的用量只计入 Token 曲线。 |
| 4 | Token 合计里两种缓存口径混在一起：Codex 的输入包含缓存，Claude 和 Pi 的不包含 | `AnalyticsChart.tsx:34-37`；`format-usage.ts:6-18` 的 `tokenCacheAccounting` 没有用上 | 统一成「输入不含缓存」，Codex 的输入要先减去缓存读取。同时检查 `billing-ledger.ts:208` 对 Pi 自定义上游是否少减或多减了缓存。 |
| 5 | Codex app-server 的轮次没有金额 | `codex.ts:1570-1610` 不返回 cost；`official-api-cost.ts:7-16` 只有 Claude 的价格 | 给 Codex 用到的模型补上 API 价格。价格必须来自官方公开价目表，在代码注释里写明来源和日期。查不到的模型保持未定价（成本格留空），不许猜价格。 |
| 6 | 「所选：<模型>」：失败的尝试单独占一行，0 轮 | `run-metrics.ts:28-30`、`llm-performance-data.ts:27-35`、`shared/llm-performance.ts:181-182` | 模型名先用实际观测到的模型（`llm-performance.ts:79`），观测不到再用请求的模型，并去掉「所选：」前缀。未成功的轮次不计入轮次，也不单独成行。 |
| 7 | 输出速度的分母包含了首 token 之前的等待 | `pi-usage.ts:27-43`，Codex 同理 | 输出速度 = 输出 token ÷（调用时长 − 首 token 时间）。拿不到首 token 时间的 Agent（Claude 用 SDK 的 API 时长）沿用现有口径，在「指标口径」里写明。 |
| 8 | Claude 一轮里有 Haiku 的旁路调用时，被归成「多模型」 | `run-metrics.ts:29` | 按输出 token 最多的模型归属，不再出现「多模型」行。 |
| 9 | 表头和坐标轴没有单位 | `llm-performance-copy.ts:24`、`LlmPerformanceCharts.tsx:23-25,58,107-108` | 表头写单位：token/秒、秒。 |
| 10 | 7 天视图按 UTC 分桶 | `llm-performance-data.ts:56` | 改为本地时间，从本地零点起算。 |
| 11 | 趋势图样本少时，每个样本画成一段 8 px 的短横 | `llm-performance-data.ts:62-64`、`LlmPerformanceCharts.tsx:122` | 一律每轮画一个点，不画中位线。 |
| 12 | Qoder 的 Credits 只补在已经有 Qoder 账本记录的日子，其余日子漏掉 | `qoder-credits.ts:262-263` | 有 Credits 的日子都要计入。 |
| 13 | 没有上游的 Pi 结果被标成 `provider_reported`，夸大了证据质量 | `billing-ledger.ts:76`、`usage-ledger-repair.ts:51` | 改成如实的证据质量；这类结果在页面上按 Agent = Pi 显示，副标题留空。 |

**保留不改**：金额统一按 API 价格折算，这是维护者确认过的口径；Qoder 的 Credits 按现有规则折算成美元，一起计入总额和占比。

## 4. 显示规则

1. **没有数据的行不显示**：这段时间没有用量的 Provider 或模型、0 轮的行、只有失败轮次的行。
2. **没有数据的格子留空**：不写「—」、不写「不上报」，也不写 0。
3. **0 Token 的记录不计入。**
4. **没有活动的日子画 0。**

格子下面不加任何说明性小字。不显示「n 轮原始值」「未成功」「未定价」这类标注，也不显示覆盖率。

## 5. 指标口径（页面里折叠显示的说明）

- 输出速度：输出 token ÷ 生成时间，生成时间从首个 token 算到结束。Claude 用 SDK 上报的 API 时长。
- 首 token：从发出请求到收到第一个 token。
- 首段回复：从发送消息到界面上出现第一段文字，中间的工具执行和等待批准时间都算在内。
- 表里的数值都是中位数。
- 统计范围只包括在 Scry 内发起的轮次。
- 金额按 API 价格折算，Qoder 按 Credits 折算。

## 6. 数据与实现要点

- 两个标签都通过 `query-channels.ts` 读数据，App 主进程和 daemon 都能提供（`daemon-local-ops/queries.ts`）：
  - 「成本与用量」读 `agent:usageAnalytics` 和 `agent:usageCredits`，数据在 SQLite `usage_ledger`；
  - 「LLM 性能」读 `agent:llmPerformanceHistory`，数据在 `usage.jsonl` 里 `kind:'llm_performance'` 的行。
- 行身份统一为「Agent + 模型 + 网关」，需要时用 `runId` 把两边的数据连起来。
- 这次不新增 IPC 通道，也不改通道名。如果确实要加，必须进 daemon 门表和 IPC 矩阵，App 主进程的模块数不能超过 192。
- 「LLM 性能」弹窗（`LlmPerformancePanel.tsx`，挂在 `AppShellModals.tsx`）改成「分析」页里的一个标签。原来打开这个弹窗的入口都改为跳到「分析」页的这个标签。

## 7. 以后再说

- 把终端里的会话（turn recorder 数据）计入统计。
- 修正首段回复的口径，比如去掉工具执行和等待批准的时间。
