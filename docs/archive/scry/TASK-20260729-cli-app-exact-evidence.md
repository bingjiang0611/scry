# TASK-20260729-cli-app-exact-evidence — CLI 与 Scry 逐字段一致并保留完整对话

> 本文档由 vibe-workflow 自动生成和维护，记录任务从摄入到交付的全过程。

## 基本信息

| 字段 | 值 |
|------|-----|
| 任务 | 修复 Codex turn recorder，使 CLI record 与同轮 Scry archive 逐字段一致，并准确保存用户输入与模型输出用于需求复盘 |
| 项目 | scry |
| 级别 | full |
| 开始时间 | 2026-07-29 22:29 CST |
| 状态 | 已完成 |

## 已否决方案与理由（持续追加，跨 Phase 不清空）

| # | 否决的方案 | 为什么否决（实测 / 约束 / 事故 / 成本） | 记录于 | 日期 |
|---|-----------|----------------------------------------|--------|------|
| 1 | 只让 CLI 聚合结果“看起来接近” Scry 总览 | 上一版合成 fixture 通过，但真实两轮仍出现调用、错误、Hook、diff 与文本证据漂移；需求复盘要求同一轮可逐字段校验 | P0 | 2026-07-29 |
| 2 | 用零值、推断值或模糊匹配填补原始证据缺口 | 观测系统不能把未知伪装成权威事实；并发/重复调用下模糊匹配会误归属 | P0 | 2026-07-29 |
| 3 | 为 managed 模式同时迁移 daemon protocol v2 | UserPromptSubmit 与异步 observer 是两条传输链，双栈仍有旧 daemon 读取新 open 的窗口；managed 只走 pinned direct CLI 更小、更可证 | P2 | 2026-07-29 |
| 4 | canonical commit 只接受 Stop 后的 closing 状态 | App completion 与 Stop 无固定先后；只接受 closing 会把合法的 App-first 时序误判为失败 | P2 | 2026-07-29 |
| 5 | CLI record 先提交、archive 后补或两端失败后自动用 rollout 恢复 | 前者能形成永久单边权威记录，后者重新引入近似数据；固定 archive → durable handoff → CLI commit，并且 recovery 只重放 handoff | P2 | 2026-07-29 |
| 6 | 无条件把所有 `text` 与 `text_delta` 相加 | 跨 Provider 可能同时发 delta 和最终 snapshot，直接相加会重复模型输出；按同一消息/流去重，且 managed 范围仅限 Codex | P2 | 2026-07-29 |

## Phase 1 · 理解

- **Prior Art Check**: existing — App 在 `src/main/index.ts` 通过
  `aggregateTurnEvidence()` 写 archive；CLI 在
  `src/core/turn-recorder/recorder.ts` 独立解析 lifecycle + Codex rollout 后再调用同一
  aggregate。用户已明确要求扩展既有 recorder，不另建统计口径。
- **调研核心结论**:
  - 真实失败并非单个 parser bug：第二轮多出的 6 次调用来自协作工具映射差异，13 个
    假错误来自并行结果错误扩散，279 个 orphan 来自子 Agent hook turn ID 与根会话冲突。
  - Scry archive 的 Codex 原生 Hook 运行结果与该轮单一 Git diff 快照不在 rollout
    中；两条独立采集路径无法靠推断保证逐字段一致。
  - `aggregateTurnEvidence()` 只接受 `model/text`，而 Codex App 产生
    `model/text_delta`，导致 archive 与 CLI 都把实际存在的模型输出标成 partial。
  - `errors` 当前把 Hook failure 再次计入普通错误，与 Scry 总览“工具错误 / Hook
    错误分列”的语义不一致。
  - 验收脚本会比较 11 类 evidence；现有测试缺少真实 `input_text + exit_code`、
    完整 collaboration 序列及 Stop 后文本三类反例。
- **子 Agent 原始结论与取舍**:
  - Explore A：共同根因是 CLI 在 Stop 时自行重建 rollout 语义，已与 app-server
    权威事件源分叉。`[采纳→否决继续堆 parser 特判]`
  - Explore B：严格一致必须让 App 把最终 archive `turnEvidence` 交给 CLI/共享终结桥；
    Hook 与 diff 不得推断。`[采纳→作为方案核心]`
  - Explore C：验收覆盖 11 类证据，但缺三类真实反例。`[采纳→补回归与强化验收]`
- **充分性闸门**: verdict=pass — 写入点/读取点、公共 schema、实际 recorder 配置、
  Provider 环境、上传触发、热路径和外部验收契约共 7 项已齐，缺 0 项。
- **实际配置**: 测试工作区 `capture.prompt/assistant/diff/hooks=true`，
  `repositories.mode=discover-nested-git`；本修复不能依赖关闭字段来获得表面一致。
- **关键决策输入**: Scry-managed turn 在生命周期 hook 中只保持 open state，不在
  Stop 时用 rollout 抢先提交；App 在 Provider 结果、Hook 和 diff 全部收齐后，以同一
  evidence 原子提交 CLI record。独立终端 turn 保持原有 fallback。

## Phase 2 · 方案

- **方案文档**：`docs/rfc/scry/cli-app-exact-evidence-gap.md`
- **主方案**：Scry-managed Codex 的 pinned direct CLI 只建立 managed open identity；
  App 从 `runState.items` 生成唯一 `TurnEvidence`，按 archive → durable handoff →
  `AgentTurnRecord` 的顺序幂等提交。standalone recorder / daemon v1 不变。
- **状态机闭合**：
  - canonical commit 同时接受 `open` / `closing`，覆盖 App-first 与 Stop-first；
  - managed 后续生命周期不聚合、不记 orphan，Stop 只自动唤醒 uploader；
  - archive 和 CLI 成功之前不向 UI 发 `agent:turnDone`，正常路径禁止下一轮覆盖旧
    `open.json`；
  - recovery 只重放持久化 canonical handoff；旧 open 无 exact evidence 时隔离并
    报 degraded，绝不以 rollout 近似终结。
- **精确合同**：
  - user = Scry 实际提交的 `displayPrompt` 原文；
  - assistant = 根/子 Agent 所有可见 text/text_delta，保持事件顺序，排除 thinking，
    同消息 delta/final 去重；
  - 普通 error 与 Overview 共用 `tool_result && isError` selector；Hook failure 只在
    hooks；
  - archive/CLI 复用同一 result timing；
  - recorder 严格 capture 配置不满足时 fail closed，不把字段改成 disabled 后冒充一致。
- **唯一 critic**：指出 7 个缺口；采纳快速下一轮竞态、App/Stop 双向竞态、持久化
  handoff、Overview oracle、文本去重、capture 冲突及旧 daemon 迁移问题。其建议的
  direct-only managed 传输被采用。快速复核又指出 archive→handoff 崩溃窗口；已改为
  trusted App coordinator journal + recorder handoff 的 `prepared` /
  `archive_committed` 两阶段协议，至此 critic 的最后一个阻断项解除。
- **检查点**：用户本轮已明确要求“修复”并指定真实验收，等价于批准进入实施；无待选
  产品问题。

## Phase 3 · 代码 & CR 循环

- **唯一 canonical evidence**：
  - `aggregateTurnEvidence()` 现在收集 `model/text` 与 `model/text_delta`，按消息/Agent
    流去重最终 snapshot，保存用户输入、完整可见模型输出及 SHA-256；
  - 普通 errors 与 Overview 共用
    `stage == tool_result && isError == true` selector，Hook/runtime 错误不再混入；
  - live trace 合并不再吞掉同流不同内容的最终文本。
- **managed recorder 状态机**：
  - Scry 启动的 Codex 只由 pinned direct CLI 建立 managed open identity，Stop 及其他
    lifecycle 不再独立重建正式 record；
  - App 以同一个 `TraceArchiveTurn.turnEvidence` 执行
    prepare → archive → CLI commit；journal、handoff、open、duplicate 与 recovery
    都按完整 canonical payload 校验；
  - 同一 `providerTurnId` 即使换本地 `runId` 也只保留一个 archive/record；payload
    冲突、旧 open、分叉 journal 一律 pending/quarantine，不写单边权威数据；
  - Provider 完成后先保存 progress snapshot，等待 diff 或进程异常时仍保留精确
    user/assistant/calls/status/timing；恢复不从 rollout 猜造。
- **身份与终态**：
  - archive 与 CLI 强制共用 `providerTurnId`、`status`、
    `startedAt/completedAt/durationMs`；
  - Codex 原生 terminal status 优先于本地 interrupt 标记，修复 stop/completed 竞态；
  - 正常提交、progress 恢复、journal 重放均在任何写入前做相同强断言和 fingerprint
    校验。
- **版本握手**：
  - recorder 升至 `0.2.6`；
  - Scry 在启动 Codex 前要求 pinned `scry --version == 0.2.6`，rate-native hook 在
    调用 `recorder hook --managed` 前再次校验，不允许旧 CLI 回退。
- **CR 闭环**：
  - 两轮独立 critic 先后发现原生 status 优先级、archive/CLI metadata 分叉以及
    journal recovery 绕过断言；均已修复并补负例；
  - 最终复核结论 `No blocker`。

## Phase 4 · 验证

- **L1 静态 oracle**：
  - `npm test`：609 passed，3 skipped；首次沙箱运行仅 6 个 Unix socket 用例因
    `EPERM` 失败，在允许本地 socket 的同代码环境重跑后 6/6 通过；
  - `npm run typecheck`：通过；
  - `npm run build`（含 `build:cli` 与 Electron renderer/main/preload）：通过；
  - `git diff --check`：通过；
  - rate-native managed bridge：5 tests passed；
  - `verify_local_session.py --self-test`：PASS，覆盖具体类型、路径占位、双边同错、
    raw items 反算和错误 selector 反例。
- **L2 隔离运行时**：
  - 最新构建由 `test_scry_app.mjs` 启动，launchId
    `5bd7d4af-7f66-4eba-ad07-05d1896b2954`、PID `85038`、CDP `61924`；
  - userData 为
    `/private/tmp/validate-scry-rate-workflow-wZysub/scry-test-user-data`，未读取或操作
    `/Applications/Scry.app`；
  - 真实 Electron 窗口选择 treehouse
    `/Users/baobingjiang/.treehouse/rate-native-84202e/1/rate-native` 与 Codex
    `26.721.81911 (app)`，运行前 `scry doctor` / `scry turns verify` 健康且 records=0。
- **L3 两轮真实用户路径（用户收窄后的 local-equality profile）**：
  - 同一 session `019faf07-c195-7342-8f37-790f06dae4bc` 依次发送精确文本
    `/rate-workflow 84441907`、`确认 写技术方案前停下`，两轮均由 Provider 报
    `completed`，没有第三条输入；
  - 第一轮 Aone `coop` MCP 被权限页
    `alilang.alibaba-inc.com/portal/nopermision.htm` 阻塞，Agent 如实停止在 Phase 0；
    用户已明确不验仪表盘，且 Aone clone 外部不可用，因此按 skill 的
    `--local-equality-only` profile 使用固定源 ID，不冒充完整 A+B+C 工作流 PASS；
  - 严格报告
    `/private/tmp/validate-scry-rate-workflow-wZysub/local-equality-report.json`：
    `ok=true`、82 checks、0 failures、28 个逐轮 parity checks 全通过；
  - recordId：
    `d46cd3bd4b39a4bbe53f4c58796b52b4`、
    `a1d986bb70d66080b416cfac92feae5c`；
  - 两轮 assistant 原文分别与 raw items 反算结果及 CLI 完全相等，hash：
    `sha256:d7e519b88d52106a681b0566d8aab112052000dbb618ca4c30703a0c003f1a1a`、
    `sha256:333fd23e7150aa1969b0b2f810fda9f83a3b2a5711fef9e5dde4a923845d42ec`；
  - Browser/CDP 录制：
    `/Users/baobingjiang/.config/browser-harness/agent-workspace/recordings/validate-scry-local-equality-20260730`
    （13 frames）。
- **未覆盖**：按用户最新范围未检查上传健康与远端仪表盘；Aone clone 因权限阻塞未做。

## 交付摘要

- Scry-managed Codex 的 archive 与 CLI record 不再由两套采集器各自重建，而是共享
  一份 canonical `TurnEvidence` 和同一组 Provider metadata。
- 用户输入与完整可见模型输出均保存 exact 原文 + SHA-256，并由 archive raw items
  独立反算校验。
- 任何已知冲突、旧版本、单边提交或 recovery 分叉都 fail closed；正常两轮真实验收
  达到本地一致性 `LOCAL_EQUALITY_PASS`。
- rate-native 配套提交：
  `918e532 fix: bridge Scry-managed Codex turn records`、
  `075092b fix: require matching Scry recorder version`。

## 复盘

- 观测系统的“一致”不能靠两份 JSON 最终恰好相等证明；必须从同一 canonical
  evidence 写两端，再用 raw items 反算防止“两边一起错”。
- Provider 原生 session/turn/status/timing 是身份与终态事实，本地 UI stop 标记只能是
  fallback，不能覆盖原生 completed/failed。
- recovery 必须和实时提交执行同一断言；否则旧 journal 正是绕过新门禁的入口。
- 当前 durability 合同覆盖进程崩溃恢复，不声称覆盖机器掉电：`writeJsonAtomic` 会
  fsync 临时文件后 rename，但未 fsync 父目录。另在 Provider 已完成、diff 尚未完成的
  崩溃窗口，恢复会保留精确对话/调用/状态/时间，并把 diff 明确标为 unavailable；
  它仍保证 archive/CLI 一致且不伪造零值，但不承诺该窗口的 diff 完整性。
