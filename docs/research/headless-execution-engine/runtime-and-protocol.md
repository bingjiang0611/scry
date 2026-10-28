# Scry 无界面引擎：运行时、协议与 Provider 治理

**状态：条件性架构附录，尚未实现，当前 P0/P1 不引入新宿主或协议。** 本文属于[完整方案总览](../headless-execution-engine-design.md)；先读 [首个切片](first-slice.md)。本篇仅在测量或明确产品需求触发后重新评估。

第 4–6、10 节：宿主选择与既有 daemon 对齐、未来收据/事件流控、Provider 和资源治理。章节编号保留用于追溯评审，不表示这些组件全部需要实现。

导航：[运行时与协议](runtime-and-protocol.md) · [数据与客户端](data-and-consumers.md) · [恢复与验收](recovery-and-validation.md)。

## 4. 进程、启动、认证与版本

### 4.1 以需求选择宿主，不预订私有 Node

| 已验证需求 | 首选评估路径 | 进入前的验证 |
| --- | --- | --- |
| 仅消除重复计算/编码 | 保持现有进程 | P0/P1；不要为增量索引先创建进程边界 |
| 已证明主线程 CPU/同步数据库阻塞 | 复用现有 Node worker 模式 | 队列、clone、总内存、数据库所有权；worker 不自动解决 native crash 隔离 |
| 需要进程级隔离，默认退出语义不变 | 优先 `utilityProcess` 原型 | app ready、native addon、消息/退出/崩溃、签名与打包实测 |
| 明确批准退出桌面后继续执行，且上述方式不足 | 再比较现有 recorder 宿主经验与独立 engine 可执行文件 | 无客户端审批、ownership、恢复、升级、签名/公证和总成本 |

`utilityProcess` 复用 Electron 分发的 runtime/Helper，通常无需第二套 Node 发行版；不等于原生模块加载与 hardened runtime 已自动验证，也不等于独立 daemon。使用其父子消息能力时无需先开 UDS 服务；renderer 仍经过 typed preload 和可信 broker。

私有 Node 24 从必选项改为远期候选。若最终选用，需估算新增压缩/安装字节、启动与常驻 RSS、Node 来源/许可证、签名公证、JIT/library-validation entitlement、`better-sqlite3` 第二套 ABI/native package 与更新成本。不能只写“有 manifest”就认为成本已覆盖。

仍使用受校验的包内绝对路径、环境清洗，不允许仓库指定 engine executable。独立 recorder 保持原有 Node 20/22/24 和私有 CLI RunAsNode 合同；新 engine 的选择不扩展 core 依赖或放宽 Electron fuse。

### 4.2 与既有 recorder daemon 对齐

[daemon.ts](../../../src/core/turn-recorder/daemon.ts)、[daemon-transport.ts](../../../src/core/turn-recorder/daemon-transport.ts)、[daemon-owner.ts](../../../src/core/turn-recorder/daemon-owner.ts) 已实现 HTTP-over-UDS、协议版本 `2`、8 MiB request body 上限、owner marker、detached 启动及默认 30 分钟 idle。这些应纳入复用评估，原方案的遗漏已修正。

| 能力 | 复用决定 | 为什么不能直接照搬 |
| --- | --- | --- |
| JSON/HTTP-over-UDS、路径长度处理、请求上限 | 独立宿主成立时优先评估共用纯 Node helper | recorder 是 workspace hook/control 请求；engine 还需 actor/scope、credit、订阅和多客户端撤权；版本 header 不等于认证 |
| owner marker、启动锁、等待退出 | 复用已验证测试与身份/退出证据模式 | recorder 以 workspace 为范围，engine 以 userData/活动 Provider 为范围；两者不能共享 marker 或互相停止 |
| `stopOwner` 与旧 marker 处理 | **不直接复用停止策略** | start 路径在条件满足时终止旧 owner；helper 按 PID 发信号，不能据此宣称具备 engine 的未知 owner fencing |
| idle/detached | 仅作经验来源 | recorder 的 idle 更新与 hook 生命周期不适用于审批等待、共享 transport 和用户后台任务 |

若确需抽取公共 transport，保持 Electron/SQLite/Provider-free，分别验证 App 与独立 CLI，不能为“统一”扩大 recorder 权限或更改其协议。复用不足时记录具体差异再决定新实现，而非现在预建第二套 IPC 框架。

### 4.3 独立宿主才需要的发现与所有权

以下仅约束未来独立 daemon；当前切片与父子 `utilityProcess` 原型不创建 endpoint discovery、重连 token 或全局 writer 框架。

- macOS 首先验证私有 UDS；其他 OS 按实际分发面验证，不为本方案扩展平台支持。路径权限、owner、符号链接、canonical userData 与进程身份都要检查；不能回退为任意 localhost 接口。
- 单一执行所有者在启动前获得原子 claim，记录进程启动身份和 epoch。socket 不通/heartbeat 超时不证明旧 writer 已退出；身份未知时阻塞新 writer，不沿用旧 recorder 的自动停止策略。
- 认证 bootstrap 能力不进入 argv、renderer 或日志；actor/scope 由可信 broker/网关绑定。build/version 是兼容性证据，不单独充当身份认证。
- job 和控制响应带 epoch；旧响应不能推进新状态。升级先停止准入并确认 writer 退出，不以 forceKill 请求作为退出证明。
- 同 UID 恶意并发者仍不在原有保证范围；连接能力与文件权限不能被描述为 sandbox。

### 4.4 协议选型与兼容

不再预定“长度前缀 JSON frame”。父子宿主优先使用已有消息通道；独立宿主优先评估 HTTP-over-UDS 的纯 transport 复用，并单独验证订阅/credit 与大内容分块。二进制 codec、共享内存和新 framing 只有固定 workload 证明必要时才进入。

未来握手须明确 protocol/build/schema/epoch、能力与容量；不兼容时拒绝写入，不用任意 fallback 掩盖。§5–6 描述领域语义，不绑定某一 transport，也不要求 P1 修改现有远程协议。

## 5. 控制面：请求、收据与状态机

### 5.1 操作信封

下列字段是拟定协议，实施时应映射现有 typed contract，不复制一套 Provider 状态枚举：

| 字段 | 约束 |
| --- | --- |
| `protocolVersion / engineEpoch` | 校验版本与当前宿主，不接受旧 epoch 写操作 |
| `actor / scope` | 由认证 broker/网关绑定，不信任 renderer 自报的 owner、cwd 或权限 |
| `clientEpoch / requestId` | engine 签发的有效客户端命名空间＋单次操作标识 |
| `operation` | 明确 allowlist，如 start、cancelQueued、stop、answerQuestion、readReceipt；无任意 shell/path/URL |
| `target` | 现有 project/conversation/session/profile 绑定；engine 重验 canonical 身份与权限 |
| `payloadDigest` | 绑定规范化业务参数；不把凭据或正文写入遥测；需要执行的正文存在授权存储中 |
| `expectedRevision` | 修改目标状态时做冲突检查；过期问题、run 或上下文不能被自动替换 |

同一 `(actor, clientEpoch, requestId)`、同一 digest 返回已有收据；不同 digest 返回冲突。客户端超时之后只能先读收据，不自动换 requestId 重发。

### 5.2 准入与派发

```text
validated → queued → reserved → dispatched → accepted / rejected / outcome_unknown
              │          │
              └─ cancelled / expired / authorization_changed
```

- `queued`：输入和收据已持久化并同步；Provider 尚未收到输入。
- `reserved`：资源与身份已预留，但还没有外部副作用；崩溃恢复后可以释放资源并重新排队。
- `dispatched`：先写 durable fence，再尝试调用 Provider；这之后不能把“没有回复”当作没有执行。
- `accepted`：Provider 的实际合同提供接受证据；仅进程 spawn 成功或工具 dispatch 成功不够。
- `outcome_unknown`：可能已被接受，但缺少证明。不自动重放；提供已有 native session/receipt 证据和用户可选的恢复动作。

容量等待发生在不可逆的 `dispatched` 转换之前。排队结束后重新执行 workspace authority、session 排他、auth gate、trust/fingerprint 与配置版本检查；参数不静默换成新配置。

取消队列与派发由同一串行控制状态机竞争：取消先提交则绝不发送；dispatch fence 先提交则进入 run-stop/未知结果流程，不谎报“已取消且未执行”。

### 5.3 有界收据保留

有效客户端 epoch 有明确到期时间；超过有效窗口的旧写请求只返回过期/未知，不作为新操作执行。只有命名空间到期且操作达到 durable 终态后，才可清理普通 dedupe 记录；不能只因命名空间到期就删除尚未派发的输入。

`queued/reserved` 的输入、收据和关联记录保留至明确终态。clientEpoch 到期只禁止该客户端继续发起写请求，不自动取消已接收操作；内部恢复使用原收据，而不是重新执行一条过期客户端请求。队列自身到期需先持久化 `expired` 状态，并与 dispatch 串行竞争。

活动 run、未确认副作用、未收敛证据和远程 durable intent 的关联记录同样不随普通收据 TTL 删除。远程网关保持现有 intent fence，不能换一个 clientEpoch 重派已标 dispatched 的 intent。用户明确选择“重新发送”才创建新逻辑操作，并告知可能重复的后果。

### 5.4 运行完成不是一个布尔值

控制状态、Provider 状态、证据状态、DB 投影状态分开维护：

```text
Provider: starting → running / waiting_input / background_wait → settled / interrupted / unknown
Evidence: collecting → draining → committing → committed / failed / partial
DB: pending → projected / failed
```

这些是设计上的正交维度，不直接替换既有 UI 枚举。迁移先复用现有终态时序；新增公开状态需 typed contract 与文案一起演进。绝不因为 UI 已显示终态或 Provider result 到达，就跳过 hook/diff/内容引用/recorder 的收敛屏障。

## 6. 数据面：mutation、投影与流控

### 6.1 事件表示

保留既有 `TraceEvent` 身份、Provider provenance 和 lifecycle 语义。新增内部 mutation envelope：

- `runId`、`eventId`、`eventRevision`：同一事件的 enrichment/replacement 不新增逻辑调用。
- `runSeq`、`engineEpoch`：顺序与连接恢复边界。未 durable 的尾部可能在崩溃中丢失；不能在新 epoch 直接沿用旧 live cursor。
- mutation 类型：append、replace、textAppend、contentAttached、terminalBarrier。
- `baseRevision`：替换/增量应用的前提；不匹配时明确 reset，不猜测合并。
- 小型 bounded metadata 与已有内容引用；不在所有队列保留一份全文。

run actor 维护 event-ID 定位和显式 dirty revision。已有删除、文本合并、最终正文替代必须统一经该入口维护索引，禁止额外原地改数组却不更新 revision。

分块事件序列降低小变更的引用复制。对外只发布不可变版本；不把内部可变容器直接交给 React 或其他线程。

### 6.2 三个水位

| 水位 | 能证明什么 |
| --- | --- |
| `observedSeq` | 当前 engine epoch 已看到的 live 变化，不保证持久化 |
| `durableSeq` | mutation 及其必要内容引用均已达到持久化屏障的连续前缀 |
| `projectionSeq` | 对应 DB/摘要投影已应用的 durable 前缀；不同投影分别记录 |

UI 可以先显示 bounded live 信息，但不能把它标成已归档的权威全文。worker 不能推进超过 journal 的 durable 水位。重新连接携带 epoch、run revision 和游标；旧 epoch、超出保留窗口或缺口返回显式 snapshot/reset。

### 6.3 三种确认不能混淆

1. **控制收据**：某个用户操作处于哪一步，不是事件处理 ACK。
2. **持久化确认**：指定前缀达到耐久屏障，不是 Provider 已结束。
3. **消费者 credit ACK**：允许再发送多少数据，不是 canonical evidence 已提交。

迁移前半段保留现有 React commit 后 ACK。以后只有消费者 store 具备严格容量、可观测落后和 reset 合同时，才可在“已被有界 store 接收”处确认；store 无法接收时不得 ACK。仅仅调用 `setState` 或向无界队列 push 不算完成消费。

### 6.4 初始容量候选

以下仅是后续协议/持久化实验的候选，不属于 P0/P1 的产品限制。当前 raw 队列部分只做字节/等待观测与压力报告，见 [首个切片 D](first-slice.md)。正式限制先验证合法输入和溢出行为，保留现有 API 允许的能力。

| 对象 | 初始候选 | 触发后的处理 |
| --- | --- | --- |
| 数据 frame | 目标 256 KiB，最大 1 MiB | 大正文走内容引用/分块；不截断合法事件 |
| 每消费者未确认数据 | 4 MiB | 停止向该消费者增加在途数据；慢客户端 reset 不影响权威记录 |
| 全局待持久化 raw 队列 | 32 MiB、单 run 8 MiB 的候选压力线 | 当前只观测/报告；限制新准入需另行验收，spool/背压尚未实现，不丢 raw |
| query worker 并行 job | 首轮最多 2 个 | 有界排队、可取消纯查询；控制请求不进入这条队列 |
| DB 投影 job | 按引用计数与实际借用字节双预算 | durable outbox 留存；不无限结构化克隆全文到 worker |

未定义固定全局 active-run 数：Provider 内部 fanout 和内存不同。实施阶段先测量，形成保守的软预算和明确排队策略。没有可靠进程树数据时显示资源成本 unknown，不记零。

合法的超大 native 单消息可能在 decoder 完成时就超过上述预算。必须计入真实峰值：先实现 spool/流式处理或 provider-specific 限制，不能把“入队前已有的大对象”排除计数后宣称硬内存有界。

## 10. Provider、资源调度与权限

### 10.1 保留 Provider 差异

| Provider | 保留的当前路径 | 不做的推断 |
| --- | --- | --- |
| Claude | SDK query/原生 CLI、原生 resume 与审批 | resume 不等于可复用同一进程 |
| Pi | catalog pool 与精确 session 的 Rotom RPC pool 分开；history-reader authority 保留 | 安静不等于 idle；不虚构 MCP 状态 API |
| Codex | 按 authority/context 绑定的 app-server | 一个 run 停止不能杀共享 transport |
| OpenCode | workspace server、指纹重验与 idle lease | 不能用全局 server 合并不同授权上下文 |
| Qoder | 真实 query、control session 的初始化/实时证据区别 | 延长缓存不等于刷新原生配置 |

参考 [Provider 类型](../../../src/main/providers/types.ts)、[停止生命周期](../../../src/main/run-stop-lifecycle.ts)、[Pi RPC](../../../src/main/providers/pi-rpc.ts)、[Pi catalog](../../../src/main/providers/pi-catalog.ts)、[Codex](../../../src/main/providers/codex.ts)、[OpenCode](../../../src/main/providers/opencode.ts)、[Qoder](../../../src/main/providers/qoder.ts)。

### 10.2 调度规则

- capacity admission 位于 context/auth/trust gate 之外的前置等待阶段；真正执行前仍重新获得现有身份排他并重验全部权限。
- 资源预留覆盖启动与活动执行，直到实际 settlement；不能以 root 最后一段文本或临时 0% CPU 释放子任务容量。
- 优先级：停止/审批/收据查询最高；明确交互高于后台刷新；队列 aging 防止低优先级饥饿。
- warm pool 的 idle count/字节预算跨 adapter 观察，回收仍由 adapter 按真实可复用条件执行，不跨身份混用。
- 动态压力只能减少新准入/后台任务，不自动 SIGSTOP、杀进程或重写已获批任务。
- 根 run 上限不保证 descendant 上限；无法观测的子进程成本标 unknown。
- 首版不向 OS 申请新增 sandbox/cgroup/容器语义，不把软预算宣传成硬内存隔离。

### 10.3 权限与问题所有权

- broker 继续通过 `handleTrusted` 校验 sender/frame/origin；engine 再校验 actor、scope、schema、canonical cwd/path 和 operation authorization。
- 自动授权的 MCP/Hook/plugin/recorder callback 策略不变；canonical cwd 与 fingerprint 失败仍拒绝。
- 问题由 engine 持有明确 ID、run/revision、Provider 来源和有效期。多个客户端的回答通过同一状态机竞争；过期或重复回答不再次写入 Provider。
- 没有可用审批客户端时，保持等待或按 Provider 原生超时处理。不能因为无界面而自动批准。
- 凭据只出现在必要的受信任边界，沿用环境清洗；不进入 renderer、日志、收据摘要或性能记录。
- 外部文件链接、单目标引用、只读预览和系统打开保持现有合同；worker/engine 不接受可换路径的裸文件能力。
