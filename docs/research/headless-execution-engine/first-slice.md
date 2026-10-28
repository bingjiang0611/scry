# 首个切片：先归因，再验证增量 trace

**状态：实施建议，尚未开始。** 本次授权只修订方案；实施 P0/P1 仍需单独批准。源码基线、权威边界与阶段估算见[总览](../headless-execution-engine-design.md)。本篇是当前执行入口，三篇架构附录不是本切片的依赖。

## A. 范围与交付物

保留现有 Electron 进程布局、Provider 运行方式、存储格式、远程 wire contract、React commit 后 ACK、退出与 trust gate。当前不做独立 engine、私有 Node、journal/spool、DB worker 或后台常驻。

| 步骤 | 要交付什么 | 完成证据 |
| --- | --- | --- |
| P0 | 4/16 个离线并发会话的进程/阶段归因表、冻结 workload、噪声范围 | 可重放输入、总工作量、版本身份与首轮结果；不只有截图/主进程 RSS |
| P1-a | mutation 清单闭环、现有合并语义的最小内部变更通知 | 所有可影响活动 trace 的写者纳入或明确排除，负对照能发现漏通知 |
| P1-b | 远程 revision 按 dirty projection 更新，不静默全量 hash | 与旧全量 hash oracle 回放等价；真实完整路径 L2 对照 |
| 可附带的 P2 观测 | persistence queued/in-flight 字节、等待时间、峰值 | 计量开销被测到；不丢事件、不提前终态、不实施未经授权的上限行为 |

P0 的 collector/fixture 与 P1 优化分开提交。不要在实施某个假设时缩小 workload、增加预热或把移走的工作排除计数。

## B. P0：回答“卡在哪”

### B.1 固定工作量

- 在临时 workspace/userData 和真实隔离 Electron test App 内运行，沿用既有离线 transport/native UI fixture。不得在开发仓库驱动真实 Agent。
- 主轴为 4、16 个活跃离线会话；每个任务的事件总数、字节、工具输出大小、文本替换比例和完成条件固定，报告实际并发和完成任务数。
- 分别测：持续流式、长 trace 后安静等待、一次大输出/内容回填、切换历史＋Overview、远程读者 0/1/4 个。不要把远程无读者的收益外推到有读者场景。
- P1 规模子场景使用 1k/10k/50k 个已有事件、固定新增/替换序列；包含旧 revision、缩短、reset 与容量淘汰。16 个 run 要覆盖现有 `MAX_RUNS=8` 的行为，不借机调大缓存。
- 每组同时保留“总任务量固定”和“并发数变化”的对照。更少并发降低峰值时，要同时报告队列等待、吞吐和完成时间。
- 离线 fixture 证明 Scry 路径，不证明真实 Claude/Pi 的固有内存、子任务 fanout 或网络开销。真实 Provider 验证需额外账号/费用授权。

### B.2 必须产出的归因表

每行包含 workload、采样数、p50/p95/max 或累计量、观测来源、不可观测项。阶段存在并行/包含关系，不能把 wall time 简单相加冒充总 CPU。

| 部分 | 至少记录 | 防止误判 |
| --- | --- | --- |
| Provider/子进程 | 已登记进程树 CPU、RSS/可用 footprint、进程数量、观察覆盖 | 未登记/不可访问的后代标 unknown；不把 root idle 当子任务结束 |
| main | CPU、event-loop delay、mutation/投影/编码/hash 工作量 | 将 IO 等待与实际 CPU 分开 |
| persistence | 现有持久化/终态 drain 阶段耗时与可观测写入；新增 raw queued/in-flight 字节及等待计量仅在选择附带观测时要求，否则写 unavailable 与原因 | renderer mirror 有界不代表 raw 队列有界；可选计量不成为 P0/P1 隐含前置条件 |
| IPC | 投递→接收、接收→commit ACK；payload/clone 字节、在途量 | 跨进程单调时钟须校准，不能直接相减；没有可靠拆分时报告端到端往返 |
| renderer | commit 时间、long task、原生输入/停止反馈、首可用页面 | React body 时间不等于 commit/layout/paint；offscreen 结果单列 |
| 全链路 | 全进程 CPU、峰值内存、自然 GC 后驻留、有效吞吐和用户路径延迟 | 所有 worker/子进程和新计量成本都入账；RSS 求和不是精确物理内存 |

新增计数先限制在 fixture/诊断实验，不改日常 journal 的采集字段或保留策略。保留基线与候选两侧相同观测开销，不用日志打印正文、凭据或用户路径。

### B.3 何时可以形成归因

先用旧实现重复固定实验估计噪声，再预登记最小可检测变化、重复次数和对照顺序。毫秒实验串行经过现有 timing lock；高负载结果不能当有效 L2。若环境持续不可信，明确暂停，不无限重跑到绿色。

判定不仅看热点排名，还看因果对照：只禁用/替换一个已定位的重复工作，观察完整用户路径。没有变化的窗口也测空闲基线，区分持续成本和事件突发。

## C. P1：mutation 修改点清单

以下是基线的生产路径盘点，不是“搜到这些字符串就证明永不遗漏”。实施者须沿对象别名、调用方和输入来源核对；新增生产写者必须补入清单和测试。

| 文件/入口 | 当前变化 | P1 处理 |
| --- | --- | --- |
| [live-trace.ts](../../../src/main/live-trace.ts)：`upsertTraceById` | 按 ID 替换或 push | 返回真实变化；查找索引必须保留既有 ID/顺序语义 |
| 同文件：`appendCoalescedTrace` | 文本合并、spliced streamed text、插入最终正文、push | 非尾部结构变化使后缀索引失效；空最终正文也覆盖 |
| [run-live-state.ts](../../../src/main/bootstrap/run-live-state.ts)：`createLiveRunState` | `onPersisted` 回填同 ID；实时 normalize 后 append | 内容引用、错误/用量 metadata 都触发变更，不只观察 text |
| [run-execution.ts](../../../src/main/bootstrap/run-execution.ts)：`startRun` | recorder/阶段回调中的 `upsertTraceById` | 同一 run 的回调仍必须走通知边界；run 已收敛时的晚到更新有明确处理 |
| [run-diff.ts](../../../src/main/bootstrap/run-diff.ts)：`createRunDiffLifecycle` | turn/session diff 事件追加与更新 | 异步 diff 结果纳入相同版本，不靠下一条 token 顺带刷新 |
| [trace-runtime.ts](../../../src/main/bootstrap/trace-runtime.ts) | 运行状态等事件追加；`boundedLiveRun` 重建投影 | 绑定 mutation 与投影失效，权限/策略变化不可沿用旧投影 |
| [run-outcome.ts](../../../src/main/run-outcome.ts)：`ensureFailedTerminalResult` | canonical result 更新/插入，重复结果改为 `result_superseded` | 原地对象修改也通知；由 [run-failure.ts](../../../src/main/bootstrap/run-failure.ts) 路径验证 |
| [remote-run-binding.ts](../../../src/main/remote/remote-run-binding.ts)：`createRemoteRunBinding` | 独立 `items.push`、输出分片状态、checkpoint/终态恢复 | 不是同一个 ActiveRun 数组；核对其发布边界，若只作历史快照则用新 generation，不强行共享可变状态 |
| [conversation-history.ts](../../../src/main/conversation-history.ts)、[remote-gateway-history.ts](../../../src/main/remote/remote-gateway-history.ts)、[pi-native-history.ts](../../../src/main/pi-native-history.ts)、[normalize.ts](../../../src/main/normalize.ts) | 历史重建、解析与临时事件数组 | 区分新建 snapshot 和已发布 live 对象；新 snapshot 初始化 generation，不把临时数组的每次 push 当 live 更新 |

辅助检索应覆盖 `appendCoalescedTrace`、`upsertTraceById`、`ensureFailedTerminalResult`、`items.push/splice`、索引赋值、属性赋值和传出的对象别名。测试中冻结已发布快照或捕捉未经通知的变化；仅 grep 不能发现嵌套对象别名修改。

### C.1 最容易漏掉的投影依赖

[tool-content.ts](../../../src/core/turn-recorder/tool-content.ts) 的 `sanitizeToolEvents` 有累计 turn 字节预算。前面的事件变大，会改变后面未修改 raw event 的可见内容。因此：

- dirty raw event-ID 不等于 dirty bounded projection。
- 内容大小变化、插入/删除、顺序变化至少使受影响后缀重新投影；policy/source/authorization 变化使整个 projection generation 失效。
- P1 先保持现有投影合同，再优化重复编码/hash。若全量 sanitize 仍是主成本，要计入 L2，不能把它藏在未计量路径。
- full/reset 的初次物化成本仍存在；静默读变快不代表首次加载变快。

### C.2 最小内部类型草图（不是新 IPC 协议）

以下复用现有 `TraceEvent` 和远程 cursor；只说明拟定接缝，不新增通用 engine/注册表：

```ts
type TraceChange = {
  mutationRevision: number
  previousCount: number
  count: number
  changedIndices: readonly number[]
  invalidateFrom?: number // splice、预算再分配等需要重建的后缀
}

type TraceMutationResult = {
  changed: boolean
  change?: TraceChange
}

type ProjectionIdentity = {
  runId: string
  generation: string
  policyRevision: string
  authorityRevision: string
}
```

已有 append/upsert/outcome 入口完成修改后返回变更；run owner 持有索引与 mutation revision。不是按对象引用是否变化猜测，也不是为每条事件深克隆全历史。

内部 mutationRevision 与对外 revision 分开：先汇总 pending dirty，再沿现有 observe 边界发布。保留当前 revision/history/cache 容量与旧 cursor 的 reset/count 合同，不因每个 token 递增对外 revision 而加速淘汰。删除或压缩后必须正确发送最新 count。

### C.3 Oracle 与负对照

- 将当前全量 `JSON.stringify + SHA-256` 算法保留在测试 oracle，不把它同时长期运行在生产热路径。
- 对同一事件序列，将两种 delta 分别交给现有消费逻辑，比较重建的 bounded items、顺序、最终正文、内容引用、用量/错误语义和 count。opaque revision 值无需相同，失步与恢复合同必须相同。
- 覆盖：append、同 ID enrichment、no-op、合并文本、空最终替换、旧位置更新、`result_superseded`、嵌套 metadata、累计内容预算、run/cache 淘汰、错 count/旧 cursor、late diff、多个读者和旧 epoch。
- 故意漏掉至少一个属性更新通知、一个结构性变化、一个预算后缀失效，证明 oracle 测试分别失败。
- 生产没有变化时不重新编码/hash 全部内容；真实重排或预算后缀失效仍允许必要工作，但要计入计数。

## D. raw 队列预算：先观测，不假装背压已解决

[LiveTraceIngestion](../../../src/main/live-trace-ingestion.ts) 的原始数据还可能由 runState 持有。计数至少分 queued、in-flight、仍被 live/raw 状态引用的内容；减去队列计数不证明对象已被 GC。

- 复用 transport 已知长度或现有内容准备结果；若必须估算，标明口径，不能为计数额外无条件 stringify 全文。正文、对象开销、共享引用与 decoded 超大单消息分别说明。
- 32 MiB 全局 raw 积压只是候选告警/压力阈值。此切片不截断、拒绝已接收事件，不暂停共享 RPC，不引入全局 scheduler。
- 若后续批准限制新启动，必须在不可逆 dispatch 前等待，并重验 authority/session/trust；报告降低峰值对应的排队与吞吐变化。
- 真正硬上限需要 producer backpressure 或有界 spool；前者可能阻塞控制消息，后者有写放大与恢复成本。两者都需要单独证明，不称为“小改动、收益确定”。

## E. 验收、止损与交付

1. P0 报告必须先于 P1 候选测量，保存源码/产物/build/负载与首次失败。先确认是当前代码，不用旧安装版本支持新实现结论。
2. 正确性失败先修，不允许调整 oracle 预期来适配实现；无法保持既有权限、原始证据与投递语义则否决。
3. P1 最多三轮单假设实验。若只有 L1 下降、完整路径 L2 未超出预登记噪声/最小可检测变化，则停止扩大，不启动 P2–P5；保留或撤回该优化另行说明复杂度收益，不能宣称用户变快。
4. 若真实瓶颈是 Provider 固有内存或模型等待，明确报告，不能用 Scry worker/native rewrite 替代归因。
5. 验证通过仅交付该切片。无自动后续阶段；安装、真实 Provider、手机、遥测和门禁按仓库既有授权规则处理。

未来实施时，复用并扩展以下已存在的 focused 测试；本次纯文档修订不执行它们：

```sh
npm run test:unit -- src/main/live-trace.test.ts src/main/run-outcome.test.ts src/main/remote/desktop-trace-delta.test.ts src/main/live-trace-ingestion.test.ts
npm run typecheck
```

完整进程/IPC/paint 证据需现有隔离 Electron 路径，不能仅靠 Node 单测。毫秒实验用 `.agents/skills/scry-performance-climb/scripts/timing-run.mjs` 加锁；新 workload 先注册、冻结，再运行，不能在本方案中把尚不存在的脚本写成现成命令。
