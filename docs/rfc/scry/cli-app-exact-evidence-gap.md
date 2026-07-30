# Scry App / CLI 精确证据闭合方案

## 1. 现状描述

同一轮 Scry-managed Codex 会话当前存在两条独立终结链：

```text
Codex app-server events
  → src/main/providers/codex.ts
  → runState.items
  → aggregateTurnEvidence()
  → trace archive / Scry UI

Codex lifecycle hooks + rollout JSONL
  → src/core/turn-recorder/recorder.ts
  → 独立归属、展开、Git snapshot
  → aggregateTurnEvidence()
  → workspace/.scry/records
```

两条链虽然共享 `TraceEvent`、`logicalCallEventsForTurn()` 与
`aggregateTurnEvidence()`，但原始证据不同：

- App 能看到 app-server 原生 Hook started/completed、子 Agent 归属和本轮唯一 diff。
- CLI rollout 不包含原生 Hook 运行结果；CLI 又单独在 Stop 时做 Git snapshot。
- App 的 Codex 文本是 `model/text_delta`，聚合器当前只接受 `model/text`。
- CLI 在 Stop 时允许读取尚未稳定的 rollout，并自行展开 collaboration/code-mode。

真实会话 `019fae06-bd35-7392-8447-f75c3d8de590` 的第二轮因此出现：

- Scry：119 Tool + 3 Skill，CLI：125 Tool + 3 Skill；
- Scry：6 个工具错误 + 10 个 Hook 错误，CLI：13 个假工具错误且 Hook unavailable；
- Scry：1 个 available/exact diff，CLI：12 个仓库快照且 partial；
- 两端都有实际模型输出，但 assistant evidence 都是 partial/空；
- CLI health 累计 279 个 orphan。

## 2. 用户需求复述

用户要求修复 Scry-managed Codex 会话，使 CLI record 与同轮 Scry 数据逐字段一致；
用户输入和模型输出必须完整、精确保存，后续作为需求复盘证据，不能用推断值、零值或
“采集器不同”解释差异。修复后必须用 `validate-scry-rate-workflow` 跑全新的 Codex
两轮真实验收。

## 3. Delta 识别

1. **权威源分叉**：同一轮的 archive 与 CLI record 分别终结，Hook 和 diff 天生无法
   独立重建为同一份事实。
2. **文本漏记**：`text_delta` 未进入 assistant evidence；缺少 exact text/hash 门禁。
3. **错误重复**：Hook failure 同时进入 `hooks` 与普通 `errors`，不符合 Scry 总览分列
   语义。
4. **提交竞态**：Stop hook 先于 App 的最终 Hook/result/diff 完成；CLI 若在 Stop
   立即提交并触发 uploader，会把不完整记录永久上传。
5. **守护进程兼容**：旧 recorder daemon 只按 protocol v1 ACK，可能吞掉新版 managed
   语义。
6. **失败语义**：App 崩溃或 canonical commit 失败时，当前 recovery 会自动把近似
   rollout 当成完成记录；这违反“宁缺勿错”。
7. **验收缺口**：现有校验只比较两端 assistant 是否相等，没有强制它们必须
   `available/exact` 且 text/hash 自洽，也没有比较与 Scry UI 相同的轮次 duration。

## 4. 闭合选项

### Delta 1–4：同一轮唯一终结

- **方案 A（推荐）— Scry-managed canonical commit**
  Scry 启动 Provider 时注入内部标记。CLI lifecycle hook 仍负责创建 open turn、
  保存 session/generation/turnIndex；managed 后续 lifecycle 不再交给 recorder 聚合。
  App 等 Provider result、全部 Hook 和唯一 diff 收齐后，生成一次 `TurnEvidence`，
  通过两阶段 handoff 同时写 archive 与 CLI record。Stop 只唤醒 uploader，uploader
  等待该 session 的 managed open / handoff 完成后再次导出。
  代价：Scry 约改 5 个实现/测试模块；rate-native uploader/hook 约改 2 个模块。
  `AgentTurnRecord v1` 不变。
- **方案 B—继续补 rollout parser 特判**
  可修当前 collaboration/exit-code 个案，但 rollout 永远没有 App Hook 结果，独立 Git
  snapshot 也不能保证同一时点；无法满足逐字段一致。约改 2 个 parser 模块，但目标
  不可达。
- **方案 C—CLI 先上传，App 事后覆盖 record**
  本地文件可以重写，但 uploader 以 sequence snapshot 建 outbox，远端同 recordId
  会 duplicated/conflicted；存在永久脏数据窗口。约改 3–4 个存储/上传模块，仍不可靠。

### Delta 2–3：对话与错误语义

- **方案 A（推荐）**：
  - assistant 按事件顺序拼接 `model/text` 与 `model/text_delta` 的原始文本字节，不插入
    推断内容；对最终字符串计算 SHA-256。
  - user 继续使用 Scry 实际提交的 `displayPrompt`，保存 exact text/hash。
  - 普通 `errors` 只取总览同口径的 `stage=tool_result && isError`；Hook failure 只在
    `hooks` 中计数，harness/runtime error 只影响轮次状态。
  代价：共享 aggregate 与定向测试各 1 处。
- **方案 B**：只保存最终回答。会丢失对需求复盘有价值的阶段性模型输出，且 App 当前
  事件流包含多条 commentary/子 Agent 输出，无法证明“模型输出完整”。

### Delta 5：managed 传输隔离

- **方案 A（推荐）— managed 边界只走 pinned direct CLI**：仅 Codex Provider 注入
  `SCRY_RECORDER_MANAGED=1`。`UserPromptSubmit` 检测到该标记后绕过 daemon，使用
  `SCRY_CLI_PATH` 直接执行一次 `recorder hook --managed` 建立身份；异步 observer
  对这轮后续生命周期不再投递 recorder，只保留 Stop 自动唤醒 uploader。standalone
  recorder 与 daemon 全部继续使用 protocol v1。代价：bridge、observer queue 及测试。
- **方案 B—protocol v2 双栈**：可以区分 managed 请求，但 rate-native 的直接 bridge
  与异步 observer queue 是两条传输路径，仍需同时迁移；旧 daemon 重启窗口还可能读取
  带新字段的 `open.json` 并按旧逻辑近似提交。比 direct 隔离更重且风险更高，否决。
- **方案 C—沿用 v1 只看 package version**：旧 daemon 会继续 ACK 新请求，Scry
  无法确认实际执行者支持 managed 语义，否决。

### Delta 6：失败时宁缺勿错

- **方案 A（推荐）**：managed turn 不由通用 recovery 自动近似提交；App canonical
  commit 失败时保留分阶段 handoff 并让 `scry doctor` 明确 degraded。通用 recovery
  只允许提交已经标为 `archive_committed` 的 handoff；`prepared` 必须由 App 完成
  archive 后推进。代价：recorder recovery 分支、App coordinator 和测试。
- **方案 B**：超时后自动回退 rollout。可提高“有记录”比例，但会重新引入本任务明确
  禁止的假 exact，否决。

### Delta 7：验收硬门禁

- **方案 A（推荐）**：
  - 强制两轮 archive 与 CLI 的 user/assistant 都是 `available/exact`；
  - 校验 `textHash == sha256(text)` 且文本非空；
  - archive 保存与 Scry result 相同的 `startedAt/completedAt/durationMs`，CLI metadata
    复用同一 timing，校验器比较三项；
  - 继续逐字段比较其余 9 类 evidence。
  代价：验证脚本、契约文档和 fixture 3 处。

## 5. 推荐方案 + 回问清单

采用所有推荐方案 A。范围明确限制为 **Scry 启动的 Codex Provider**；Qoder、
opencode、Claude 与独立终端继续使用既有 recorder 路径。

```text
UserPromptSubmit
  → pinned direct CLI open turn (managed=true)
  → managed observer 不向 daemon 投递工具/Hook/Stop
  → Stop 只自动启动 uploader；uploader 先上传已提交记录，再有限等待本轮

Scry app-server turn 完成
  → result + hooks + diff 全部收齐
  → aggregateTurnEvidence 一次
  → 写 prepared coordinator journal + recorder handoff
  → 写 trace archive（失败则保留 prepared）
  → handoff 原子推进为 archive_committed
  → 幂等提交 AgentTurnRecord v1
  → 清除 managed open / handoff
  → 此后才向 UI 发送 agent:turnDone
```

公共兼容边界：

- 不升级 `AgentTurnRecord.schemaVersion`，只改变 Scry-managed 新记录的证据来源；
- 老记录不重写，独立终端会话继续使用 lifecycle + rollout fallback；
- daemon 继续只使用 protocol v1；managed 模式不让旧/新 daemon 接触本轮 open state；
- managed 严格模式要求 `prompt=true`、`assistant=true`、`toolOutput=summary`、
  `hooks=true`、`diff=true`。配置不满足时不提交合法但不一致的 record，并在 health /
  App 错误中明确暴露；
- managed commit 失败时 fail closed，保留含 canonical evidence 的 pending handoff，
  不上传近似记录；`recover` 只能幂等重放该 handoff，禁止回退 rollout。

### 5.1 双向竞态状态机

`App completion` 与 Provider 的 `Stop` 没有可靠先后关系，因此 canonical commit
不得依赖 `closing`：

| 当前状态 | 输入 | 动作 |
|---|---|---|
| 无 open | managed Start | 创建 `open(managed=true)`，不做独立 Git snapshot |
| managed open | App completion | 接受；prepared → archive → archive_committed → commit → cleanup |
| managed closing | App completion | 与上行相同 |
| managed open/closing | Stop / 工具生命周期 | 不聚合、不提交、不记 orphan；Stop 只触发 uploader |
| 已 commit、无 open | 迟到/重复 Stop | duplicate；仍允许 uploader 导出已提交 record |
| managed open + archive_committed handoff | recover / 新 Start | 仅重放 exact handoff；成功后再开始下一轮 |
| managed open + prepared handoff | App 启动 / 新 managed run | 用可信 App coordinator journal 幂等补写 archive，再推进 handoff |
| managed open、无 handoff | 新 Start | 将旧轮隔离为 degraded pending，绝不近似终结；创建新 generation |
| pre-managed legacy open | managed Start | 隔离旧 open 并报告迁移 pending；绝不由 managed Start 触发近似提交 |

正常 UI 路径采用最小门禁：有 recorder 配置且 managed strict mode 已启动时，archive
与 CLI canonical commit 成功之前不发 `agent:turnDone`。因此用户不能在旧 `open.json`
尚未闭合时从 Scry 发出下一轮。recorder 缺配置或显式禁用时保持原有 App 行为；配置
存在但严格条件不满足或 commit 失败时，UI 收到明确错误并保持本轮未放行。

### 5.2 持久化与恢复顺序

两套存储不能做跨目录原子事务，因此使用可信 App coordinator journal + recorder
handoff 的两阶段协议：

1. App 以 `runState.items` 计算唯一 `TurnEvidence` 与 result timing；
2. 在 Scry `userData` 原子写 `prepared` coordinator journal，保存完整 archive turn
   payload、cwd/session/runId 与 canonical metadata；
3. 在对应 recorder generation 原子写 `prepared` handoff，保存完整
   `AgentTurnRecord` draft 与同一 runId/hash；此状态绝对禁止 `commitRecord()`；
4. 原子写 trace archive并确认成功；
5. coordinator journal 与 recorder handoff 原子推进为 `archive_committed`；
6. `commitRecord()` 幂等提交；成功或 duplicate 后更新 session state，并清理 open /
   recorder handoff / coordinator journal；
7. 才发送 `agent:turnDone`。

Scry App 启动和每次 managed run 前都扫描残留 coordinator journal：`prepared` 状态用
journal 中完整 payload 幂等重写 archive，再推进；`archive_committed` 直接重放 CLI
commit。journal 在调用 `commitRecord()` 前已经持有预期 `recordId`，因此 CLI commit
成功后即使进程在清理前崩溃，重放仍可按 recordId 判定 duplicate。

通用 `recoverRecorder()` 只提交 `archive_committed` recorder handoff；对 `prepared`
只报告 pending，不能自行假设 App archive 已存在，更不能回退 rollout。这样任意崩溃
点都有持久化重放来源，同时保证 CLI 永远不先于 archive。

### 5.3 “完整模型输出”与总览 oracle

- 模型输出定义为本轮 `runState.items` 中所有根 Agent 与子 Agent 的可见
  `model/text` / `model/text_delta` 内容，按事件顺序保留原始字符串；不含隐藏
  thinking/reasoning。CLI 的 `assistant.value.text` 是该内容的无分隔扁平串，archive
  原始 items 保留 Agent/消息边界。
- 同一消息若同时出现流式 delta 与最终完整 text，以 delta 串为准，最终 snapshot
  仅在与 delta 串不相等时作为新的可见内容保留；delta-only、text-only、delta+final、
  根/子 Agent 相邻输出均须有回归测试。
- user 使用 Scry 实际提交的 `displayPrompt` 原文；两端保存非空 exact text 与同一
  SHA-256。
- 普通 errors 的总览 oracle 明确为 `stage=tool_result && isError`；Hook failure 只在
  hooks 中，harness/runtime error 只影响轮次状态，不伪装成工具错误。该 selector 与
  `logicalCallEventsForTurn()` 一样放到共享层，Overview、archive aggregate 和验收脚本
  共同使用。
- timing 取 Overview 实际使用的原生 harness result `ts` 与 `durationMs`；archive turn
  保存 `startedAt/completedAt/durationMs`，CLI metadata 复用同一对象。
- 验收不是只比较两个 JSON：先从 archive raw items 按共享 oracle 重算，再要求
  Overview oracle = archive evidence = CLI record，最后校验文本 hash。

## 6. 实施结果

- managed Codex 已改为 App canonical commit；archive 与 CLI record 复用同一
  `TurnEvidence`，并在实时、progress recovery、journal replay 三条路径统一校验
  `providerTurnId/status/startedAt/completedAt/durationMs`。
- exact user/assistant、delta/final 去重、Overview error selector、Provider status 与
  timing 已落地；同一 Provider turn 的幂等、冲突拒绝、旧 open quarantine 和
  archive-first 两阶段提交均有负例测试。
- recorder 固定为 `0.2.6`；Scry App 与 rate-native managed hook 做双重精确版本握手。
- 真实两轮 local-equality 验收得到 82/82 checks、28/28 parity checks，0 failures。

## 7. 验收范围

用户最终明确收窄为“先不用看仪表盘，只保证 Scry 与 scry CLI 一致”。因此真实验收：

- 使用独立 Scry Test userData 和 treehouse；
- 使用固定源需求 `84441907`，因为 Aone clone/coop MCP 被权限页阻塞；
- 仍严格验证两轮输入、raw items 反算的完整模型输出、Provider metadata 与 11 类
  evidence；
- 不验证上传健康或远端仪表盘，不把结果称为完整 A+B+C 工作流 PASS。

报告：
`/private/tmp/validate-scry-rate-workflow-wZysub/local-equality-report.json`。

## 8. Crash model 与残余边界

- 正常路径已经等待唯一 terminal diff 后再做 archive/CLI 两阶段提交；真实两轮 diff
  都是 `available/exact`。
- Provider 完成后会先写 progress snapshot。若进程恰在等待 diff 时崩溃，恢复保存
  exact user/assistant/calls/status/timing，并把 diff 诚实标为 unavailable；两端仍
  严格相等，不从 rollout 推断或写假零值。
- `writeJsonAtomic` 当前 fsync 临时文件再 rename，足以定义本任务的 process-crash
  recovery，但 rename 后没有 fsync 父目录，所以不声称 power-loss durability。

开放产品问题：无。用户已经明确排除独立近似重建、关闭 capture 获得表面一致和自动
降级提交；上述 crash model 是当前实现边界，不是对缺失证据的伪造豁免。
