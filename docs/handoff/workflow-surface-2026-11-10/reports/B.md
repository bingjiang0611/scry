# B：真实事件核对（Q1–Q11）

**状态：阻塞。** 不是代码问题，是这台机器上唯一的 Claude 通道（公司网关）当前对全部 Claude 模型返回 429“模型提供方限流”。拿到可用模型后立即按本文件的计划开跑，并在此文件补 Q1–Q11 的逐条答案。

## 阻塞证据

| 项 | 值 |
|---|---|
| 观测窗口 | 2026-11-10T09:30:12Z – 2026-11-10T10:17:54Z（每 90 秒一轮，2 个可用模型名） |
| 请求 | 公司内部 Anthropic 兼容网关的 Messages 接口（地址属内部信息，见本机 `.claude/company-context.local.md`，已由审查方从公开仓库中移除），凭据取自 `~/.claude/settings.json` 中已配置的同一渠道，验证实例不改用户设置 |
| 结果 | 66 次请求全部 429（网关错误码 429），`detailMessage`：“该模型当前资源紧张，请稍后重试，或者更换模型使用” |
| 探针日志 | `/tmp/scry-wf/probe/probe.log`（本机临时文件，不提交） |

模型名枚举（同端点、同 key）：

| 模型 | 响应 |
|---|---|
| `claude-sonnet-4-6` | 429 限流（存在，无容量） |
| `claude-opus-4-6` | 429 限流（存在，无容量） |
| `claude-opus-4-5` | 403（网关鉴权错误），上游 “Authentication failed: Please make sure your API Key is valid” |
| `claude-sonnet-4-20250514` | 404 上游 “This model version has reached the end of its life” |
| `claude-sonnet-4-5` / `claude-haiku-4-5` / `claude-opus-4-1` / `claude-3-7-sonnet-20250219` | 400 模型不存在 |
| `qwen3-coder-plus`（`~/.claude/settings.json` 里配置的模型） | 404 模型已下架 |

也就是说：配置里的模型已下架，能用的两个 Claude 模型没有容量，其余名称要么不存在要么上游鉴权/生命周期失效。

补充排查（都排除了，没有绕过手段）：

- 本机没有 Anthropic 官方凭据：`~/.claude/.credentials.json` 不存在，Keychain 无 `Claude Code-credentials`，`~/.claude.json` 无 `oauthAccount`/`primaryApiKey`，环境里没有 `ANTHROPIC_*`。
- `~/.claude/projects/` 只有本次临时工作区一个目录，`grep workflow_progress` 无命中：本机没有任何历史真实 workflow 运行可以拿来做 B4 夹具。
- 日常 Scry 实例最近的 usage 记录全部是 `providerId: pi`，没有 Claude 吞吐可以借用。

## 已准备好的东西（等模型可用即可执行）

| 工具 | 用途 |
|---|---|
| `/tmp/scry-wf/harness.mjs` | 独立 test 实例：临时 userData、临时工作区、`SCRY_TEST_APP=1`、`SCRY_PROVIDER_EVENT_LOG=1`、远程调试端口、`SCRY_CLAUDE_PATH` 指向 shim（本机 EDR 会 SIGKILL 直接拉起的 claude，见 reports/A.md） |
| `/tmp/scry-wf/driver.mjs` | 真实指针驱动（`scripts/app-driving.mjs`）：选工作区、输入、发送、等待落定 |
| `/tmp/scry-wf/real-run.mjs` | S1/S2 场景运行器：点击审批、导出面板 JSON、截图、复制 provider 事件日志 |
| `scripts/workflow-wire-modules.mjs` | 用 Vite 从源码打包生产 `normalizeSdkMessage`、`deriveWorkflowRuns`、`readWorkflowActivity`、`workflowFixtureMessages` |
| `scripts/workflow-wire-compare.mjs` | 逐条对照：native 记录 → 生产归一化 → canonical `harness/workflow_activity`（按完整载荷指纹，含 taskId/seq/activity/rows/rowTotal/omissions/unrecognized/status/usage），折叠投影后逐行对照 Provider 最终快照，可选 `--panel <json>` 对照 DOM；不一致退出 1 |

对照脚本自身的有效性已验证：合成日志 0 处不一致（8 个 canonical 事件、20 行、seq 连续、completed/task_notification）；负对照 1（删掉一个 canonical 事件）失败；负对照 2（翻转最后一份 native 快照里某个 agent 的终态）最初**通过**，说明指纹只比 taskId/seq 不够，已改为全载荷指纹后失败。

## 拿到模型后的执行顺序

1. S1 小型内联 workflow（3 阶段、每文件一个只读 agent、一个汇总 agent）→ Q1–Q7、Q10、Q11。
2. S2 触发方式：`ultracode:` 与自然语言各一次 → Q8。
3. S3 运行中按 App 停止按钮 → Q2、Q5；S4 让某个 agent 必然失败 → 行 error 状态。
4. S5 20+ agent → Q7 分片与上限；S6 按名称运行 + `/deep-research` → Q9；S7 同会话两次运行 → 运行选择器。
5. 每个场景：`scripts/workflow-wire-compare.mjs` 逐条对照 + 面板 JSON 对照，脱敏真实摘录存 `src/main/workflow-wire-fixtures/`（每个 < 20,000 字节），配回放测试。
6. 真实格式与代码不符就改 `src/shared/claude-workflow.ts`、`src/main/normalize-workflow.ts`、`src/renderer/workflow-runs.ts`，每处配“先失败后通过”的测试，并更新 `claude-workflow.ts` 文件头的实测证据说明。

如果网关恢复后仍然拿不到 `workflow_progress`（设计层面的不符），按 W.md B5 处理：保留任务级状态与用量、面板显示 unavailable、把“还能从哪里拿到明细”写成设计说明，不实现读取 Provider 私有文件的路径。

## 需要维护者决定

- 是否为本机提供可用 Claude 通道（官方 API key、恢复网关容量，或指定其他合规模型）。在此之前 B、以及依赖 B 的 C 和 E2/E3 无法完成真实核对。
- 期间已完成：A、D、E1，见对应报告。
