# scry-turn-recorder

Scry 的独立本地轮次记录 CLI。Provider 的生命周期 hook 调用它,把每个顶层用户轮次写成 `.scry/` 下的一个 JSON 文件。

- **不上传任何数据**,不依赖 Electron 或原生模块。
- **不是沙箱**:它记录发生了什么,不限制 Agent 能做什么。
- 支持 Node 20 / 22 / 24,macOS 与 Linux。Windows 不在支持范围。

## 安装与接入

```bash
npm install -g scry-turn-recorder@0.2.51

cd /path/to/project      # 必须是 Git 仓库根目录
scry init                # 自动检测 claude / codex / qoder / opencode
```

`init` 创建 `scry.config.json` 与 `.scry/provider-hook.sh`,并把 hook 合并进各 Provider 的项目配置;已有 hook 会保留,重复执行不会重复添加。可用 `--providers claude,codex` 明确指定。Pi 是用户级扩展,另外执行 `scry integrations install-pi`。

接入后必须做两件事,CLI 无法代替:

1. **重启 Provider**,否则新 hook 不会加载。
2. **Codex 还要在项目里执行 `/hooks` 并信任项目 Hook。**

然后跑一轮真实任务来验证 —— `init` 的自检只能证明配置和本地存储可用:

```bash
scry status --workspace "$PWD"    # 退出 0 表示确实采到了
```

等待采集就绪的写法(`status` 退出码:0 在采集 / 2 未启用 / 3 已配置但未采到):

```bash
i=0; until scry status >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 30 ] && break; sleep 2; done
```

`init` 只开启本地记录,不安装任何 uploader、审计或业务 Hook。

停止新增记录:创建 `.scry-disabled` 或设置 `SCRY_RECORDER_ENABLED=0`;已有数据仍可只读查询。彻底卸载用 `scry integrations uninstall --yes`。

## 日常命令

| 命令 | 用途 |
|---|---|
| `scry status` | 逐 Provider 六阶段:是否在采集、卡在哪一环 |
| `scry doctor` | store 完整性、health 计数、孤儿轮次、生效的采集配置 |
| `scry turns list` | 轮次列表(含 `modelTiming`、compaction 计数) |
| `scry turns show <序号\|recordId>` | 单轮完整记录 |
| `scry turns timeline <序号\|recordId>` | 模型文字与 Tool / Skill / MCP / 子 Agent 交错时间线 |
| `scry turns summary [sessionId\|--all]` | 会话或整个 workspace 的聚合 |
| `scry turns export --after 0 --limit 100` | 游标分页导出记录 JSON（正文保留引用） |
| `scry turns export-bundle <目录>` | 原子导出全部记录与引用的正文 blob |
| `scry turns content <记录> <正文路径...> --offset 0 --limit 65536` | 按字节分页读取 tool/model/diff/transcript 正文 |
| `scry turns verify` | 序号连续性与记录完整性 |
| `scry records archive --before 30d` | 归档旧记录(见「容量与归档」) |
| `scry records maintain [--apply]` | 检查 quota/retention，安全回收孤立正文与压缩轮转日志 |
| `scry support-bundle create` | 脱敏排障包 |
| `scry recorder status\|stop\|restart\|recover\|notify-drain` | daemon 与恢复 |
| `scry integrations diff\|repair\|uninstall` | 托管 hook 的漂移检查与修复 |
| `scry upgrade [--check]` | 升级 CLI |

所有命令都接受 `--workspace <root>` 或 `--workspace=<root>`,输出为 JSON。未知参数直接报错。

`status` 的三个阶段不可互相代替:`configured` 只证明配置写入,`hookSeen` 证明 hook 真的到达 recorder,`recordSeen` 才证明轮次已提交。`trusted` 永远是 `unknown` —— Codex 需要交互式确认,其余 Provider 不向 CLI 暴露信任状态;写 `n/a` 等于声称"不需要信任"。

`openTurnsPending`(未收敛的 open turn)与 `notifyBacklog`(commit hook 未 ACK 数)是两个不同指标,不要混用。

Agent、skill 与提示词不应主动调用这些命令。

## 采集什么

默认全开,每项都可在 `scry.config.json` 里关闭:

```json
{
  "capture": {
    "prompt": true,
    "assistant": true,
    "toolOutput": "full",
    "diff": true,
    "hooks": true,
    "patchExcludeBasenames": []
  }
}
```

`scry doctor` 输出的 `capture` 是解析后的生效值,包含配置里省略的默认值。

关闭某项后对应证据段记为 `disabled` 并带 `omissionReason: ... disabled by config`,与 Provider 不支持的 `unavailable`、以及"真的没发生"的空数组是三个不同状态 —— 记录自己就能解释当时采了什么。

> ⚠️ **关闭正文不等于脱敏。** 即使 `prompt`、`assistant` 关闭且 `toolOutput: "none"`,以下内容仍会落盘:**工具入参**(Bash 命令原文、Edit 的 old/new 字符串)、**文件路径**、**diff patch**(除非 `diff: false`)。当前没有单独关闭工具入参的开关。要求本地不留代码与命令的场景,应设 `diff: false` 并评估工具入参是否可接受,或者干脆不在该仓库启用。

## 工具正文：默认 `full` 原文

当前源码中，`scry init` 和省略 `capture.toolOutput` 的配置默认使用 `full`，记录原始工具 input/output，不再脱敏。旧配置的 `full-redacted` 作为迁移别名解析为 `full`，**不再表示保密承诺**。历史已脱敏内容及标记保留，不尝试恢复。此变更需构建/安装当前源码后生效，不改变已发布的旧版 CLI。

> ⚠️ 原文可能包含密钥、令牌、Cookie 和私钥，会进入 `.scry`、App archive/SQLite、备份及已配置的 uploader。分享/上传前必须自行检查。支持包和认证诊断的防泄露规则不因此移除。

以下是默认生效值：

```json
{
  "toolOutput": "full",
  "toolContentFieldBytes": 8192,
  "toolContentTurnBytes": 131072
}
```

- 已有配置中**显式**设置的 `none/summary` 继续生效，重复 `init` 不覆盖；旧版自动生成的 `summary` 与用户选择无法可靠区分，不根据猜测迁移。无 `scry.config.json` 的工作区仍不自动启用 recorder。
- 同时保存 `inputContent` / `outputContent`，不再把 `outputSummary` 当作全文。摘要从保留的原文生成。正文可能是字符串、JSON 或截断的 JSON 文本片段；只有 `encoding: "json"` 可按完整 JSON 解析。
- 单字段默认 8 KiB、最大 64 KiB；最终轮次记录新增正文合计默认 128 KiB、最大 1 MiB。按 UTF-8 字节裁剪，不截坏字符。预算按稳定调用顺序分配，input 在 output 之前；这只是 inline 预览预算，不是整个 `.scry` 的磁盘配额；完整正文另存 `.scry/content/sha256/` 并通过 `contentRef` 引用，事件暂存、archive、队列也有各自副本。
- 每个字段包含 `content`（省略时不存在）、`encoding`、`savedBytes`、`source`、`sourceCompleteness`、`redaction`、`storage`、`reasons`。`sourceCompleteness: "unknown"` 表示上游没有完整性承诺；`storage: "complete"` 只表示完整保存了当前收到的值，**不证明 Provider 原始输出完整**。
- 新采集的 `redaction` 为 `disabled`；历史 `applied/unchanged/failed/not_run` 仍可读取。旧版 reader 可能拒绝新增状态/原因，读取新记录时应同步升级 App、CLI 和下游消费方。原因区分 `provider_missing`、`source_truncated`、`field_budget`、`turn_budget`、`serialization_failed`、`not_collected`，历史 `redaction_failed` 保留。上游裁剪仍标 partial，不能从旧摘要恢复全文。
- 原文保留不取消结构安全：循环引用、accessor、自定义对象等无法安全序列化的值记为 omitted + `serialization_failed`，不调用 payload 的 getter/toJSON。字符串不因看起来像 JSON、URL 或 form 而被重排或替换。
- App 原始 transcript 镜像允许继续写入，但仍先校验 workspace/session 身份和受管路径。关闭脱敏不改变文件授权、trust gate 或 renderer 隔离。
- 普通轮次及 managed 恢复工件保留字节预算；旧 `full-redacted` 重试也不再对新内容脱敏，但已有正文的历史 provenance 不变。不要在活跃轮次中移动/删除配置或更换 dataDir。
- 外围上传端必须透传这两个新字段，看板需要展示正文及完整性状态；ACK 只证明接收成功。Scry CLI 不实现远端看板，也不负责外围多 active workspace 的 session 唯一绑定。

深工作目录（包括显式过长的 `SCRY_RECORDER_SOCKET`）自动映射为工作区/endpoint 哈希短路径；临时目录本身过长时回退 `/tmp`。路径按字节限制为不超过 100 字节，保留原有 daemon 所有权校验。

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

## 性能与资源

hook 在 Provider 每个生命周期事件上同步执行,所以这条路径的成本直接决定你是否感觉到卡顿。daemon 已运行时,hook 脚本用 `curl --unix-socket` 直投,省掉每事件一次 Node 启动;daemon 不在、`curl` 缺失、`SCRY_RECORDER_TRANSPORT=direct` 或 HTTP 状态码非 200 时自动回退到 CLI —— stdin 会先读进变量再投递,保证回退能重发,不丢事件。

实测基线(macOS / Apple silicon,单个 git 进程约 75ms,取 3–7 次中位数):

| 场景 | 快路径 | 回退到 CLI 自己落盘 | 提速 |
|---|---|---|---|
| 单个工具事件 | **108ms** | 550ms | 80% |
| 轮次起始事件(含 git 基线) | **874ms** | 1232ms | 29% |
| 一轮 · 5 次工具调用 | **2.60s** | 8.22s | 68% |
| 一轮 · 30 次工具调用 | **8.00s** | 34.56s | 77% |

轮次起始只快 29%,因为它的成本主要不是进程启动,而是 git 基线快照:

| `beginGitTurnDiff` | p50 |
|---|---|
| 干净工作树 | 335ms |
| 3 个未跟踪小文件 | 722ms |
| 300 个小文件 | 962ms |
| 一个 50 MB 未跟踪文件 | 1004ms |

`npm run bench:git-diff` 可复现这张表(信息用途,不是门禁)。仓库数量会线性放大这一项:壳仓库套 15 个子仓库时,`begin` 并行后仍需 1.6–2.0s。

- **CPU**:daemon 静置几乎不占 CPU(30 秒窗口 CPU time 增量 <0.2s;20 个进行中轮次约 1.3% 单核)。
- **内存**:单 daemon 启动后 RSS 约 71 MB,静置 30 秒回落到 64 MB。GC 后堆稳定(40 轮只留 1.7 MB),不是泄漏;RSS 不归还属 V8 高水位。
- **daemon 是每 workspace 一个,没有全局上限** —— 并行多个 worktree 时占用会叠加,只在需要采集的 worktree 执行 `init`。

不想要常驻进程:`export SCRY_RECORDER_TRANSPORT=direct`(行为等价,更慢)。

存量 workspace 升级 CLI 后需要重新生成 hook 脚本才能拿到快路径:`scry integrations repair --yes`(不做也不会错,只是慢)。

## 容量与归档

`.scry/records/` 是 append-only 事实源:一轮一个 JSON,文件名带 20 位序号且必须连续。

| 轮次形态 | 大小 |
|---|---|
| 只有 prompt,无工具无 diff | 2.6 KB |
| 5 次 Edit + 5 文件 diff | 6.6–9.9 KB |

存储量取决于实际采集的原文和 diff，不能按 inline 预算估算总磁盘占用。默认 `full` 的单轮工具正文 inline 预算为 128 KiB（可配置到 1 MiB），但 `contentRef` 指向的完整正文不受此预览预算限制；diff patch 不再设置单文件或单轮容量上限，另有元数据、归档和恢复副本。显式 `summary` 仍只保存输出摘要，单次 input 超 8 KiB 会省略并标 `partial`。

可选的 `storage` 配置提供软 quota、retention 候选和孤立文件宽限期：

```json
{ "storage": { "maxBytes": 10737418240, "retentionDays": 90, "orphanGraceHours": 24 } }
```

`maxBytes` 不会通过丢弃引用中的证据强行达标；超过时 maintenance 退出 3 并报告 `overQuotaBytes`。`retentionDays` 只列出候选，仍由 `records archive` 执行可校验的连续前缀归档。孤立 blob/遗留 `.tmp` 必须超过宽限期才可回收。存在 open turn、未完成 archive journal、其他 recorder lock 或近期 temp 时 maintenance fail closed，`--apply` 也不删除。

> ⚠️ **不要手动删除单个 record 文件。** 序号空洞会被 `turns verify` 与 `doctor` 判为 store 损坏(退出 4),而不是"已清理"。

```bash
scry records maintain --workspace "$PWD"                     # 只打印 GC/quota/retention 计划
scry records maintain --apply --workspace "$PWD"             # 回收确认孤立的正文/temp，gzip 轮转日志
scry records archive --before 30d --workspace "$PWD"          # 只打印归档计划
scry records archive --before 30d --yes --workspace "$PWD"    # 执行
```

归档把**连续前缀**搬到 `.scry/archive/<cutoff>/`(可用 `--out` 指定),写出带 sha256 的 `manifest.json`,并把 floor 记进 `archive-state.json`。`--out` 不得与 live `.scry/records/` 重叠；归档和新 record 的序号分配使用同一把锁，避免并发复用序号。跨文件系统复制通过 `.scry/archive-journal.json` 先记账、同步目标文件后再删除 source；中断后用同一个 `--out` 重试会校验 hash 并继续，journal 未收敛前禁止分配新序号。首次执行时 archive target 必须为空，避免覆盖旧 manifest。只有被 floor 解释的空洞才被接受,新轮次从 `floor + 1` 继续编号。配置了 commit hook 时,归档拒绝搬走未 ACK 的记录(退出 5),提示先 `notify-drain`;确实要放弃投递才用 `--force`。

同一 recorder 进程内的 `turns list`、状态与投递 drain 会复用由 records 目录 stamp 校验的可丢弃索引；正式记录与 `archive-state.json` 仍是唯一事实源，`turns verify` 始终绕过索引全量校验。

## commit hook:唤醒外部 uploader

需要在 record 落盘后唤醒外部程序时,在 `scry.config.json` 声明 workspace 相对的 `entry` 与完整 `files` 清单。record 持久化且 runtime 清理后,recorder 以 stdin 发送只含 `workspace/provider/sessionId/recordId/sequence` 的 JSON,**仅在回调 exit 0 后**推进 durable ACK;失败或超时会在下次 hook/recovery 重试。

有效的仓库 commit hook bundle 默认自动授权，不显示确认提示；以下命令可查看、刷新或删除授权（`--yes` 为旧脚本兼容参数，不再是必需项）：

```bash
scry commit-hook trust --workspace "$PWD"
scry commit-hook status --workspace "$PWD"
scry commit-hook revoke --workspace "$PWD"
```

授权记录写在仓库之外(默认 `~/.scry/grants/<workspace-hash>.json`,`0600`,可用 `SCRY_GRANT_DIR` 覆盖)，并标记 `source=auto`。每次投递前重新校验 entry 与全部 `files` 的内容指纹；有效 bundle 发生变化时自动更新授权，bundle 非法或路径越界仍 fail closed。`revoke` 只删除当前记录，下次解析有效配置时会重新自动授权。运行中的旧 daemon 需要 `scry recorder restart` 才能加载新代码。

被授权的 entry 以你的权限运行,并能读取全部 record 正文 —— **授权是执行授权,不是脱敏机制**。采集正文默认不脱敏；团队汇总方案需要自行决定上报原文的范围、权限与脱敏，或仅上报 `turns summary` 聚合。

**daemon 在响应 Provider 之后才投递**,所以回调耗时不占 hook 预算。没有 daemon 时(`SCRY_RECORDER_TRANSPORT=direct` 或冷启动)只能同步投递,此时每个事件最多 8 条、预算 1.5s(单条仍以 10s 熔断),剩余保持 pending。实测回调 350ms/条、积压 6 条时:同步 1688ms/事件,移出后 500ms/事件。

`notifyBacklog` 显示当前已激活 hook 身份的积压，不是所有身份的合计，也不是上传 outbox 的待发数。归档检查仍针对当前命令解析出的 hook 身份，不代表其他 host 身份已经接收；并存使用时，应分别确认各接收方已处理需要保留的记录后再归档。需要清空当前身份的通知积压:

```bash
scry recorder notify-drain --workspace "$PWD"
```

投递语义是 **at-least-once**,去重键为 `(workspace, recordId)`。

## 退出码

| 命令 | 0 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `status` | 在采集 | 未启用 / 无已配置 Provider | 已配置但未采到 | — | — |
| `doctor` | healthy | recorder 未启用 | 配置缺失或非法 | store 损坏 | degraded |
| `commit-hook status` | 已自动激活或未配置 | 不可用 | — | — | bundle 非法 |
| `records archive` | 完成 | 不可用 | 待确认 / 无候选 | — | 拒绝(未投递) |
| `turns show/timeline` | 找到 | — | — | store 损坏 | — |

`turns show/timeline` 未找到记录时输出 `{"found": false}` 并退出 1。

## 排障

```bash
scry support-bundle create --workspace "$PWD"           # 输出到 stdout
scry support-bundle create --out ./scry-support.json    # 写文件（0600）
```

只含:CLI/Node/平台版本、Provider 检测与配置状态、hook 事件计数与最近时间、配置指纹与生效 capture、health 与 store 计数、commit hook 激活与 ACK/backlog、脱敏后的最近日志。

不含:record 正文、文件路径列表、环境变量值、workspace 路径与 `workspaceId` 原文(只给哈希)、commit hook entry 内容。日志里的绝对路径替换为 `<workspace>` / `<home>`,产物自带 `omitted` 字段说明边界。

正常运行**不产生日志文件**;`.scry/logs/recorder.log` 只在出错时创建,单文件 1 MiB 轮转、保留一代。

缺少开始事件的终态不会仅凭会话存在就判为 duplicate。无法通过已提交 turn ID 或已提交轮次的明确时间边界证明重复时，事件保存到 `runtime/<provider>/<session-key>/orphans/<payload-hash>.json`，`health.json` 的 `missingStartTerminals` 和 `orphanEvents` 各加一，并写 `recorder.log`；相同 payload 重放不重复计数。工具 orphan 同样保存 payload。原始 payload 使用 content envelope，受 `toolContentFieldBytes` / `toolContentTurnBytes` 上限约束；只有 prompt、assistant、完整工具采集都启用时才保存正文，否则标明 `capture_policy` 省略。orphan 不是 record，不会猜测 token、轮首时间或 diff。

## 证据口径

- 无调用记为 `available + []`;Provider 未暴露的记为 `unavailable`,**不会伪装成 0**。
- `普通工具` / `MCP` / `Skill` / `子 Agent` 四列互斥,总调用等于四列之和。
- Hook 同时报告"处理器实例"与"生命周期事件";文件同时报告结构化证据与 Bash 推断读取,并保留 quality/coverage —— 分母不同不可直接相比。
- Codex 顶层轮次会合并子 Agent rollout,但 token 与最终回复只取顶层权威值;子 rollout 缺失时相关字段降级 `partial`。Codex rollout 不含原生 Hook 事件,Hook 通常为 `unavailable`。
- Pi 的 assistant/tool payload 与 OpenCode 的 assistant payload 超过字节上限时会发送版本化 `scry_capture` 元数据；record 的对应 evidence 段标为 `partial/exact`，不会把截断内容冒充完整证据。OpenCode 未观测到 usage 时不再写 exact zero；升级后需运行 `scry integrations repair --yes` 更新存量插件。
- Codex 无服务端精确 latency,`response_intervals` 是观测区间,可能包含请求构造、调度、传输与重试。
- `modelTiming.cumulativeMs` 累计并行子 Agent 时间,`occupiedMs` 是所有模型区间的并集(用于与整轮墙钟比较)。旧记录缺该字段时保持 `unavailable`。
- `modelSegments` 与 `compactions` 在旧记录缺失时标 `unavailable`,不会误算成 0。
- Recorder 只保证**新生成**记录使用当前口径,不会重写历史记录。

## managed 模式与更新

Scry App 启动 Provider 时设置 `SCRY_RECORDER_MANAGED=1`:此时 lifecycle hook 只建立轮次身份,App 在 result、Hook 与 diff 全部收齐后两阶段提交 canonical evidence;managed turn 禁止回退到 rollout 近似重建。

若 Provider 启动器会改写 `PATH`,应先解析 `scry` 绝对路径并通过 `SCRY_CLI_PATH` 传入;该变量存在时 hook 只执行指定路径,路径失效则 fail-open 跳过本次记录,不回退到改写后的 `PATH`。

升级只换 CLI,**不会改动 workspace 里的 hook 脚本** —— `.scry/provider-hook.sh` 由 `scry init` / `integrations repair` 写入,升级后仍是旧版本内容,采集不会出错但拿不到新版本的加速。`doctor` 会明说:

```json
{ "hookScript": "outdated",
  "checks": [{ "id": "hook.script", "status": "warn",
               "detail": "managed hook script was written by an older CLI",
               "remediation": "run `scry integrations repair --yes`" }] }
```

`hookScript` 四种取值:`current`(与本 CLI 一致)、`outdated`(受管但由旧版本写入)、`unmanaged`(团队自建桥接,Scry 不碰)、`absent`。只有 `outdated` 报 `warn`,且**不改变退出码** —— 旧脚本仍在正确采集。

```bash
scry integrations repair --yes    # 重写受管脚本与 Provider 配置条目
```

独立安装**默认自动更新**:同一个 major 内的新版本会被直接安装(包括跨 minor),装完在下一次命令开头提示一次 `Scry CLI 已自动更新:X → Y(关闭:SCRY_AUTO_UPDATE=0)` —— 默认开意味着没人显式同意过,所以证明它确实装了的这一行同时给出关闭方法。检查至多每天一次,失败后 6 小时再试,安装禁用 package lifecycle scripts。

关闭:

```bash
export SCRY_AUTO_UPDATE=0     # 或 SCRY_NO_UPDATE_CHECK=1（连检查一起关）
```

**这个默认值的代价要写明**:发布出去的版本会在无人值守的情况下,装到运行着 Agent 的机器上,并以本机用户权限运行。选择它是因为 opt-in 只能触达"已经知道这个开关存在"的人 —— 其他人会永久停留在初次安装的版本。约束仍在:永不跨 major、永不从 Provider hook 事件触发、host 钉版本(`SCRY_CLI_BUNDLED`/`SCRY_RECORDER_MANAGED`)时不更新、`CI` 下不更新。需要严格版本控制的团队应显式关闭并自行分发。

两个触发点,同一套 env 门(`SCRY_CLI_BUNDLED`、`SCRY_RECORDER_MANAGED`、`SCRY_NO_UPDATE_CHECK`、`CI` 任一开启都不触发):

| 触发点 | 时机 | 覆盖的机器 |
|---|---|---|
| 交互式命令 | 你在终端跑 `scry <命令>` 结束时(需 stderr 是 TTY) | 有人手动用 CLI 的机器 |
| **recorder daemon** | daemon 因空闲而决定退出时 | **只跑 Agent、没人敲 `scry` 的机器** |

**Provider 的 hook 事件永远不触发更新**。两个原因:走 curl 快路径时 hook 里根本不启动 Node,加触发点等于把一次进程启动(实测 79ms)加回最热的路径;而且一轮有 5 类事件、跨度几分钟,在事件之间换掉 CLI 会让同一轮跨两个版本(managed 模式下直接 exit 86)。

daemon 的时机是**它已经决定要退出**之后 —— 进程本来就要结束,换 CLI 不额外花钱,也不可能切断轮次:有 open 轮次时 daemon 根本不会进入退出路径。更新的每一步都有硬超时(查询 8s、安装 120s、校验 8s),失败就放弃,下个空闲窗口再试。装上后 daemon 立即退出,下一个事件启动的就是新版本;daemon.log 会记一行 `idle update installed X -> Y`。

**待投递的轮次不阻止更新** —— 记录本身是持久且带版本的,新版本恢复旧 open 轮次是既有支持路径,`doctor` 也会报版本漂移;反过来若要求"零 pending 才更新",恰恰会在最容易积压的 workspace 上永久关掉更新。

跨 major(如 `0.x → 1.0.0`)永远不自动安装,只报告可用 —— **破坏性变更靠升 major 表达**,不再用 0.x 的 minor 当边界。

```bash
scry upgrade --check    # 只检查
scry upgrade            # 前台升级到 registry latest（不受 major 边界限制）
```

真正容易踩的坑不是"没自动升",而是**同一台机器有多份安装**:hook 通过 `SCRY_CLI_PATH` 或 `.scry/cli-path` 固定用某一份,而你在 shell 里 `scry upgrade` 升的是 `PATH` 里的另一份。`doctor` 会直接指出来:

```json
{ "recorderVersions": { "thisCli": "0.2.42", "lastRecord": "0.2.30" } }
```

对应的 `recorder.version` 检查在两者不一致时报 `warn`(不改变退出码 —— 刚升级完还没记新轮次时本来就会不一致)。看到它就去确认 hook 用的是哪一份,并升级那一份。

`SCRY_NO_UPDATE_CHECK=1` 或 `--no-update-check` 关闭检查;`SCRY_CLI_REGISTRY` 覆盖 registry(必须 HTTPS),未设置时用本机 npm 配置。App 内置 CLI、recorder、daemon 与 CI 不触发后台检查。

## 环境变量

| 变量 | 作用 |
|---|---|
| `SCRY_RECORDER_ENABLED=0` | 停止新增记录 |
| `SCRY_RECORDER_TRANSPORT=direct` | 不使用 daemon,每事件自己落盘 |
| `SCRY_RECORDER_SOCKET` | 覆盖 daemon socket 路径 |
| `SCRY_RECORDER_IDLE_MS` | daemon 空闲退出窗口(默认 30 分钟) |
| `SCRY_CLI_PATH` | hook 必须使用的 CLI 绝对路径 |
| `SCRY_GRANT_DIR` | commit hook 授权记录目录 |
| `SCRY_AUTO_UPDATE` | 未设置即开启;`0`/`false`/`no` 关闭自动安装 |
| `SCRY_NO_UPDATE_CHECK=1` | 连更新检查一起关闭 |
| `SCRY_CLI_REGISTRY` | 覆盖 npm registry(HTTPS);未设置时用本机 npm 配置 |
