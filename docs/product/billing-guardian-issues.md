# Billing Guardian Issues Draft

访问日期：2026-07-02

这些是可直接拆工程任务的草案，不代表已经创建 GitHub issue。

## Epic 1：成本来源标注与 UI 语言修正

### BG-001：把 Claude SDK 成本标注为 estimate

背景：Claude Agent SDK TypeScript reference 标注 `ModelUsage.costUSD` 是 client-side estimate。当前 scry 已展示 cost，但账单卫士必须避免把估算说成正式账单。

验收：

- Overview/Analytics 中所有 Claude SDK cost 文案显示“估算”。
- hover/tooltip 说明：正式账单需要 Anthropic Usage & Cost Admin API 对账。
- 测试覆盖 cost 文案。

优先级：P0

### BG-002：新增 cost source/confidence 字段

背景：同一成本可能来自 SDK estimate、provider response、official bill、price table。

建议：

- 扩展 ledger 设计，新增 `cost_source`、`confidence`。
- 现有 `spans/model_usage` 不急于迁移，可先在 derived view 中生成。

验收：

- Claude SDK result 标为 `sdk_estimate / estimated`。
- 后续 provider connector 可写 `provider_reported` 或 `provider_bill`。

优先级：P0

## Epic 2：本地估算观察与异常

### BG-010：新增 Local Estimate Watch schema

验收：

- 支持 scope：run、day、project、session。
- 支持 mode：observe、warn。
- 不实现 stop。
- `budget_events` 包含 `threshold`、`window_start`、`window_end`、`source_span_id`，只在 threshold crossing 时写入，避免同一阈值重复刷屏。
- SQLite migration 有测试；新增表优先，不对现有表做无 guard 的 ALTER。

优先级：P1

### BG-011：Local Estimate Watch engine

验收：

- 每次 `harness/result` 后计算预算进度。
- 阈值默认 50/80/95%。
- 触发事件写入 `budget_events`。
- UI 不阻塞 agent。
- UI 文案叫“本地估算观察”或“Local Spend Estimate”，不暗示官方额度。

优先级：P1

### BG-012：异常检测 v1

规则：

- context/window > 80%、95%、100%。
- 单 turn cost > 手动阈值。
- 同 tool/MCP 连续失败或重复 N 次。
- subagent tool count/cost 超阈值。

验收：

- 每条异常能展开到 span/run/turn 证据。
- 没有足够历史数据时只跑绝对阈值，不编 P95。
- 只提示，不 stop agent。

优先级：P1

## Epic 3：成本归因

### BG-020：按 turn/model 精确聚合，按 skill/tool/MCP 关联解释

验收：

- Overview 显示 top cost turns。
- 调用明细中增加 tokens/cache/context 证据。
- Skill/tool/MCP 段显示与高成本 turn 的关联、调用次数和 `attribution_method`，默认不称为精确成本。
- 支持 `direct | turn_allocated | heuristic | unattributed`。
- MCP 段只统计可识别 MCP，显示 Bash/MCP 盲区说明。

优先级：P0

### BG-021：PR / diff observed related cost

验收：

- 当前 git diff 文件列表旁显示 observed related cost、相关 turn/tool/file_ops 和 coverage。
- 无法关联的成本归入 “unattributed”。
- 不做行级精确分摊；报告里明确 file_ops 的已知盲区：Bash/MCP 文件操作可能统计不到，`lines_added/lines_deleted` 当前不是 file_ops 精确字段。

优先级：P1

## Epic 4：报告导出

### BG-030：Session Cost Report Markdown

内容：

- sessionId、cwd、time range。
- total estimated cost、tokens、cache、context max。
- top cost turns。
- related skills/tools/MCP/hook，带归因方法和未归因比例。
- anomalies。
- touched files/git diff。
- data source/confidence。

验收：

- 一键导出 Markdown。
- 默认脱敏。
- 无 admin key 时也可用。

优先级：P0

### BG-031：JSON Export

验收：

- 导出 normalized ledger JSON。
- 不导出未脱敏 input/output preview，除非用户显式选择。

优先级：P1

## Epic 5：Provider raw usage layer

### BG-040：新增 provider_raw_usage / usage_ledger / model_price_versions schema

验收：

- migration 可重复执行。
- raw payload 可配置存完整或聚合。
- ledger 支持 input/output/cache_read/cache_write/reasoning/tool/cost/currency/cost_unit/source/confidence/attribution_method。
- raw usage 支持 OTel 字段：`trace_id`、`otel_span_id`、`parent_span_id`、`otel_signal`、`event_name`、`resource_attributes_json`、`span_attributes_json`。
- 对新增列使用 `PRAGMA table_info` guard 或事务化 migration，不重复踩 duplicate column。

优先级：P1

### BG-041：Claude SDK result → usage_ledger normalizer

验收：

- 保留现有 spans/model_usage。
- 生成 usage_ledger derived rows。
- `cost_source=sdk_estimate`、`cost_unit=usd`、`attribution_method=direct` for result/model rows。

优先级：P1

### BG-041B：Claude Code OTel importer

验收：

- 导入 Claude Code / Agent SDK OpenTelemetry traces、metrics、events。
- 保留 trace/span/resource attributes。
- 能与现有 `spans` 通过 session/run/time/model/tool 进行弱关联。
- 不把 OTel estimate 当 official bill。

优先级：P1

### BG-041C：Claude Code Analytics API importer

验收：

- 导入 daily user-level usage/estimated_cost/productivity 聚合。
- 标注它是 reporting 数据源，不是实时阻断机制。
- 与本地 session 只能按时间/user/terminal_type/model 做弱关联；project 只能来自本地 `project_key/cwd` heuristic，不能伪装成官方项目维度。
- `estimated_cost` 写入 `cost_source=analytics_report` 或 `official_telemetry`，不写成 `provider_bill`。

优先级：P1

### BG-042：OpenAI Agents SDK usage importer

验收：

- 支持 run-level `usage`。
- 支持 `request_usage_entries`。
- Session 中每次 run 独立计量，不误当累计。

优先级：P1

### BG-043：Gemini usageMetadata importer

验收：

- 支持 prompt/cached/candidate/tool-use/thoughts/total token。
- 标注 organization billing 未接入。

优先级：P1

### BG-044：OpenRouter response/generation usage importer

验收：

- 支持 response usage。
- 支持 stream final chunk usage。
- 支持 generation id 后验补录。
- 支持 `cost`、cached/cache_write/reasoning；`cost_unit=credits`。
- `cost_details.upstream_inference_cost` 标为 nullable / BYOK-only，不作为默认美元账单。
- 支持 Activity CSV/PDF import，但不把它写成已验证 account usage API。

优先级：P1

## Epic 6：官方账单对账

### BG-050：Anthropic Admin Usage & Cost connector

前置：用户显式提供 Admin API key。

验收：

- usage endpoint 支持 bucket width 1m/1h/1d。
- usage endpoint 可按 model/workspace/API key/service tier/context_window 等 usage 维度分组；`speed` 维度需 fast-mode beta header。
- cost endpoint 只承诺 daily official USD cost 和官方支持的 cost 维度；不承诺 model/context/service_tier 官方 cost 分组。
- Priority Tier cost 不在 cost endpoint 时必须标为缺失或通过 usage endpoint 单独跟踪。
- 标注个人账号不可用、AWS endpoint 不可用。
- 支持 pagination。
- key 存 keychain，不落 SQLite。

优先级：P1

### BG-051：OpenAI Admin Usage & Costs connector

前置：用户显式提供 Admin key。

验收：

- `/organization/usage/completions`。
- `/organization/costs`。
- usage endpoint 支持 project/model/api_key/user/service_tier 等 usage 维度。
- cost endpoint 只承诺 project/api_key/line_item/amount/quantity 等官方 cost 字段。
- model/user/service_tier cost 只能由 usage×价格表估算或标为 inferred。
- 支持 pagination。

优先级：P1

### BG-052：Reconciliation report

验收：

- 同一时间窗口显示 SDK estimate、provider response、official bill。
- 差异按 provider/project/API key/line item 等官方 cost 维度归因；model/user/service_tier 差异需标为 inferred。
- 数据延迟和缺失字段显式展示。

优先级：P1

## Epic 7：历史分析与优化建议

### BG-060：Daily/weekly rollups

验收：

- 生成 daily project/model direct rollup，以及 skill/tool/MCP attribution rollup。
- skill/tool/MCP rollup 必须保留 `attribution_method`、coverage 和 unattributed 比例，不把 direct/heuristic 混成精确趋势。
- Analytics 不再只依赖 raw aggregate SQL。

优先级：P2

### BG-061：Cache efficiency dashboard

验收：

- cache read/create/write trend。
- 按 model/skill/project 分组。
- 没有价格时只显示 token，不显示美元 savings。

优先级：P2

### BG-062：PR preflight estimate

验收：

- 输入 git diff。
- 根据历史相似 session 输出 low/expected/high 区间。
- 输出置信度和依据。
- 历史不足时明确“不足以估算”。

优先级：P2

### BG-063：Optimization Advisor

建议类型：

- compact/拆 session。
- 降级模型候选。
- 限制 thinking。
- 缓存机会。
- 重复读/循环风险。

验收：

- 每条建议有证据链接。
- 不自动改模型或工具权限。

优先级：P2

### BG-064：Commercial validation

验收：

- 访谈 5-10 个目标用户，记录他们当前 Claude/Codex/OpenCode 成本痛点和愿付费触发点。
- 验证 Free / Personal Pro / Team 的功能边界：retention、provider connectors、report/export、team sharing。
- Team 定价只保留待验证模型：per-seat、team base、usage add-on；不写死 $39-49/seat。

优先级：P2

## Epic 8：团队与 gateway 集成

### BG-070：LiteLLM virtual key spend import

验收：

- 支持 key/user/team spend。
- 支持 max_budget/rpm/tpm 配置读取展示。
- 不在 scry 内实现 proxy。

优先级：P3

### BG-071：Helicone gateway/report import

验收：

- 导入 session/cost/cache/report 数据。
- 支持 custom properties 映射到 project/workflow。

优先级：P3

### BG-072：Team report

验收：

- project/member/workflow cost。
- Slack/email/webhook。
- CSV/BI export。

优先级：P3

### BG-073：Provider spend policy integration

验收：

- Anthropic Enterprise-only Spend Limits API 作为可选 provider policy 来源之一。
- 明确 Usage/Cost Admin API 只做 reporting/reconciliation，不做在线阻断。
- 强预算只通过外部 gateway、virtual key/rate limit、SDK/hook/permission 或 provider 原生 spend policy 完成。

优先级：P3

## Epic 9：安全与隐私

### BG-080：Credential storage policy

验收：

- Admin/API key 只进系统 keychain。
- SQLite 只存 account label、provider、auth_mode。
- 删除账号时清除 keychain entry。

优先级：P1

### BG-081：Raw payload retention policy

验收：

- 用户可选 full/raw、metadata-only、aggregate-only。
- 默认 aggregate-only for external provider admin APIs。
- 导出遵守同一策略。

优先级：P1

### BG-082：Redaction regression tests

验收：

- 覆盖 Anthropic/OpenAI/GitHub/Slack/AWS/Bearer/JWT。
- 覆盖 provider raw payload。

优先级：P1

## Open Questions Backlog

### BG-OQ-001：Gemini organization-level billing integration

待查：Google Cloud Billing export/API 最小权限、字段、与 Gemini API usageMetadata 对账方法。

### BG-OQ-002：Claude Code subscription window estimator

待查：是否有官方可验证的订阅额度/窗口字段；否则只能做“本地估算”。

### BG-OQ-003：OpenRouter account/team usage API

待查：OpenRouter Activity Export 已有 CSV/PDF；仍需确认是否存在完整 account/team usage API，不能把 UI 导出当 API connector。
