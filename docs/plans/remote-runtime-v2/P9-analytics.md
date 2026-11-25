# P9 · 分析：LLM 性能与成本合并为一页，并修正统计

状态：已定（维护者 2026-11-24）。界面以 UI 设计稿为准：源文件在 [ui-mockups/analytics/](ui-mockups/analytics/README.md)，在线版本是 [Scry 分析](https://claude.ai/artifact/G69JhhGExKRtiS9xyyxEde)。本文规定数据、口径和行为。两者冲突时，布局以设计稿为准，其余以本文为准。

## 1. 现状与问题

现在有两个入口：
- 「分析」（`AnalyticsView.tsx`）：读 SQLite `usage_ledger`，经 `agent:usageAnalytics` 和 `agent:usageCredits` 两个接口取数。
- 「LLM 性能」：一个弹窗（`LlmPerformancePanel.tsx`），读 `<userData>/usage.jsonl` 里的 `llm_performance` 记录，经 `agent:llmPerformanceHistory` 和 `agent:llmPerformanceSummary` 两个接口取数。

两个页面统计的是同一批轮次，但分组的名字不同：LLM 性能按 Agent 分（比如 Pi），分析按计费上游分（比如「Codex」「cc-switch」「custom-gateway」「unknown」），所以两页的数字对不上。两页都只统计在 Scry 里发起的轮次。

审计发现的问题（2026-11-24，基于 `ca95a72b`；修复见 §3）：

| # | 问题 | 位置 |
|---|---|---|
| Q1 | 网关名和配置名被当成 Provider：cc-switch、custom-gateway、unknown，openai-codex 被显示为 codex | `shared/billing.ts:5-12`、`billing-ledger.ts:75-76,103-104`、`pi-usage.ts:87`、`pi-run.ts:267`、`usage-ledger-repair.ts:50-52`、`AnalyticsChart.tsx:89-91` |
| Q2 | 在 Scry 里运行的 Claude 被标成「Anthropic」 | `providers/claude.ts:434`、`AnalyticsChart.tsx:21-32` |
| Q3 | 0 Token 的记录被按价格表算成 $0.00，计入「已知成本」，图上多出灰点 | `official-api-cost.ts:18-26`、`span-ledger-usage.ts:254-258`、`AnalyticsChart.tsx:310-311` |
| Q4 | 每日曲线只为有记录的日子生成点，没有活动的日子和有用量但没价格的日子都画成断线 | `span-ledger-usage.ts:278-280`、`AnalyticsChart.tsx:217-219,241-245` |
| Q5 | Token 合计混用两种缓存口径：Codex app-server 的输入包含缓存，Claude 和 Pi 的不包含 | `AnalyticsChart.tsx:34-37`；`format-usage.ts:6-18` 里有现成的辅助函数，但没用上 |
| Q6 | Codex app-server 的轮次没有金额 | `codex.ts:1570-1610`；官方价格表只有 Claude 的模型（`official-api-cost.ts:7-16`） |
| Q7 | 没有返回模型的失败轮次单独成了一行「所选：<模型>」，0 轮 | `run-metrics.ts:28-30`、`llm-performance-data.ts:27-35` |
| Q8 | 输出速度（TPS）的分母包含首 token 之前的等待 | `pi-usage.ts:27-43`，Codex 同样如此 |
| Q9 | 表头和坐标轴没有单位 | `llm-performance-copy.ts:24`、`LlmPerformanceCharts.tsx:23-25,58,107-108` |
| Q10 | 7 天视图按 UTC 分桶，不是本地时间 | `llm-performance-data.ts:56` |
| Q11 | Claude 一轮里有小模型的侧调用时，会被归进「多模型」 | `run-metrics.ts:29` |
| Q12 | Qoder 的 Credits 只在已有 Qoder 账本记录的日子补点 | `qoder-credits.ts:262-263` |
| Q13 | 到处显示「—」：没有数据的行和格子、0 轮的行 | 两页都有 |

## 2. 合并后的页面

- **侧栏**：只保留一个入口「分析」。删掉「LLM 性能」入口和它的弹窗。
- **标签**：「LLM 性能」（默认）和「成本与用量」。标签切换的是不同页面，用下划线样式；时间范围和「成本 / Token」切换的是同一份数据的视图，用分段控件。
- **共用筛选**：Agent（全部 / 各 Agent）和时间范围。LLM 性能的时间范围是 1 小时、24 小时、7 天、30 天；成本与用量是 24 小时、7 天、30 天、90 天。切换标签时，Agent 筛选保留；时间范围如果另一页也有就保留，没有就用那一页的默认值（24 小时 / 30 天）。
- **行的身份**：Agent → 模型；网关（openai-codex、cc-switch、custom-gateway 等）作为副标题显示在模型下面，不再当成 Provider。两页用 `runId` 把性能样本和用量记录对应起来。
- **LLM 性能**：
  - 四张汇总卡片，按 2:1:1:1 排列，依次是输出速度（最大）、首 token、首段回复、轮次。
  - 模型对比表：模型 · Agent（网关）、轮次、输出速度分布、输出速度、首 token、首段回复。数值一律是中位数，表头带单位（token/秒、秒）。
  - 选中一个模型后，下方显示它的趋势图，每轮一个点，可以在三个指标之间切换。
  - 最下面是可以展开的「指标口径」说明。
- **成本与用量**：
  - 一句说明：「金额按 API 价格折算」。
  - 四张汇总卡片，按 2:1:1:1 排列，依次是成本（最大）、平均每轮、Token、轮次。
  - 每日成本图：按 Agent 画平滑曲线，带浅色面积填充，可以在成本和 Token 之间切换。
  - 按 Agent 的表：每个 Agent 一行，下面缩进列出各模型（副标题是网关）；列为轮次、Token、成本、占比。

## 3. 口径与修复

**显示规则**：只有一条原则，没有数据就不显示。
- 没有数据的行不显示。没有成功轮次的模型不成行。
- 没有数据的格子留空，不写「—」。
- 0 Token 的记录不计入任何统计（修 Q3）。
- 没有活动的日子在曲线上画 0（修 Q4）。
- 整页没有数据时，显示一个小图标、一句话（这段时间没有在 Scry 里运行）和一个文字按钮「看 7 天」。
- 加载在 300 毫秒内完成的，不显示加载态；更久的，用和表格、图表同尺寸的骨架占位，标题和筛选立即显示。

**身份**（修 Q1、Q2）：
- 记录里分开存三个字段：`agent`（Pi、Claude、Codex、Qoder、OpenCode、Antigravity）、`gateway`（上游名，可以为空）、`model`。
- 厂商从模型或 Pi 的 provider `api` 类型推出来，只用于定价，不在界面上当分组。
- 已有的历史记录在读取时迁移，不改写旧数据。

**成本**：
- 金额一律按 API 价格折算，这是维护者确认的口径；Qoder 按 Credits 折算（1 Credit = $0.01）。
- 补上 Codex app-server 轮次的定价（修 Q6）：按模型查同一份价格来源，比如 Pi 目录里 openai-codex 的价格。
- 查不到价格的行，成本格留空，不参与占比计算，也不计入总额。
- 「平均每轮」= 总额 ÷ 已定价的轮次。

**Token**（修 Q5）：
- 统一成「输入不含缓存 + 输出」，Codex 要把缓存部分从输入里减掉。用 `format-usage.ts` 里的 `tokenCacheAccounting`。

**LLM 性能**：
- 失败的轮次：先用这一轮实际观测到的模型；还是没有的话，这一轮不计入任何统计，也不成行（修 Q7）。
- 输出速度 = 输出 token ÷ 生成时间，生成时间 =（这次调用的时长 − 首 token）（修 Q8）。
- 首段回复保持原来的定义：从发送到界面出现第一段文字，包含工具执行和等待批准的时间。这一点写进「指标口径」。
- 一轮里调用了多个模型时，归到输出 token 最多的那个模型，不再归进「多模型」（修 Q11）。
- 表头和坐标轴带单位（修 Q9）。7 天和 30 天视图按本地时间的 0 点分桶（修 Q10）。
- 趋势图每轮一个点，不画中位线。

**每日曲线**：
- 按日期补齐所有日子；没有数据的日子画 0。
- Qoder 的 Credits 也按日期补齐（修 Q12）。

## 4. 不在本次范围

- 终端里直接运行的会话：需要把记录器的数据导入进来，另起任务。页面上不提这件事，「指标口径」里写明「只统计在 Scry 内发起的轮次」。
- iPhone 上的分析页。

## 5. 验收

- **单元测试**：Q1–Q13 每一项都先写失败测试，再修。至少包括：
  - 0 Token 的记录不计入；
  - 没有活动的日子画 0；
  - 网关不当成分组；
  - Codex 缓存的换算；
  - 失败轮次的归属；
  - 输出速度的分母；
  - 按本地时间分桶；
  - 多模型的归属；
  - Codex 的定价。
- **界面测试**：
  - 侧栏只有「分析」入口，默认打开「LLM 性能」标签；
  - 两个标签之间切换时，筛选按 §2 的规则保留；
  - 页面上不出现「—」和「所选：」；
  - 空状态和加载态符合 §3。
- **冒烟测试**：原有的分析和 LLM 性能冒烟改成走新页面，断言不能减少。截图按明暗两种主题各一张，存进证据目录，和设计稿对照。
- **门禁**：性能门限、棘轮文件不放宽；App 主进程模块数不超过 192；`npm run design:audit` 结果为 0。
