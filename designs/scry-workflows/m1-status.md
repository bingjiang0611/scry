# M1 进展：停止收据、可信观测与安全退出准备

## 本次新增：安全退出准备（仍不是完整 M1）

- 在 Electron `before-quit` 的既有清理之前，WorkflowService 先冻结新的工作流规划、确认和派发。并发退出请求共用一次准备流程；被阻止后保持工作流可检查、可再次停止，不自动恢复旧任务。
- 对当前仍由 main 持有控制的执行和规划，先写入有界、确定性的 shutdown stop command/规划停止意图，再调用现有 canonical stop/abort 链。持久化失败（包括写入后 ACK 丢失）不发未知控制信号、不退款、不清除未知预约。
- ready 要求当前作用域已得到真实收敛证据且必要结果已持久化。业务结果仍可为 `unknown`，不能因此伪造 completed；迟到的真实 scope settlement 与结果写入确认后才退休控制。停止 ACK、普通 Provider 返回、缺少 PID、实时观测不可用、超时或仍无作用域证据的恢复 unknown 不会放行；存储/初始化失败与未确认分别返回 typed preparation 结果。
- 复用既有 6 秒有界策略；准备失败不会进入 remote/terminal/provider 等破坏性清理。冻结是同步的，收敛等待依赖 runner/planner 生命周期通知而不是重复历史扫描；deadline 覆盖初始化、扫描和停止 journal，取消后旧 generation 不能碰新 workflow；规划 journal 按 workflow 串行写入并以最终成功写入为 commit proof。所有调用者共用包含 deadline 的最终准备结果；超时后即使原子写入迟到，也不能发新信号。生产 host gate 已抽出并补回归，父会话完成当前包后台离线验收；没有未确认工作流作用域时仍走原清理路径。
- **明确未完成**：这不是完整 M1，也没有增加强制丢数据退出、后台 daemon、Provider 能力统一、自动恢复、完整 UI 管理面或真账号/全场景 App 验收。恢复后的 unknown 仍需用户检查/处理；历史不可用时“是否允许桌面退出”的最终产品决策仍未批准，本轮只 fail-closed 阻止安全退出，不把它宣称为已解决。没有发现用户历史实际损坏，不能保证磁盘故障或外部改写永不发生；不会用空数据或伪成功掩盖。未推送、未安装。

本轮是在 M0 之后推进 M1 的一个交付块，不代表 M1–M6 或完整 Workflow 功能已完成。用户明确先不处理此前整仓七项门禁失败；本轮没有重跑整仓门禁、放宽期限或修改那些路径。

### 安全退出的父会话证据（2026-10-21）

代码检查 `/tmp/scry-m1-safequit-review.uPqakG/`；最终独立离线 App 现场 `/tmp/scry-m1-quit-final.nTJ6cR/`。没有复用旧 workflow、账号或旧 userData。离线脚本是原获准脚本的逐字副本，hash 相同；新临时项目，四角色显式选择该脚本、offline-fixture/deterministic、full_access。仅此离线路径，不代表其他 Profile 或真实账号授权。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 父会话负对照 | 同步冻结/历史扫描、取消后旧规划复活、超时旧准备停止新根、内存停止候选假确认均先红；再补超时尚未关闭提示时迟到发信号、并发调用不共用 deadline、迟到真实 scope 不退休、分页读取期间未处理拒绝，先红后修正 | `before-final.log`、`repair-before.log`、`planning-ack-before.log`、`final-boundaries-before.log`、`unhandled-before.log` |
| 最终 focused | 5 文件 **58 passed**；包括真实 FileWorkflowStore、必要写入前后与失败控制、错误类型拒绝且原文件不改，unknown 业务状态未被提升；1000 派发边界单列如下 | `parent-final.log` |
| 扩大范围首轮 | 14 文件 158 passed / 1 failed：1000 次派发边界 5 秒超时；保留首次失败，不算整组通过 | `affected-final.log` |
| 相同边界的串行对照 | HEAD 原 runner 与当前 runner 各单独通过，负载 75–103 / 10 cores，均 highLoad=true；不作耗时优劣或失败原因归属结论。未加时、缩负载、skip 或修改原断言 | `cap-baseline.log`、`cap-current.log` |
| 类型 / 构建 / 包 | Node/web typecheck 与完整 `pack:artifact` 通过，含生产安全、remote、文件等 smoke；未安装 | `typecheck-final.log`、`pack-final.log` |
| trace.delivery | 5 次均 2 messages / 165996 bytes；固定计数门禁通过，不是退出延迟测量 | `performance-final/measure.json` |
| 完整 App 的真实存储故障 | 只读新 fixture 工作流目录，停止写入失败后普通退出被阻止；原文件 hash 不变、native abort 0、scope/slot 仍活、snapshot 可用。提示待确认期间再次退出只有一条提示；恢复权限、明确再次停止后才 native abort 1，终态收敛 | `veto-result.json`、`case.log` |
| 新批准根的普通退出 | 新根运行中从真实 main `app.quit()` 进入生产 before-quit；先落 stop receipt，再 native abort，4 条 canonical records 持久化且 scope 均 settled 后退出；无 force kill | `before-quit.json`、`quit-result.json` |
| 冷重开 | 2 历史只读观察、4 prompts / 2 abort 不增加、4 records hash 不变、slots 0；原生窗口不可见且未聚焦 | `cold-result.json`、`closed.json` |
| CLI / 现场完整性 | 私有 CLI doctor healthy，turns verify 4 records / errors [] / pending 0；旧真实现场 16 源 hash 未改、18 个最终 fixture CLI 均已退出 | `doctor.json`、`verify.json`、`integrity.json` |

App **0.2.210** / CLI **0.2.49**，asar **`25ff05a75c5d75903ac4243ab0f3b3a860694ad558335fb476cdffd880f3b1eb`**，快照 `app.asar`，生产源码与 `scope.json` 绑定。App PID 35271、36638 已退出，未操作用户 App。受控 OS 警告由测试 main inspector 拦截并延迟应答，以保持后台不抢焦点；验收了生产分支与清理门控，不冒充警告窗口视觉或人工验收。正常发送/批准使用隔离 renderer 原生输入；无真实模型。该脚本省略 upstream usage 是既有故障注入，不代表正常 SDK 协议；CLI 的 4 项 legacy_unset 元数据仍不完整，不把结构有效当作身份完整。

前置现场 `/tmp/scry-m1-quit-app.KvnRah/` 首次尚未产生 workflows 目录，测试枚举提前失败，native prompts 为 0；明确建立空 fixture 目录并只从已完成的项目选择继续，没有重发计划。该现场冷重开首次只等 URL 未等 title，连接失败；仅重连登记的同一实例，不重启或重发。旧 `case.log` / `failure.json`、`cold-case.log` 保留，不当作生产失败或隐去。最终删去未消费的 planner Promise、修正初始化失败提示不再声称未知状态可查看后，重新完整打包，并在上述最终新现场从头验证；没有复用旧工作流或覆盖旧证据。

## 已接通

- App 的 `workflow.stop(workflowId, commandId)` 先同步阻止新派发，再持久化停止意图，成功后才调用既有 canonical 停止链。IPC 校验两个身份，旧的无 commandId 请求拒绝，不隐式生成新命令掩盖重复投递。
- 同一 commandId 并发重投共用收据；缓存逐出和 App 重开后仍读持久收据，不重复发送可能已执行的信号。用户再次点击生成新的 commandId，沿用原 run 身份校验、优雅停止窗口及安全升级，不退款、不替换 Provider。
- `true` 仅确认停止意图已经持久化，不证明 Provider 接受、信号成功或进程停止。没有安全存活句柄时，新命令返回 false，UI 显示不可控制；已有收据仍可只读重放。
- 保存失败时不发信号，也不继续后续 Agent；未收敛继续占槽位。失败的内存候选不能在命令缓存逐出后变成“已持久化”的假 ACK。即使看到旧内存意图，也要核对磁盘记录，缺失则报未确认错误，不重发。
- 初始化期间停止会立即阻断派发，但等待初始执行记录检查/保存结束后再写停止意图，避免执行把自己刚保存的记录当成旧运行而拒绝。初始化失败不产生 Provider 调用或停止信号。
- 每根最多 **256 个停止请求**，不驱逐旧身份来允许重放；达到上限拒绝新的请求。若真实操作需要更多，先改为分页的独立控制日志并保留全部去重身份，再考虑提高上限，不清空旧收据或未知容量。
- UI 以“已请求停止，等待收敛”和“再次停止”区分请求与终态；历史 unknown 不被提升成 stopped。所有新增用户文案集中在现有 copy 模块。

## 实际验证

证据目录 `/tmp/scry-m1-stop.7jb82s/`。没有真实模型、账号费用探针、安装、push 或用户 App 重启。完整 App 验证仍使用原先获准的固定离线 Pi 脚本和原临时项目，四角色显式绑定同一 profile/model/full_access。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 原实现负对照 | 相同停止命令立即发两次信号，新增检查失败 | `before.log` |
| 自审补充负对照 | 保存失败、缓存逐出后，旧候选错误返回 true；检查先红，修正后绿 | `eviction-before.log`、`workflow-reviewed.log` |
| Workflow + canonical stop 生命周期 | **10 文件 / 86 passed**，新增 10 项，覆盖持久化先于信号、重复/明确再次停止、失败不派发、真实 FileWorkflowStore 重开、缓存逐出、初始化竞态、256 上限和损坏日志拒绝 | `workflow-reviewed.log` |
| Node/web typecheck | 通过 | `typecheck-reviewed.log` |
| 隔离 UI 原生输入 fixture | 通过；两次明确点击产生两个不同 commandId，等待收敛/未知显示、焦点和重挂不重跑均保留；隐藏窗口、假 bridge，不冒充完整 App | `ui-final.log`、`current-wide.png`、`current-narrow.png` |
| 最终 App 构建、产物与安全 smoke | 构建/产物校验及前四项 smoke 已完成；进程随后被中断，剩余 desktop-remote smoke 单独补完，不把中断称为整条命令成功 | `pack-reviewed.log`、`desktop-remote-final.log` |
| trace.delivery 计数门禁 | 5 次均 2 messages / 165996 bytes；highLoad=true，无毫秒提速结论。该计数不测停止延迟；停止前新增一次必要日志写入 | `performance/measure.json`、`performance.log` |

首次 UI 扩展在 remount 后仅等旧 DOM 存在，过早读取导致失败；改等具体“未知”状态提交，没有延长上限或削弱原断言。保留 `ui.log`。首次 App 重开观察过早连接 CDP，ECONNREFUSED；根据登记 PID/启动日志确认同一 App 已启动，只重连该实例，不重启或重发 workflow。保留 `reopen.log` 与 `reopen-final.log`。

## 完整 App 的逐包范围

1. 本轮首包 asar **`2bd68592dd745243fe6d4e60fb778b343cf5d9256e483ee652bec2eafc4d1cc8`**，快照 `app.asar`：通过真实生产 App/preload/trusted IPC/Pi adapter 完成一次规划、批准执行、观察输出后停止。新 workflow `workflow-5a10645346ac27bcc128bfb5f569ed2038ae6cc8f5cbc9fd0090dfec795a9225` 为 stopped、1 attempt、settled、slots 0。实际按钮保存一个停止收据；相同 ID 经生产 IPC 再投两次，原生 abort 仍只有 **1**。非法身份被拒绝，新 ID 控制已收敛 scope 返回 false。
2. 首包重开后冷收据再投返回 true、原生 abort 仍 1、总 model prompts 仍 **14**，五个历史 workflow 只观察恢复。原十二条记录哈希和旧真实现场十六个源文件哈希未改，未清除旧 2 unknown / 1 pending。见 `case.json`、`reopen-result.json`、`reopen-final.log`。
3. 随后修正缓存逐出后的假 ACK 边界。**最终包** asar **`09ba1782934f99336c43589c63e1d1abc2e7f4b79c69d0e8d92e20f07182c60e`**，快照 `app-reviewed.asar`：补验生产 IPC 冷收据、无句柄拒绝；14 prompts、原生 abort 1 均不增加，检查期间十四条 canonical records 哈希不变。最终包没有另开新模型任务；缓存逐出异常路径由上表先红后绿回归证明，不借首包正常停止宣称该异常分支已做真实模型验收。见 `final-scope.json`、`final-app-result.json`。
4. 当前生产源码 SHA-256 与对应包的 scope 文件绑定。App 仍为 0.2.210、私有 CLI 0.2.49，没有安装。原 `dist` 是可变构建目录，先前 M0 离线 asar 13017… 已不在该原路径，不能拿现在的文件校验旧包；本轮两份 asar 快照单独保留。

自有完整 App PID 13681、25157、65458 已按 executable、userData 和出生时间重验后关闭，关闭前 scope 已收敛。没有对用户 App 发送停止或启动命令。

## 本次可信实时阶段观测（仍不是完整 M1）

- Provider 请求新增了可选、typed 的 Workflow live observation callback。Pi adapter 只从真实 native `tool_execution_start/end`（必须有原生 `toolCallId`）和非空 `text_delta`/`thinking_delta` 发出 `pi_native` 证据；buffered fallback、快照、心跳、turn/agent start、retry intent、空增量不建立模型进展或模型/配额等待。其他 Provider 暂无原生工具/增量映射；其真实权限请求仍可被 main 观测，不能因此声称原生阶段 parity。
- canonical `startAppRun` 把观察 callback 绑定到 workflow 的 `workflowId/taskId/attemptId/runId`；runner 通过 epoch-scoped、主进程拥有的 bounded projection 路径发布，不依赖 renderer 可见性或 `isRemoteRun`。重叠 tool/permission ID 独立计数，结束一个不会清掉其他项；最后一个可信等待结束后状态回到 `unknown`，不猜模型已恢复。终态、停止、recording 和 slot settlement 没有改用 live 事件驱动。
- progress 推送、snapshot 与 list 共用活跃内存投影，只暴露 source、coverage、status、bounded counts/IDs、epoch、观察时间，不带中间文本。live revision 独立于持久 revision，迟到的同版观测/历史回包不覆盖新数据；每个 root 32 ms 合批、每千次同步增量不新增磁盘写入。File/Memory store 均剥离 live，历史读取也剥离残留字段；重启不恢复旧 epoch。确认 scope 收敛立即关闭观测，即使随后记录写入被阻塞，槽位仍等持久化才释放。
- 明确上限：每 attempt 各 32 个 tool/permission ID、每 ID 256 字符、进展计数饱和于 10000；root 最多展示 32 个 attempt 并提供总数。超限显式 truncated，不把采样 ID 全部结束当成没有其他等待，不将截断后的阶段当完整证据。trackedToolCount 是被跟踪的 ID 数，不是 Provider 全部工具数。若真实负载超过上限，先增加分页/有界身份摘要并保留 gap，再评估上限，不通过取消限制让数据看似完整。
- 当前仅开放 typed 实时诊断字段与现有 UI 的数据合并，不宣称完整阶段可视化/管理页面已交付。`automaticStall` 对五 Provider 都是 `unsupported`；没有 watchdog、stall 计时器、自动重试或新设置。
- `workflowPermissionResponse` 先验证闭合权限形状，再围绕实际 broker promise 发 main-owned permission start/end，在 finally 清理；错误形状和业务 clarification 不产生权限观测，generic extension confirm 不冒充权限等待。Pi 来源与实际 Provider 不匹配时拒绝。
- 子任务交回后，父会话复核新增先红后绿：四项失败分别抓到 snapshot 缺 live、超长 ID 无界、截断未标、错 Provider 证据；另一个负对照抓到空 delta 抢占 streamed 标记而吞掉 buffered 正文。现在空增量既不算进展，也不影响最终正文保留。原子任务快结束后仍在提交结果的快照测试改为 held live stream，避免把已收敛的过时阶段当实时成功。

### 本段父会话验证

证据 `/tmp/scry-m1-observation.dNdytc/`，与前节停止收据的 `/tmp/scry-m1-stop.7jb82s/` 分开，不累计成一次验收。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| review 负对照 | 初版 4 failed / 9 passed；空 delta 正文检查再独立先红后绿 | `review-before.log`、`empty-delta-before.log`、`empty-delta-after.log` |
| 当前相关测试 | 18 文件 **285 passed**：Pi 六文件、Workflow、canonical stop、renderer 合并；没有重跑旧七项整仓失败 | `affected-final.log` |
| typecheck / build / 产物 / 安全 smoke | Node/web、完整 pack:artifact 均通过；未安装 | `typecheck-final.log`、`pack.log` |
| 隔离 UI | 原生输入、权限、两次独立 stop ID、未知与 rehydrate 检查通过。首轮输入失效保留；补显式焦点与 insertText 完成屏障，未延长上限或改产品代码。四张历史截图恢复 | `ui.log`、`ui-focused.log`、`ui-current/` |
| 性能计数 | trace.delivery 5 次均 2 IPC / 165996 bytes；仅该固定计数门禁，不代表新增 workflow live IPC 无额外成本或用户路径毫秒提速 | `performance/measure.json` |
| 完整 App 后台离线 | 当前包在没有聚焦 child run 时，经 native Pi delta 获得 model_progress / partial / automaticStall unsupported；snapshot/list 同 epoch，历史文件无 live；停止后 slots 0、live 消失 | `case.json`、`live-snapshot.json` |
| 同包重开 | 六个历史 workflow 只恢复观察；16 prompts 与 16 条 record 哈希不变，不恢复旧 epoch；旧真实现场 16 源 hash 未变 | `reopen-check.log`、`reopen-result.json` |

本段完整 App asar **`ed8a00b1ef7a8cb0e4a2b3db7c72b23fa6b7e7bd285d7fa834e453acb9ed0e7f`**，快照 `app.asar`；源码 SHA-256 与 `scope.json` 绑定，仍 App 0.2.210 / CLI 0.2.49，无部署。独立 HOME/userData、同一获准的固定离线脚本与临时项目，四角色显式同一 profile/model/full_access，未调用真实模型或复制凭据。workflow `workflow-2e8d1774420d16acc63c5251b5c1b08a36f40399cfed74d5907b1e8b2d50e0b2` 的 child `workflow-726ffb88-1ad2-4d62-a262-961125ebee20` 在 focusedRunId=null 时仍有真实增量观测。此脚本不发工具/权限事件，因此这两类只由 native adapter fixture / 实际权限 helper 的受控测试覆盖，不能称真账号或完整 App 工具/权限验收通过。

PID 53307、56908 均在确认 scope 终态后按 executable/userData/出生时间校验关闭，登记离线进程无存活。没有对用户 App 发停止或启动命令，没有清空旧 unknown/pending。

## Claude 主线程原生进度增量（仍不是完整 M1）

- Claude 现在仅从 SDK raw `stream_event` 的 root（`parent_tool_use_id === null`）非空 `text_delta.text` 与 `thinking_delta.thinking` 提供 `claude_native` `model_progress` 诊断；不会把 assistant 快照、缓冲替换、签名、心跳、重试或子 agent 帧算作进展。
- 该 callback 仅是 fail-open 诊断旁路；正常 transcript/trace/native recording、输出、usage 与结果收敛不变。Tracker 只接受 `claude_native` 与 Claude 的 `model_progress` 配对；Claude tool lifecycle 仍不支持，PreToolUse admission 与 PostToolUse/Failure 返回需要单独的 denied/cancel/background 分析，PostToolUse 不是物理后台任务结算。
- 这只是 root-thread Claude 原生模型进度覆盖，不能称 Claude observability 完整、工具阶段覆盖或完整 M1；仍保持 `partial` coverage、`automaticStall: 'unsupported'`，不启用 model-wait/quota 推断、自动重启或 settlement/capacity authority。
- 普通非 Workflow run 不解析新的 delta 观测；回调异常每个 run 最多警告一次，但后续原生输出继续处理。SDK hooks、权限和用量逻辑未改动。

证据：`/tmp/scry-m1-claude-review.jl3lYZ/`，SDK **0.3.251**、App **0.2.210**。精确 asar 快照 hash **`02df677f90eb506d78d697627451e0605881f5cb8faf966434223d2d163e99d4`**，四个生产源码 hash 在 `scope.json`。未安装、未推送，未升级版本。

| 检查 | 结果与边界 | 证据 |
| --- | --- | --- |
| 改前负对照 | 新观测行为 4 failed / 51 passed；父会话再以实际 SDK loop 证明普通 run 多做解析、持续异常写出 3 次警告，2 failed；不削弱原断言 | `/tmp/scry-m1-claude-negative.ByVsfZ/pre-change.log`、`before.log` |
| SDK / adapter / tracker | 3 文件 **56 passed**；只计非空主线程 delta，拒绝错 Provider/Claude tool events/关闭后事件；普通 run 解析计数更低，持续异常只警告一次且输出仍完整 | `focused.log` |
| 扩大受影响范围 | 9 文件 **127 passed**，包含 canonical stop、持久退出、live 存储隔离与 renderer 合并；上述数字重叠不累计 | `affected.log` |
| 类型 / 包 | Node/web typecheck 与完整 `pack:artifact` 通过，含后台隐藏与安全/remote/文件 smoke。包 smoke 不是 Claude workflow 验收 | `typecheck.log`、`pack.log` |
| 固定工作量 | trace.delivery 5 次均 2 messages / 165996 bytes，ratchet 通过；不代表 Claude delta CPU 或端到端延迟下降 | `performance/measure.json` |
| 旧现场 | 16 个真实故障现场源 hash 不变；unknown/pending 未清除、退款或重放 | `scope.json` |

本轮 Claude 证据来自 mock SDK/query 的原生结构流、真实 adapter 转交与 tracker 代码，不是实际 Claude CLI transport、完整 App 中 Claude workflow 或真账号验收。未运行真实 Provider/账号、未复制凭据。后续由维护 Agent 补 Claude denied/cancel/background 的原生工具生命周期合同与离线 transport 验收；真实探针须用户先明确账号、模型和费用授权。

## 尚未完成与下一段

- 普通 App 退出已新增本页记录的 durable preparation gate；内部其他错误清理/stopAll 仍是原 best-effort 路径，不能把退出保证外推给它们。历史不可用分支仍 fail-closed，缺少是否允许明确确认退出的产品决定。
- 原生控制的详细 accepted/unavailable/unknown 反馈仍由既有 run-control 链表达；本次 boolean 不是逐 Provider 停止成功证明。
- typed 可信实时观测子集已接通；下一段由维护 Agent 推进 M1 剩余管理控制与历史异常策略，并补实际 Provider 的原生阶段覆盖。不能从沉默、turn start、retry intent 或快照文本推断模型/配额等待。
- 当前五 Provider 都没有已证明完整的“模型等待＋工具/权限/配额排除”合同；自动停滞 watchdog 与自动重启继续 unavailable，不因新增部分阶段观测而开启。其后再推进 M2 程序/模板和 M3 持久解释器，不把本轮叫完整功能交付。
