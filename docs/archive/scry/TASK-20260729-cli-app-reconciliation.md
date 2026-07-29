# TASK-20260729-cli-app-reconciliation — 修复 Scry CLI 与 App 观测数据不一致

> 本文档由 vibe-workflow 自动生成和维护，记录任务从摄入到交付的全过程。

## 基本信息

| 字段 | 值 |
|------|-----|
| 任务 | 修复 Scry CLI 与 App 在 Codex 会话中的版本、调用分类、错误、Usage、Hook 与 diff 数据不一致 |
| 项目 | scry |
| 级别 | full |
| 开始时间 | 2026-07-29 19:08 |
| 状态 | 已完成 |

## 已否决方案与理由（持续追加，跨 Phase 不清空）

> 任何“考虑过但否决”的技术选择都记在这里，重点记录为什么否决。

| # | 否决的方案 | 为什么否决（实测 / 约束 / 事故 / 成本） | 记录于 | 日期 |
|---|-----------|----------------------------------------|--------|------|
| 1 | 按名称、输入和时间窗口模糊匹配双来源调用 | lifecycle 输入可能被隐私裁剪为空，并行调用会让时间/顺序匹配产生误合并 | P2 | 2026-07-29 |
| 2 | 要求 Codex 上游统一 lifecycle / rollout call ID | 跨 app-server、hook adapter 与 rollout 格式，本仓无法保证，不能修复现有 Provider | P2 | 2026-07-29 |
| 3 | 把 App archive 反灌 CLI | 破坏独立 CLI 契约，引入跨进程和跨存储耦合 | P2 | 2026-07-29 |
| 4 | 从 PATH 中自动选择最高版本 CLI | 偏离显式路径和 shell 解析契约，下游仍可再次绕过 | P2 | 2026-07-29 |
| 5 | 保持 0.2.4 仅重启 daemon | 无法区分修复前后代码，daemon 版本门禁也无法感知更新 | P2 | 2026-07-29 |

## Phase 1 · 理解

- **Prior Art Check**: existing — `src/core/turn-recorder/recorder.ts` 已有
  `mergeTurnTraceEvents()`，`src/main/claude-locate.ts` 已有
  `runtimeCliEnv()` / `SCRY_CLI_PATH` 契约；本任务扩展既有实现，不另建统计口径。
- **调研核心结论**:
  - 产生侧：Codex lifecycle hook 产生 `exec-*` 调用，rollout 持久化同一批
    `call_*` 调用；真实 `Stop` 比 rollout `task_complete` 早约 4–6 秒。
  - 消费侧：App 总览直接聚合原生 `items`；CLI 记录走
    `mergeTurnTraceEvents()` → `aggregateTurnEvidence()`，两者 schema 无需合并。
  - 公共契约：Tool / Skill / MCP 必须互斥；Codex hook runtime 未观测时允许
    `unavailable`，usage 只统计根轮，不能伪造 exact 0。
  - 配置侧：Scry 已固定 `SCRY_CLI_PATH`；rate-native 队列和 uploader 仍从
    `PATH` 查找 `scry`，造成 daemon 0.2.0 与直连 0.2.4 混跑。
- **充分性闸门**: verdict=pass — 必备信息 6 项，缺 0 项。已定位写入与读取两端、
  两仓边界、公共 schema、实际环境变量契约、热路径、旧记录兼容策略。
- **关键发现/疑点**:
  - `mergeTurnTraceEvents()` 只按 toolUseId 去重，无法识别真实双 ID。
  - `parseCodexRollout()` 只在 `task_complete` 才写 usage；真实结束顺序未覆盖。
  - code-mode 结构化结果中的 `exit_code` 未映射到每个展开调用。
  - rollout 的 code-mode `js` 未恢复 `mcp__node_repl__js` 分类。
  - 本次不把 App 原生 hook 统计反灌 CLI；保持 `unavailable` 语义。

## Phase 2 · 方案

- **方案类型**: gap-analysis
- **方案文件**: `docs/rfc/scry/cli-app-reconciliation-gap.md`
- **关键决策**: 稳定且全部调用已完成的 rollout 对逻辑调用具权威性；EOF usage
  使用累计差分；保持 hook unavailable；rate-native 统一执行 pinned CLI 契约；
  recorder 升 0.2.5。
- **Critic 结果**: 4 个漏洞，采纳 3，纠偏 1。权威条件增加完整性守卫；确认
  rate-native canonical repo；补清 usage 累计差分；已有两处 CLI 安装只在验证后激活。
- **开放问题**: 无。旧 0.2.4 记录不原地重写。

## Phase 3 · 代码 & CR 循环

- **Scry 改动**:
  - recorder `0.2.4 → 0.2.5`。
  - 稳定且调用流完整的 Codex rollout 作为逻辑调用权威源；未完整时保留
    lifecycle 尾部证据。
  - 补齐 tuple-map、逐项结果、namespace MCP、绝对插件 Skill、EOF usage 累计差分。
  - 把异步 `wait` / `write_stdin` 结果按 cell/session ID 关联回原始 code-mode
    逻辑调用，避免把 `Script running` 当完成。
- **rate-native 改动**:
  - 观察队列在 job 入队时快照 `SCRY_CLI_PATH`，worker 与 uploader 只执行 pinned
    可执行文件；变量存在但路径失效时 fail-open，不回退被改写的 `PATH`。
- **回归测试**:
  - recorder 新增双 ID 去重、未完整调用守卫、早 Stop、tuple-map、逐项错误、
    namespace、Skill、usage、异步 cell 关联测试。
  - rate-native 新增 pinned 路径、worker PATH 漂移、失效路径不 fallback 测试。
- **评审循环**:
  - Round 1：发现异步 code-mode 尾部错误未关联，1 个 blocker，已修复。
  - Round 2：发现 `write_stdin.session_id` 可能为数字，1 个边界问题，已修复。
  - Round 3：blockers=0，`git diff --check` 两仓均通过。
- **提交**:
  - Scry `e9a0f5b9c866` — `fix(recorder): reconcile Codex CLI evidence`
  - rate-native `f0ec08eb0af8` — `fix(scry): pin recorder cli across async queue`

## Phase 4 · 验证

- **L1 静态 oracle**:
  - `npm run typecheck` PASS。
  - `npm test`：54 个测试文件通过，584 个测试通过，3 个显式跳过。
  - `npm run build` PASS；`git diff --check` PASS。
  - rate-native 两个定向 smoke PASS；`four-agent-validation quick` 8/8 PASS。
- **L2 运行时 smoke**:
  - 在隔离 HOME/CODEX_HOME 启动真实 Scry Electron，management preflight
    `accepted=true`；Claude/Codex 管理能力 off→false→on→true 均通过，fixture MCP
    精确 3 tools；随后只停止本 run 拥有的 PID。
  - 本机两处既有 CLI prefix 均更新到 `0.2.5`；真实 treehouse workspace
    `doctor healthy=true`，2 条旧记录可读，0 dropped / 0 orphan / 0 pending。
  - 新 daemon PID 39827，NVM 旧入口权威回读 `recorderVersion=0.2.5`、errorCount=0。
- **L3 真实用户路径**:
  - 用原始 1.64 MB Codex rollout 在隔离 recorder workspace 重放同一 session 两轮。
    T1 为 42 Tool + 4 MCP + 2 Skill、1 error；T2 为 87 Tool + 20 MCP + 7 Skill、
    7 errors。
  - 合计 162 次调用、8 个错误、input 13,556,436、output 35,540、
    cache read 13,193,216、cache write 0；逐项与 Scry App 总览一致。
  - Hook 继续按公开契约为 `unavailable`，没有伪造为 0。
- **未覆盖项**:
  - `four-agent-validation runtime` 因会把隔离 rate-native 项目指令发送给四个外部
    Agent 服务，权限审查要求用户额外明确授权，状态为 BLOCKED；没有绕过。
  - 完整四 Provider 40-turn 模型回归未获授权，未执行；仅完成无模型 preflight。
- **结果**: 本次 CLI/App 对账修复达到 L3；上述两项外部模型验证不计为通过。

## 交付摘要

- **最终状态**: 已完成
- **完成时间**: 2026-07-29 20:00
- **分支**:
  - Scry `codex/fix-cli-app-reconciliation`
  - rate-native `codex/fix-scry-cli-path`
- **提交**: `e9a0f5b9c866`、`f0ec08eb0af8`
- **总耗时**: 约 52 分钟

## 复盘

- **最浪费时间**: 待用户反馈；执行侧观察是必须用真实 rollout 才暴露异步
  `Script running → wait` 的第 8 个错误，纯合成 fixture 不足以证明对账。
- **无用的子 agent**: 待用户反馈。
- **晋升的教训**: 暂不晋升。现有真实 fixture 与回归测试已把规则固化，尚不满足
  “需要新增 hook”的三项条件。
