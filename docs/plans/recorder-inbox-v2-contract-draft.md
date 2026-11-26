# Recorder Inbox v2 契约草案

**待评审，未实现。** 目标是让已获准的常开宿主在首条事件上不启动 Node，也能把认领和首事件交给 recorder。落盘不表示认领、Git 基线、封箱或上传已经完成。v2 不迁移现存 v1 条目，也不改变晚基线的证据规则。

## 1. 位置：推荐工作区外的用户私有目录

| 方案 | 安全与工作区副作用 | 沙箱可写性 | 多工作区发现与清理 |
| --- | --- | --- | --- |
| 工作区内 `.scry/inbox-v2/` | 不可信仓库可以预置同名目录、链接或条目。冷启动必须额外验证；Git exclude 建好前会出现未跟踪目录。 | 工作区写入模式下更可能可用，仍取决于宿主。 | `recover <workspace>` 可直接定位；跨工作区仍需已知工作区列表。搬动或删除工作区会连带移动或丢弃积压。 |
| 工作区外的私有状态根 | checkout 内容不能预置入口，不污染 Git；仍须验证所有者、权限、路径与独立授权，不能把同一 OS 用户进程当作隔离边界。 | 普通宿主进程通常可写自己的状态根；受限工具或 hook 沙箱可能只允许写工作区。不能用普通终端测试代替真实 hook；不可写就回退，不放宽沙箱、不改回工作区内。 | 后台可从受信任的已授权工作区目录簿发现多个工作区，单工作区 recover 可直接算摘要。工作区迁移后旧队列不会自动改归属；诊断列出滞留项。清理只删已确认的收据和过期临时文件，不以工作区消失为理由删积压或隔离条目。 |

建议由受信任的集成安装器创建私有根（目录 `0700`、文件 `0600`），例如 macOS 用户的 `~/Library/Application Support/Scry/recorder-inbox-v2/`，Linux 的 `$XDG_STATE_HOME/scry/recorder-inbox-v2/`（默认 `~/.local/state`）。路径由安装运行时注入，不取仓库自报值。`workspaceKey` 是 canonical 工作区绝对路径的 UTF-8 字节 SHA-256 小写十六进制；`sessionKey` 同样由原始 `sessionId` 计算。两者都不做额外 Unicode 正规化。目录簿位于可信状态根，不靠条目反向授权一个工作区。

```text
<private-root>/workspaces/<workspaceKey>/
  consumer.json
  sessions/<provider>/<sessionKey>/
    slots/<sequence>.json
    overflow/<entryId>.json
    failed/<entryId>.json
    attention
```

旧 recorder 只从配置 `dataDir` 下的 runtime/attention 路径找工作，不扫描这个根。拒绝私有根落在任何已知 v1 数据根内、同名链接或路径重叠；即使旧消费者不扫描 v2，也不允许新旧消费者同时应用同一工作区的条目。

## 2. 条目、超限与写入顺序

条目是 UTF-8 JSON 对象。公共字段为 `schemaVersion: 2`、`entryId`（稳定 UUID）、`provider`、`sessionId`、`workspace`、`arrivedAt`（仅用于观测）、`kind`、`sequence`（固定 20 位十进制字符串）。`kind: "capture"` 还带 `action: "start" | "stop"`、`capture`（现有 `codelens.session-capture.v1` 上下文）、实际宿主 `event`、`payload`、`authorityRef`。`kind: "hook"` 带 `captureId`、实际 `event`、`payload`。首条 `capture/start` 包含触发它的首事件，消费者只应用一次。`capture/stop` 不能创建采集。未知版本、kind、重复键、越界身份或冲突的同 ID 内容明确拒绝，不能走普通 hook 分支。

### 大小依据与超限策略

实测于 macOS 隔离的 **Qoder CLI 1.1.93**。两次真实宿主启动，共 14 条原生 hook。一次是纯问答，一次运行了三个不同大小的 Bash stdout（16、4096、131072 字符）和一个非零退出命令。探针只记录收到的 UTF-8 字节数和事件类型，不保留 payload；原生 JSON 字节数与紧凑序列化大小相同。下表不含 v2 包装开销。这是试点容量证据，不是生产分位数；其中 131072 字符是命令输出，不等于 hook 一定收到同样大小的正文。

| 事件 | 样本数 | 原始 hook 字节数（升序） |
| --- | ---: | --- |
| `SessionStart` | 2 | 426、429 |
| `UserPromptSubmit` | 2 | 495、722 |
| `PreToolUse` | 4 | 568、586、590、594 |
| `PostToolUse` | 3 | 836、4920、37228 |
| `PostToolUseFailure` | 1 | 598 |
| `Stop` | 2 | 721、724 |
| `SubagentStart` / `SubagentStop` | 0 | 未采到 |

建议先把 **1 MiB 作为含包装的 inline 上限**，不是丢弃阈值。观测尾部集中在工具输出，37,228 B 不能代表更长正文、子 agent 或 Codex。正式冻结容量前采集两种宿主、含子 agent 的各类事件，报告样本量、p50/p95/p99/max、超阈比例和对可用空间的压力；也测超大单条的写入与恢复。

- 完整迁移模式：超过 inline 上限时，原始 payload 字节放入同一私有工作区根的旁路文件，条目只带固定相对标识、字节数和 SHA-256。先持久化旁路，再发布条目；读取时验证身份、大小、摘要，不能跟随链接，也不截断。确认成功后才回收。损坏、有引用但缺旁路文件、空间或独立磁盘配额耗尽，都归到可见失败；没有可靠落盘证据就不能报已入队。旁路总量与单文件硬上限要在上述样本和配额试验后确定。
- 只迁移首条的试点可先不实现旁路：在**本会话尚无任何持久 v2 条目、能证明本次未发布**时，整个首事件带原文走现行 v1 通道；一旦选择并写入 v2，不因单条过大把这条突兀塞进 v1。不允许“失败即丢”或用缩短的事件冒充原事件。

### 独占发布不是因果排序

候选方案不让 Python 与 Node 共用带租约的目录锁。生产者在目标槽目录写独占临时文件，限制权限并 `fsync` 内容，硬链接到**仅以序号命名**的最终槽（不能附 UUID 绕过碰撞），然后 `fsync` 目录并清理临时文件。目标已存在时比较 `entryId` 与摘要；本次发布结论不明时，先查已占槽和持久收据中是否有该 ID。只有确认是另一个条目占槽、且不会越过待确认的前驱时，才重试下一个槽；同 ID 不同内容则拒绝。若平台/文件系统不支持所需硬链接和同步语义，不直写；不换非原子写法。retry/unknown 必须查原 `entryId`，不能重复写另一份认领。

- **硬链接只保证一个槽一个获胜者，不保证谁先发。** `capture/start` 连首事件占槽 `1`；后续事件只能在读到同会话同认领的已发布首槽、并核对其持久收据后选择序号。无前置证据要缓存在已选通道，不先占后续槽。多个独立 writer 的宿主事件若还要求原发生顺序，必须有宿主提供且可验证的前驱/事件序号，或单写者串行提交；两者皆无时，分配到的顺序只是发布顺序，不得据此宣称还原完整顺序。
- 消费者只按连续前缀推进，不跳过没有明确终态收据的空槽。已确认槽要原子换成小收据（保留 ID、摘要及结果）而不是释放槽，避免滞后的生产者复用被消费序号。先持久应用及去重状态，再确认/清除载荷。已有普通 Node session-lock 仍串行化 `serve`、显式 `recover` 和生命周期更新；这是消费者锁，不是 Python/Node 跨语言序号锁。完整迁移若无法证明前驱，不应靠去掉锁或盲目跳洞上线；首认领试点只需单槽，不引入通用序号分配器。
- 崩溃窗口：一步中临时文件尚未链接时未发布；已链接、目录未同步时不能报已耐久，消费者处理前也要保证槽目录已同步；同步后通知前崩溃须靠扫描恢复。消费方应用后、清槽前崩溃靠持久收据/应用状态去重。过期临时文件和已确认收据只在无活跃写入、保留期满足时回收；未知结果、失败原文和仍未接管的工作不能按时间泛删。
- `attention` 只作提示。消费方先清提示再扫描本会话；发布方在记录持久后设置提示。扫描期间新提示保留，不在扫描结束时擦除。启动及显式 `recover` 都要扫描授权范围内全部 v2 待处理槽，不依赖提示文件；增量消费需有有界兜底扫描以补“已写槽、未发提示”。唤醒只发给核验过的消费者，不伪造 v1 attention；提示或唤醒成功不证明接管。

## 3. 受限冷启动与当前消费者

只有通过以下检查的 `capture/start` 才能在缺配置时进入初始化。检查 canonical 工作区、数据根及队列路径、所有者和权限；重算目录键；核对条目、原始载荷和上下文的宿主与会话；按现有合同核验转录路径与身份。独立于仓库及队列核对安装器预置的 authority、范围、指纹与有效性。`authorityRef` 只用于查找，不是批准。错工作区、路径逃逸、链接、禁用 sentinel、禁用环境、无效或禁用配置、无授权或指纹改变均拒绝。**普通 hook、任意文件和 `capture/stop` 永远不能开采集。** 初始化可复用现有配置、Git exclude、接收器逻辑；提交钩子仍独立验证，见下节。

无 Node 检测要核对 **包与进程两份证据**：

1. 可信安装包根与 `package.json` 同级的静态 `recorder-capabilities.json`：`schemaVersion`、`recorderVersion`、`entrypoint`、`entrypointSha256`、`inboxContract: 2`。Python 解析实际选择的 CLI canonical 路径并核对版本及摘要；不能读到或无法绑定则走旧 CLI。版本下限等首个实测兼容的正式版再固定，不凭 registry `latest` 猜测。
2. 已获授权的后台在私有工作区槽原子发布 `consumer.json`，字段含 `schemaVersion`、`workspaceKey`、`pid`、**OS 进程启动标识**、`instanceId`、`state: starting|ready`、`recorderVersion`、`supportedInboxContracts`、canonical `socketPath` 和构件摘要。ready 只在持有工作区唯一消费者身份、socket 已就绪后发布；退出只清本实例的状态。Python 无需 Node：核对文件权限路径、进程 UID、PID/启动标识（防 PID 复用）、实例身份与配套 socket 的既有 owner；可用有界 Unix socket 探测交叉核对实例，但失败不推断“没有 daemon”。

现有旧 daemon 会写 `<socket>.owner.json`（含版本和实例，不声明 v2），更老的可能只留 socket/启动标记。只要缺 `consumer.json` 或发现旧 owner、socket 仍可连接、版本未知、权限不足、正在启动或不一致，就按“可能有旧消费者”在首条落盘前回退。**冷启动例外不是“没文件就猜没进程”**：只有安装器/受信任 launcher 已证明工作区的旧实例排空、预留唯一的 v2 接管权并能唤起同一构件时，允许无 ready 文件先落盘；最小试点可以只认 ready，崩溃冷启动仍走旧路径。

检查后进程仍可能退出；不能用文件检查消除这个竞争。消费者需再次验 workspace/instance 并取得唯一路由权；写入真正受版本隔离保护的是独立目录。推迟接管时保留 v2 字节和失败原因，不启动第二个消费者抢占，不因为 PID 消失改往 v1 重发已落盘条目；已存在实例不由 hook 强行结束。

## 4. 上传环境和提交钩子

沿用 `UPLOAD_ENV_KEYS`：`SCRY_TURN_UPLOAD_ENABLED`、`SCRY_UPLOAD_DEADLINE_SECONDS`、`SCRY_UPLOAD_LOCK_WAIT_SECONDS`、`SCRY_MANAGED_UPLOAD_WAIT_SECONDS`、`SCRY_INSTALLATION_ID`、`SCRY_INSTALLATION_ID_FILE`、`TMCP_TRACE_URL`、`RATE_NATIVE_ASYNC_QUEUE_DIR`。验证字符串大小和语义，路径/URL 仍受安装授权限制。只对当前认领生效，不改 daemon 全局环境，不记录值。不携带凭据、`PATH` 或 `SCRY_RECORDER_COMMIT_HOOK`。

提交钩子授权**待评审**：可用 `authorityRef` 查可信安装器登记的 callback 与指纹，或由可信宿主 launcher 预先走现有验证入口登记 grant，条目只引用 grant 和摘要。两者都要重验 canonical cwd 和可执行文件/配置指纹，不能把队列中的路径当作授权。

## 5. 恢复统计与混版本

`recover --json` 保留现有 `recovered`、`pending`、`expired` 的轮次语义，增加版本化 `inbox`：`schemaVersion`、`scope`、`scanComplete`、`consumed`（新应用并持久确认）、`deduplicated`、`quarantined`（本次新增隔离）、`remaining`（尚待处理）、`failedRemaining`（仍保留的终态失败）。枚举不完整时余量为 `null`，不能报 `0`。消费不等于轮次封箱或上传。

| 组合 | 行为与必测 |
| --- | --- |
| 新 Python + 旧 recorder | 插件能力或旧进程检查未通过，走 v1；验证未知/错误清单、PID 复用和回退只提交一次。 |
| 旧 Python + 新 recorder | 维持 v1，无冷启动特权；验证原顺序及无隐式迁移。 |
| 新 Python + 新 recorder | 只消费已授权通道；验证宿主沙箱、多个工作区、硬链接冲突、认领前缀、跨进程崩溃、无 attention 恢复及超限保真。 |
| 新安装 + 旧 daemon / 受控交接 | 不按安装版本猜活进程；测试旧 `serve` 及 `recover` 不触碰 v2 sentinel，版本探测、落盘及接管之间的退出竞争，以及新实例只消费积压一次。 |

## 6. 最小上线切片与分阶段建议

估算只给相对工作量与模块数，含故障测试，不是交期。

| 阶段 | 改动量与收益 |
| --- | --- |
| 0. 预热和看见失败 | 小：CodeLens launcher 和诊断约两个模块。让常开客户端先在受控后台启动 recorder、验证 ready；必要时在授权后增加脱敏失败计数。缩小冷启动窗口，不声称消除丢会话。 |
| 1. 只直写首认领的受限试点 | 中：Python 写入/选路、静态能力清单和进程状态、Node 单槽接管/收据、诊断与主机测试，约 4–5 个模块。工作区外私有根、已验证 ready 的唯一消费者、单槽原子发布、原始首事件、权限校验和恢复扫描都不可省。首钩子不启动 Node；其后在**认领接管 ACK（含 capture 身份和接收能力）持久化后**沿用 v1 的既有活动会话通道。从首槽落盘到 ACK 间的事件必须按序暂存，不能先送 v1 或丢弃。 |
| 2. 冷启和整会话迁移 | 大：再加入 launcher 排空/接管权、受限无配置初始化、多 writer 的前驱/槽位合同、旁路大载荷、混版本观测和清理。完成后才能覆盖无 ready daemon 的首事件，并让整轮不再依赖 v1。 |

“不能混用”指不能让 v1、v2 **独立接管同一会话**，并不是必须一次实现两个阶段。第 1 阶段的折中是一条明确的 v2→v1 路由交接：同一消费者、一个持久的认领、首事件不转发第二次、ACK 前有序缓冲、失败可见。代价是还要维护交接/缓冲，接管前不能靠旧通道止损，并且必须先预热。若跨语言交接及缓冲成本接近整套、或目标是从一开始就支持真正无 daemon 的冷启动，则不要把这个试点当作解决方案 4 已上线。

## 7. 不做会怎样

目前未确认的冷启动保存在 CodeLens `capture/uncertain`，本机 `doctor` 和 `health --json` 可见计数及原因；已有 heartbeat 不带这部分诊断，远端看不到。现有 24 小时过期清理不重放认领，能看见失败不等于能补回漏采。

**更低成本的缓解是预热**：从长期运行的、已授权的 launcher 提前保持 recorder ready，并可在本地告警 hint 变差时报告，不在首钩子的时限内等待启动。它对“Node 冷启动排队”有效，但不能保证机器睡眠后、daemon 退出/升级、后台未运行、沙箱限制或资源耗尽时接住首事件；不持久化的首事件仍可能丢。应先测预热前后的未确认比例、ready 覆盖和常驻资源成本。只有在失败集中于冷窗且预热后可接受时，才足以延后 v2；若仍存在不可见或无法恢复的丢失，继续做独立耐久收件箱。若要上报本地 uncertain，只报经授权的聚合计数/原因，不上报会话 ID、路径或载荷。

## 8. 已知风险（0.2.92 隔离实测）

| 写旧路径的内容 | 实际结果 |
| --- | --- |
| 有配置、显式 `schemaVersion: 2` | 移入 `inbox-failed`；旧 `recover` 统计仍全 0。 |
| 有配置、冒称 v1、`kind` 未知而其余是可识别的 `SessionEnd` | 落入普通 hook，条目被删除，既未认领也未隔离。 |
| 无配置 | 返回全 0，条目原地未读。 |

不能把旧 `recover` 的全 0 当作空队列。另做了工作区外目录的 0.2.92 隔离对照：无配置时 `recover` 未触碰 v2 槽；初始化后，旧 `serve` 接受唤醒、v1 对照条目被消费，随后显式 `recover` 结束，v2 槽字节仍不变。这只验证旧版不发现该路径，未验证 v2 原子性、新旧交接或受限沙箱可写性。本文不批准任何实现或上线。
