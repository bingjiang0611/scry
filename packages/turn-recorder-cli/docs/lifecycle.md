# 轮次生命周期与版本记录

[返回 CLI README](../README.md)

## 0.2.51 CLI 重复工作消除与 Pi 终态修复

- 完整 Git discovery 确认零候选时复用既有快照；相同 tree 不再重复 diff，不减少仓库检查范围。
- 会话汇总按 record 对象一次分组，避免重复关联工具调用；`turns verify` 复用同一批已校验记录计算身份覆盖，仍完整扫描 canonical 文件。
- Pi 模型失败和取消分别保留为 failed/cancelled；成功重试不会继承旧失败。错误信息有界保存，截断明确标 partial，不修改历史记录。
- 保留 0.2.50 的独立 ACK 游标与原有 trust、at-least-once 合同。未提供会话选择性读取或历史缺号修复。

## 0.2.50 按通知身份隔离 ACK

- 每个 hook fingerprint 的 ACK 单独保存在 `.scry/notifications/commit-hooks/<sha256>.json`，不同 App / CLI 身份不会互相覆盖。
- 旧 `commit-hook-state.json` 只读保留，旧 App 可以继续使用它。同一指纹的有效旧 ACK 与新文件取较大值，并在下次投递时持久迁移；只读查询不迁移，不同指纹绝不借用 ACK。
- 每个曾确认投递的身份保留一个小文件，不自动删除历史游标；读取只定位当前身份，不扫描历史身份目录。bundle 变化仍需新身份独立 ACK。
- 失败日志区分启动失败、退出码、信号、stdin 与超时，不保存原始 stderr。ACK 表示回调成功接收，不等于外部上传成功。
- 降级到旧 CLI 不会理解这些独立游标，可能再次重放；消费者仍须遵守既有 at-least-once 去重合同。

## 0.2.49 锁超时排队修正

- **hook 等锁上限从 10s 改为 3s**（`HOOK_LOCK_WAIT_MS`）。0.2.48 的等待与 Provider 工具 hook 的 10s 超时相同，宿主可能在事件入队前就杀掉 hook；现在 3s 后即写入 `inbox/`。`recover` 与 managed 路径仍等待 10s（`SESSION_LOCK_WAIT_MS`）。
- **重放沿用真实到达时间**：0.2.48 把入队时刻（等锁结束后）当作到达时间，重放出的工具 / 轮次开始时间会晚约一个等锁周期；现在取 hook 进入时的时间。

## 0.2.48 完整性修复（模型 / Context / 锁超时 / guardian）

只作用于之后生成的新记录，不改历史文件、recordId 或 outbox。

- **Codex 模型与 Context**：rollout 的 `turn_context.model` 与 `token_count.info.model_context_window` 现在进入用量证据。一轮只有一个模型时写 `usage.value.model`（`provider.modelStatus=observed`、`modelSource=usage_event`）；同时有窗口和本轮最后一次请求的 `last_token_usage.input_tokens` 时写 `contextTokens`/`contextWindow`（`contextUsageSource=codex_rollout_last_usage`）。一轮出现多个模型时不挑选，模型与 Context 都留空。
- **lifecycle `context_usage` 入参**：`{ context_tokens, context_window, model, provider? }`，由集成层在轮次结束时读取宿主自己的 Context 计量。三个必填值都合法才写入（`contextUsageSource=lifecycle_context_usage`），缺任何一项整体丢弃，不用猜测的窗口配对。子代理上下文不归入主轮。
- **锁超时不再丢事件**：session 锁或维护门在 10s 内拿不到时，事件持久写入 `runtime/<provider>/<session>/inbox/`，hook 返回 `pending`；下一个持锁的 hook 或 `recover` 按到达顺序重放，并沿用原到达时间。旧实现直接计入 `droppedEvents`。重放是至少一次语义，依赖既有事件 id / start 指纹去重；重放本身失败仍计入 `droppedEvents`。
- **Codex guardian 子代理**：guardian 复用父 `session_id` 且没有 `agent_id`。Scry 读取 `transcript_path` 指向的 rollout 首行 `session_meta.source.subagent` 识别它：其 prompt 归入当前父轮，不再顶替父轮（旧实现会提前结束父轮并让后续父轮事件成为 orphan）；没有打开的父轮时忽略。识别标记是 recorder 内部字段，入参中的同名字段会被剔除。

## 0.2.42 模型可观测性、Hook 覆盖率与回合角色

新记录显式说明「为什么这里是空的」，只作用于之后生成的记录，不改历史文件、recordId 或 outbox：

- `provider.modelStatus`：`observed` / `unobserved` / `incomplete` / `conflict`，配 `modelSource`（`provider_model_event` 或 `usage_event`）与 `modelOmissionReason`。旧行为是三种不同原因都静默省略 `provider.model`，消费端只能去猜请求模型。现在 `observed` 才允许把 `model` 当事实且必须带 source；其余状态一定没有 `model`/`modelSource` 且必须有原因。一轮里报了多个模型只报 `conflict`，不挑一个、也不回落到 usage 模型。`usage_event` 表示这是**被计费**的模型，不是被请求的模型。
- `hooks` 证据段：只要数组里还有 `status: "unknown"` 的运行（宿主只投递了生命周期事件、没有逐 hook 结果），整段就是 `partial + inferred`，`omissionReason` 写明「N of M 个运行没有观测到结果」。旧实现在“部分有结果、部分只有投递”时整段判 `available/exact`，于是下游把派生的 `failed=0` 读成「Hook 成功率 100%」。**`hookFailedCount=0` 不是成功率分母**，除非整段是 `available`。
- `turnRoleStatus` 与 `turn_role` 入参：`{ session_id, role, source, parent_id?, reviewed_session_id? }`，由**驱动该会话的进程**在事件发生时声明，session 必须与该生命周期事件一致，子代理上下文不归入主轮，所有值限定长标识符字符集。合法时写 `turnRoleStatus=observed` + `turnRole`；显式非法写 `conflict`；未声明写 `unobserved`。
- **未声明就是 `unobserved`，不是主 Agent 回合。** 同一 sessionId 下的轮次可能是人发起的，也可能是编排器注入的，Scry 不区分也不猜。固定文案前缀（例如把审批历史抄进 prompt）是诊断信息，不是身份边界，不得用正则反推角色；消费端不得拿 `turnCount` 当真实用户回合数或人工介入次数。
- 这些字段不是签名或执行授权，调用方负责真实身份与发送时刻；异步重试必须发送原快照。`turn_role` 与 `task_context` 一样属于保留字段，集成层应确保它来自可验证来源而不是宿主/用户 payload。
- 安装示例对应待交付源码版本，不代表已经发布或升级本机 CLI。

## 0.2.41 原生模型与显式任务关联

独立 CLI 的 lifecycle 输入新增两组可选元数据；只作用于之后生成的新记录，不改历史文件、recordId 或 outbox：

- `model_ids: string[]` 与 `model_ids_complete: boolean`：由集成层从本轮真实模型消息取得，最多 64 个 ID。全部观察完整且去重后只有一个模型时才写 `provider.model`；缺失、非法或多模型不选择默认/最后一个模型。不依赖 token/cost 是否可见，也不从 CLI 配置推测。
- `task_context: { task_id, task_generation, session_id, turn_id }`：由受信调用方在事件发生时核验其工作流状态，冻结到原事件；Scry 不读取任何调用方私有工作流目录，也不从 prompt/业务工单推断。session 必须与该生命周期事件一致，子代理上下文不归入主轮。一轮只有同一个 task/generation 时写根 `linkedTaskId`、`linkedTaskGeneration` 与 `taskLinkStatus=bound`；冲突/非法上下文写 `linkedTaskId:null, taskLinkStatus:conflict`，没有上下文为 `unbound`。数值 `generation` 仍是 Scry 自身轮次代号，不被工作流字符串覆盖。
- 调用方负责真实身份与发送时刻；这些字段不是签名或执行授权。异步重试必须发送原快照，不能在 worker 中查最新绑定。managed canonical 提交路径不从 standalone hook 推断关联，需由对应生产方另行对接。
- 消费端必须区分根字段**缺失**与**显式 null**：后者禁止正文猜测及历史回填；不支持此契约的服务端应先升级，再启用新客户端。不能用空白 user 文本或伪任务哨兵绕过。服务端按整个 session 展开指标的既有规则不因新增工作流 generation 字段自动改变。
- 安装示例对应待交付源码版本，不代表已经发布或升级本机 CLI；App 私有 CLI 与全局 CLI 仍是独立分发面。

## 0.2.40 Qoder Credits 采集

- 新记录的 `usage.value.credits` 独立保存 `status`、`quality`、`source` 与 `value: { provider: "qoder", unit: "credits", scope: "main", amount?, knownRequests, missingRequests }`，不进入 `costUsd`。
- 独立 CLI 从本轮原生日志按用户身份/parent 链关联请求；App managed 模式从本轮 SDK 主会话消息采集。按 request/message ID 去重，只使用折后 `credits` 和明确的 `billable`；忽略会话累计 `total_credits`、折前 `original_credits` 和 replay/fork 副本。
- 数字为实测子集：有已知请求时为 `partial/exact`，子代理、缺失/冲突计量不猜测；没有已知金额时 `unavailable` 并省略 `amount`。明确非计费请求可以是 0，不等同于整轮免费。
- `scry turns summary [sessionId|--all]` 输出 `usage.credits`，包含独立金额、单位、来源与覆盖轮次；旧 Qoder 记录没有此字段时算覆盖缺失，不补零、不自动重写历史。
- App 用量页优先使用与 managed record 同源的已保存证据，旧 archive 缺字段时才读取原生日志补充，同一轮不会将两份 Credits 相加。无终态 result 的已观测用量也保留；Credits ledger 不重复计入已有 Token 行。
- 升级需要安装实际 hook 使用的 CLI；App 私有 CLI 随 App 打包更新。仅修改源码不代表 npm 已发布或本机安装已升级。

## 0.2.39 用量与子 Agent 证据修复

- Codex 的裸 `spawn_agent`、`multi_agent_v1__spawn_agent` 和分离的 namespace/name 在 rollout 与 hook-only 路径统一记为 Agent；不把未知 namespace 或 MCP 同名工具误判为子 Agent。
- OpenCode 初始化零值不算终态用量；按 message ID 覆盖更新，只累计终态实际存在的有限非负数。合法的终态零值保留，缺字段不补零。
- 完整计数仍走 `usage`；不完整的已观测计数走 `usage_partial`，新 recorder 保存为 `partial/exact`（数字是实测子集，不是整轮总量）。旧 recorder 不认识该字段时保持 unavailable，不会把子集误记为 exact 总量。`usage_complete:false` 也可显式标注既有 usage 输入不完整。
- 修复只影响新记录。不会重写历史 category、补造 stop/耗时/token，或修改已安装 CLI/插件；源码版本、实际 hook 使用的 CLI 和生成插件需要分别核验。
- `calls.total=null` 可能表示分类覆盖不足；`modelTiming=response_intervals/estimated` 不等同于精确 API 耗时，不能通过补零或升级 quality 消除。

## 未结束的轮次与终止时间

一轮从 `UserPromptSubmit` 开始、`Stop` 结束。Provider 被 `kill -9`、崩溃或终端被直接关闭时,结束事件永远不会到,这一轮会停在 `.scry/runtime/`。

**`completedAt` 只能来自这一轮自己的证据。** 0.2.38 之前，未收到 `Stop` 的轮次会被下一次 `UserPromptSubmit` 的时间收口，把用户的空闲等待算成 Agent 执行时长（实例：17:26 真实中断被拉到 17:49，时长虚增至 ~36 分钟）。现在下一次输入只触发收口，**不再作为上一轮的结束时间**。

每条记录新增 `termination` 证据，说明结束时间怎么来的：

| `completedAtSource` | 含义 | envelope |
|---|---|---|
| `provider_transcript` | Provider transcript 的终态时间 | available/exact |
| `provider_terminal_event` | 终止事件自带的显式时间 | available/exact |
| `recorder_observed_terminal` | 终止事件到达时 Scry 自己的时铟 | available/estimated |
| `last_observed_activity` | 无终止事件，取最后一次真实活动（**下限**） | partial/estimated |
| `turn_start` | 既无终止事件也无活动，结束时间未知 | partial/inferred |

`reason` 区分 `provider_terminal`、`session_end`、`run_ended`（managed 运行边界）、`superseded_by_next_turn`、`expired`。早于 0.2.38 的记录**没有**这个字段；缺失只代表 legacy，不能当作结束时间可信。

- `status !== 'available'` 时，`durationMs` 是下限而不是完整时长；turns summary 的 `wall` 同时给出 `exactEndTurns` / `boundedEndTurns` / `unknownEndEvidenceTurns`。看板的用户等待区间应从 `completedAt` 之后开始。
- 超出轮次窗口的时间戳（早于 `startedAt`、或超出本地时钟 60s 以上）不被信任，会退到下一个可信来源。
## 会话结束（SessionEnd）

收到 `SessionEnd`、`session.end`、`session_end`、`session.exited`、`process.exit` 时，当前 open turn 立即定界为 `interrupted`（`reason: session_end`），**不会**因为会话结束而被当成完成。

- Hook 只做两件事：写入生命周期事件、把终止时间与结论固定到 `open.json`，然后返回 `pending`。transcript 解析与 Git diff 由 daemon/`scry recorder recover` 在后台完成（daemon 在每次请求后重置为 1s 轮询）。结束时间已先固定，所以推迟聚合不会拉长时长；Hook 被杀也只是留下一个 closing turn，仍可恢复。
- 重复 SessionEnd 幂等：未完成时反复返回 `pending` 而不改写边界，已提交后返回 `duplicate`。普通采集、managed 与 journal recovery 共用同一套语义。
- `scry init` **只为 Claude 注册** `SessionEnd`，timeout **3 秒**（`Stop` 仍为 15 秒）：依据是 Claude SDK 的 `HOOK_EVENTS` 包含 `SessionEnd`。**Codex、Qoder 没有经过核实的会话结束 Hook，OpenCode 根本没有这类事件**，因此不注册，也不假装 parity；这些 Provider 仍靠上面的结束时间解析。已安装的工作区跑 `scry init` 或 `scry integrations repair` 才会补上。
- 外部已有自己的 SessionEnd Hook（例如其他平台封装）时，也可以不让 Scry 注册，直接转发：`scry recorder hook --provider claude --event SessionEnd --workspace "$PWD" --stdin --quiet`。

> ⚠️ **Connection reset 不会触发 SessionEnd。** 连接断开但会话仍在时，靠的是上一节“不再借用下一次输入时间”；SessionEnd 只能让真正结束的会话更早收口。

**同时满足**「超过 24 小时」与「transcript 已停止增长」的轮次判定为不可能再收敛,由 `scry recorder recover`(daemon 空闲时自动跑)收敛为 `interrupted`。两个判据都必需:只看年龄会把跑了 30 小时的长任务误判为中断,而长任务会持续追加 transcript。

```bash
scry doctor            # 退出 5，turns.stale 报出数量与最久时长
scry recorder recover  # {"recovered":1,"pending":0,"expired":1}
```

收敛后的记录:`status` 为 `interrupted`,已观测的证据段降级 `partial` 并说明原因,未观测的段保持 `unavailable`。`diff` 段固定 `unavailable` —— 基线可能是几天前的,发布它等于把之后所有改动(包括别的轮次的工作)算到这一轮头上。

### 结束事件到了却写不出记录

另一种卡法:结束事件**已经到达**(轮次进入 `closing`),但写最终记录时在 transcript 里找不到这一轮 —— Provider 已经把它轮转掉了。这种轮次原本会无限期停在 `closing`,每次 recovery 重试、每次都失败。

超过同一个窗口(以 recorder **最后一次写状态**的时间计,不用 Provider 给的时间戳,避免时钟偏移触发破坏性判定)后不再重试:

| | `status` | 正文 | `diff` |
|---|---|---|---|
| 结束事件从未到达 | `interrupted` | `unavailable` | `unavailable` |
| **结束事件到了但正文已丢** | **`completed`** | `unavailable` | `unavailable` |

`completed` 是诚实的:终态确实观测到了(这才是它进 `closing` 的原因),丢的只是内容,所以降级的是证据而不是生命周期结论。

两类卡住的轮次都会让 daemon 长期不退出(有活干时不退场),收敛后它才会正常空闲退出 —— 也才轮到 daemon 侧的自动更新。窗口固定 24 小时,不可配置:调小会把仍在工作的轮次误判为中断,并丢弃它的 diff 归因。
