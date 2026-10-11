# LLM 性能

左侧「LLM 性能」位于技能上方。点击打开居中弹窗，内容自上而下：运行中的会话（无会话时隐藏）、各模型曲线（「输出速度 / 首 token」切换）、模型对比。右上角切换 1 小时 / 24 小时 / 7 天。关闭、Escape 和焦点返回沿用 ModalFrame。设计原型与反馈见 [brief](../designs/scry-llm-token-speed/brief.md)。

## 速度口径

- 只用 token/s。不从字符、消息块、分词器或经验比例换算。
- 一轮速度 = 本轮主 Agent 成功调用的输出 token 之和 ÷ 这些调用的耗时之和。耗时从请求开始到消息结束，包含首 token 等待，不含工具执行。子 Agent 调用不计入。
- 输出 token 含 Provider 计入的 reasoning token。reasoning 不流式输出，所以不用「首 token 之后」的口径，否则会高估速度。
- 失败或停止的轮次保留在历史里，但不进入曲线和中位数。没有 token 或耗时证据的轮次直接省略，不显示为 0。

## 首 token 口径

- 一次调用的首 token 等待 = 请求开始 → 模型开始输出第一个内容块（正文、思考或工具调用）。单位秒，本机计时。
- 首块包含思考块的开始，所以首 token 不含思考耗时。它主要反映网络往返、厂商排队和读入上下文（prefill）；生成速度的差异留在输出速度里。
- 一轮的首 token = 本轮带首块信号的调用的平均值（`firstTokenMs`，调用数 `firstTokenCalls`）。没有首块信号的调用不计入，也不当作 0。
- 输出速度的口径不变，仍包含首 token 等待。

## Provider 接线

| Provider | 来源 | `tokenTimingSource` |
| --- | --- | --- |
| Claude | result 的 canonical 输出 token 与 SDK `durationApiMs` | `provider_api` |
| Pi | 每次 `message_end` 的 `usage.output`；耗时 = 本机收到时间 − `message.timestamp`（Pi 在创建请求时写入）。`error`/`aborted` 与 0 输出调用不计 | `observed_calls` |
| Codex | 每次根线程 `thread/tokenUsage/updated` 的正向输出 token 增量；耗时 = 开始 → 最后一个生成信号（见下文）。重复快照（增量为 0）不算新调用；子线程不计 | `observed_calls` |
| Qoder / OpenCode | 未接入单次调用证据 | 无，速度缺失 |

首 token 来源：

| Provider | 首块信号 | 缺失时 |
| --- | --- | --- |
| Pi | 该消息的第一个 `message_update`（Pi 只为 text/thinking/toolcall 的 start/delta/end 发出） | 无更新的调用不计 |
| Codex | 开始之后根线程第一个 `item/started`（`reasoning` / `agentMessage` / `webSearch`）或正文/思考 delta。Codex 自己的单请求 TTFT 也用 OutputItemAdded，但 app-server 不下发 | 工具 item 不算（模型生成完调用才开始） |
| Claude / Qoder / OpenCode | 未接入 | 「首 token」列显示 —，首 token 图不画该模型 |

Codex 在有扩展参与流式条目时可能延迟下发 `item/started`，此时首 token 偏大。

### Codex 单次调用的起止

Codex 等这次请求调用的工具全部跑完，才发出它的 usage 通知（codex-rs `turn.rs` 先 drain in-flight 工具，再发 token count）。所以 usage 通知不是生成结束，这次请求自己的工具完成也不是下一次请求的开始。真实顺序：

```
请求开始 → 首块 → … → PreToolUse 开始 → 工具运行 → 工具/Hook 完成 → usage 通知 → 下一次请求开始
```

- 开始：轮次开始、上一次 usage 通知，或本次还没有任何输出时完成的工具/Hook（例如 UserPromptSubmit），取最晚者。
- 结束：最后一个生成信号。信号包括正文/思考 delta、`reasoning`/`agentMessage`/`webSearch` item 的开始与完成、`PreToolUse` Hook 开始，以及没有前置 PreToolUse 的工具 item 开始。没有任何信号时以 usage 通知为结束。
- 时间一律用本机收到通知的毫秒时间。`turn.startedAt` 与 Hook `completedAt` 是整秒，会让开始提前最多 1 秒。
- 已知近似：PreToolUse Hook 与工具 item 只按先后计数配对。一次请求里有的工具有 Hook、有的没有，并且并行开始时，配对可能错位；结束时间的偏差不超过一次 Hook 耗时。

`observed_calls` 是本机计时的估算：包含本机 IPC 延迟，Codex 还依赖 usage 通知紧随响应结束这一时序。Provider API 时间存在时优先用它，不与本机计时混用。单次调用证据记在 trace 事件的 `llmCall` 字段（`outputTokens`、`durationMs`、可选 `firstTokenMs`；Pi 在 `runtime:llm_stream_end`，Codex 在 `runtime:llm_call`），不参与计费用量。

## 曲线

- 每个模型一条连续曲线：在 180 个时间点上，对附近轮次做高斯加权几何平均。带宽 1 小时 = 4 分钟、24 小时 = 40 分钟、7 天 = 4 小时。几何平均让单个异常轮次不主导曲线。
- 1.5 倍带宽内没有轮次的时段，曲线平滑落到 0 轴。0 轴只是绘图基线，不是测量值：悬停显示「空闲」；中位数、分布和轮数都不计入空闲。落向 0 轴的过渡段高度只是视觉过渡。
- 纵轴上限 = 测量值 98 分位 × 1.1。输出速度向上取整到 20；首 token 取 1/2/5 × 10ⁿ。更高的值贴顶。7 天视图在本地零点放刻度。
- 首 token 图沿用同一条连续曲线规则：空闲落到 0 轴。0 秒在这里同样只是基线，悬停显示「空闲」。
- 模型颜色按全部历史的轮数排序，切换范围时不变。点击模型行突出该模型，其他曲线变淡。

## 运行中的会话

摘要只读取 run registry 里每个主 run 的最新 observer 小摘要，不扫描 trace，不随当前查看会话变化；一个会话只取当前主 run。弹窗打开且可见时每秒读取一次，隐藏或关闭即停止。每行显示模型（无调用证据前显示 Provider）、项目、状态，以及本轮已完成调用的速度和平均首 token；没有单次调用证据的 Provider（如运行中的 Claude）不显示速度。读取失败时清空旧摘要并显示错误。

## 历史与归属

- 沿用 `userData/usage.jsonl` 的 `kind: llm_performance` 行，不增加 DB 或 recorder 事实源。这些行不计入 billing 或 turn 数，沿用原 session 删除归属。
- 读取最近 30 天最多 1000 轮。截断切进当前时间范围时，标题旁显示「只含最近 N 轮」。损坏行计入 `invalidLines` 后跳过。
- 每轮仍冻结运行边界的本机网络配置线索（只保留开关，不保存地址或凭据），当前弹窗不展示。
- 本次改动之前的 Pi/Codex 历史没有速度证据，不会出现在图上。

如果文件扫描延迟不可接受或需要更长历史，升级到既有 SQLite 投影，保留相同证据与删除合同；不扩大 IPC 上限。

## 验证入口

```sh
npm run test:unit -- src/shared/llm-performance.test.ts src/main/llm-performance.test.ts src/main/llm-performance-history.test.ts src/main/providers/pi.test.ts src/main/providers/codex.test.ts src/main/llm-network-configuration.test.ts src/main/usage-jsonl.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts --exclude '.local/**'
node scripts/session-capability-ui-smoke.mjs --performance-only
npm run typecheck:web
npm run build
node scripts/electron-security-smoke.mjs --dev-performance-only
```

UI fixture 使用生产 App、registry 和 observer，配合预置历史。它用真实指针事件验证：失败与无证据轮次不进图、模型中位数、首 token 列与指标切换（无证据显示 —）、悬停（有数据处显示速度，空闲处显示「空闲」）、选中模型、范围切换、运行中会话的单次调用速度、成员结束/停止/空闲、焦点独立、隐藏/关闭停止刷新、读取错误清空，以及两种主题和窄窗口。生产 IPC smoke 使用当前构建与临时 HOME/userData 及 smoke adapter。两者都不启动真实付费 Provider。

UI fixture 在后台用 `showInactive()` 打开窗口，可能被用户窗口遮挡；被遮挡的窗口不出帧，会卡住 `requestAnimationFrame` 和按帧派发的 mousemove。因此 fixture 进程带 `--disable-backgrounding-occluded-windows`，显式 `hide()` 仍会让 `document.hidden` 为真。`win.setSize()` 是异步的，点击和测量前等待 `innerWidth` 更新。
