# Billing Guardian Roadmap

访问日期：2026-07-02

本 roadmap 基于 `billing-guardian-research.md`。优先级原则：先把本地 Claude agent session 的钱解释清楚，再接多 provider，对账和团队治理最后做。

## P0 / MVP：Claude 本地账单卫士

目标：不接账单后台、不上传数据、不干预 agent 行为，用现有 SDK stream 和 SQLite 告诉用户“这次 session 为什么花钱/耗上下文，以及下一步该怎么处理”。

范围：

1. Session Cost Explanation
   - 在右侧面板区分 `SDK 估算` 和 `官方账单未接入`。
   - 汇总 session/run/turn/model 的 cost、tokens、cache read/create、duration。
   - 展示 top cost turns、context/cache spikes、相关 skill/tool/MCP/hook 证据。
   - skill/tool/MCP 只显示 `direct/turn_allocated/heuristic/unattributed` 归因方式，不显示成精确账单。

2. Evidence Expanders
   - 支持从 expensive turn 展开到模型用量、cache/context、tool/skill/MCP/hook、文件触达、git diff。
   - 明确显示 coverage 和未归因比例。
   - hook 频率在 P0 只基于当前 session items；跨会话 hook 聚合等新增 hook span 后再做。

3. Action Signals
   - 只做 context spike、重复 tool/MCP、失败重试、subagent runaway 的本地提示。
   - 每个告警必须能展开到 spans 证据。
   - 不写完整预算系统，不 stop agent。

4. Report Export
   - Markdown 导出 session cost report。
   - 默认脱敏。

验收：

- 在不配置任何 provider key 的情况下完成核心体验。
- 对一个真实 `workflow-orchestrator` session，能解释直接成本来源：model、turn、context/cache；skill/tool/MCP/hook 作为关联证据展示。
- 告警只提示，不自动 stop。
- 用户能从报告中得到一个下一步动作：compact、拆 session、停止疑似循环或导出证据。
- SQLite 失败时不影响 app 主流程。

## P1 / Beta：多来源 usage 导入与对账

目标：把 SDK 估算、官方 telemetry 和官方账单分开，建立 reconciliation。Beta 先打穿一个官方来源，不同时接完所有 provider。

### P1' 实施口径（2026-07-03）

本次落地没有可用 Anthropic/OpenAI 官方 Admin key，用户明确要求跳过 P1 官方 Admin 验证。实现口径调整为：

- 支持 third-party Anthropic-compatible gateway：读取 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 的运行环境状态，但不保存 token。
- 三方网关 response/fixture 写入 `provider_raw_usage` / `usage_ledger` 时标为 `gateway_reported`，`confidence=provider_reported`。
- 通过三方网关执行的 SDK result 仍标为 `sdk_estimate`，不能升级成官方账单。
- `official_bill` 在无官方 Admin 来源时必须显示 `unavailable`。
- P2-P4 的 rollup、preflight、team cost、showback 只能选择一个 canonical cost source：官方账单优先，其次 gateway/provider reported，最后 SDK estimate，避免并行口径双算。
- 官方 Admin connector 和 gated real test 保留为后续 opt-in 路径。

范围：

1. Provider Raw Usage Layer
   - 新增 `provider_raw_usage` 和 `usage_ledger`。
   - 所有 provider payload 原样保存或按用户设置只存聚合。

2. Claude Official Source Connector
   - 首选之一：Claude Code OTel ingest，保留 trace/span/resource attributes。
   - 首选之二：Claude Code Analytics API，拉取 daily user-level usage/estimated_cost/productivity 聚合。
   - 首选之三：Anthropic Usage & Cost API。

3. Anthropic Admin API Connector
   - Usage report 支持 bucket width 1m/1h/1d 和 usage 维度分组。
   - Cost report 只承诺 daily official USD cost 和官方支持的 cost 维度；不承诺 model/context/service_tier 官方 cost 分组。
   - Priority Tier cost 需用 usage endpoint 单独跟踪或标为缺失。
   - 标注个人账号不可用、AWS Claude Platform endpoint 不可用的限制。

4. OpenAI Admin API Connector
   - 支持 `/organization/usage/completions` 和 `/organization/costs`。
   - usage endpoint 支持 project/user/api_key/model/service_tier 等维度。
   - cost endpoint 只承诺 project/api_key/line_item/amount/quantity 等官方 cost 字段；model/user/service_tier cost 需标为 inferred。

5. OpenRouter Connector
   - 支持 response usage ingest。
   - 支持 generation id 后验查询。
   - 支持 Activity CSV/PDF import；不把它写成已验证 account usage API。
   - `usage.cost` 单位按 credits 处理，美元换算必须有来源。

6. Gemini Adapter
   - 支持 `usageMetadata` ingest。
   - organization billing export 暂列 open question。

验收：

- 同一 session 可显示本地估算与 provider reported；official bill 只在官方支持的时间窗口/组织/project/API key/line item 等维度展示，session 级只能做 inferred reconciliation。
- Reconciliation 报告能列出差异、数据新鲜度、缺失字段。
- Admin key 必须 opt-in，且不落库明文。
- 如果只完成一个 connector，也必须能闭环 reconciliation；其他 provider 保持 backlog。

## P2 / Personal Pro

目标：让个人用户持续找到浪费。

范围：

1. Historical Analytics
   - per-day/per-week rollup。
   - project/model/skill/MCP trend。
   - cache hit trend。
   - expensive sessions replay。

2. Price Table
   - provider/model 价格表版本化。
   - 用户可覆盖自定义模型价格。
   - 历史估算冻结价格版本，不被新价格静默改写。

3. PR Preflight Estimate
   - 输入 git diff、文件类型、历史相似 session。
   - 输出 low/expected/high 区间和置信度。
   - 历史不足时明确拒绝估算。

4. Optimization Advisor
   - 只给建议，不自动改模型。
   - 建议类型：拆任务、compact、降级模型、限制 thinking、缓存提示、避免重复读大文件。

验收：

- 用户能按项目看到周/月成本走势。
- 对一个 PR 估算给出区间和依据。
- 所有“省钱建议”都能回链到历史证据或明确标注为 heuristic。

## P3 / Team

目标：从个人账本扩展到团队项目治理。

范围：

1. Team Projects
   - 成员、项目、repo、workflow 标签。
   - 团队预算规则和告警。

2. Shared Reports
   - 周报/月报。
   - Slack/email/webhook。
   - CSV/JSON/BI export。

3. Gateway Integrations
   - LiteLLM virtual keys / budget / rate limit。
   - OpenRouter BYOK/router。
   - Helicone gateway cost/caching/routing。
   - Anthropic Enterprise-only Spend Limits API 可作为 provider policy 读取/设置来源之一。
   - scry 只做可视化和审计，不托管 gateway 密钥。

验收：

- 团队能看到 project/owner/workflow 维度成本。
- 强预算通过外部 gateway、virtual key/rate limit、SDK/hook/permission 或 provider 原生 spend policy 完成；usage/cost reporting API 只做事后对账。
- scry 仍可本地运行。

## P4 / Enterprise

目标：合规、审计、治理。

范围：

1. SSO / Managed Policy
2. Audit Log
3. Data Retention Controls
4. Redaction Policy
5. On-prem / Self-hosted Sync
6. Provider Contract Pricing
7. Chargeback / Showback

验收：

- 管理员可证明数据来源、访问边界、保留策略和预算策略。
- 支持合同价导入，不依赖公开模型价格。

## 不做清单

MVP 不做：

- 不要求真实账单/admin key。
- 不托管 provider API key。
- 不做自动跨 provider 路由。
- 不默认 stop agent。
- 不承诺成本与发票一致。
- 不做 SaaS 云同步。

Beta 前不做：

- 不接 Google Cloud Billing export，除非先关闭 Gemini organization cost open question。
- 不发布团队定价。
- 不做多租户权限系统。

## 决策闸门

| 闸门 | 进入条件 | 退出条件 |
| --- | --- | --- |
| MVP → Beta | Claude 本地解释体验成立，用户能持续发现浪费。 | 至少一个官方 telemetry 或账单 connector 与 SDK 估算完成 reconciliation。 |
| Beta → Personal Pro | 多来源账本稳定，价格表可版本化。 | 用户愿意为历史趋势/预算/报告付费。 |
| Personal → Team | 有多个用户/项目的真实需求。 | 团队预算和 report 被验证，而不是个人面板硬扩。 |
| Team → Enterprise | 有安全/合规/SSO/审计需求。 | 明确数据边界和部署模型。 |
