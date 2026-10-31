# Scry 无界面引擎：恢复、迁移与验收

**状态：条件性架构附录，尚未实现，不是 P0/P1 的验收前置清单。** 本文属于[完整方案总览](../headless-execution-engine-design.md)；当前交付按 [首个切片](first-slice.md)，后续需求成立才选择本篇对应部分。

第 11–15 节：故障处理、退出/升级/回滚、实施阶段、性能与正确性验收、风险和决策。 章节编号跨文档保持一致；文中的 § 引用可按总览导航定位。

导航：[运行时与协议](runtime-and-protocol.md) · [数据与客户端](data-and-consumers.md) · [恢复与验收](recovery-and-validation.md)。

## 11. 条件性恢复、退出、升级与回滚

本节保留原提案的安全边界，适用于未来确实引入对应收据、journal、worker 或独立宿主时。特别是 cleanup-only、发现文件和重新连接策略针对独立 daemon，不能假定 `utilityProcess` 在父进程退出后仍存活；父子宿主需单独验证其死亡/恢复合同。P0/P1 沿用现有生命周期。

### 11.1 故障矩阵

| 故障位置 | 恢复行为 | 禁止行为 |
| --- | --- | --- |
| queued 收据已同步，尚未 reserved | 恢复队列，重新授权后可继续 | 丢弃队列却显示已发送 |
| reserved 后、dispatch fence 前 | 释放失效 reservation，重验后排队 | 假定原权限永远有效 |
| dispatch fence 后、Provider 接受证据前 | 标 outcome_unknown；读取已有原生证据 | 无条件重发 prompt/steer/answer |
| live 事件已显示、raw 未 durable | 重建 durable 前缀，明确尾部缺口/partial | 把旧 live cursor 当完整归档 |
| mutation durable、DB commit 前 | 幂等重放投影 | 再执行 Provider |
| DB commit 后、ACK 前 | 查与业务数据同事务提交的水位/摘要，旧 revision 不覆盖新结果 | 双计 span/usage 或投影倒退 |
| 任一必需 canonical 根写入失败 | 按 recording mode 保留 intent/outbox，沿原有恢复合同继续 | 另一根成功就发布“完整”，或 disabled 等待不存在的产物 |
| engine 崩溃但 Provider 可能存活 | 验证进程身份和原生状态；支持时恢复观察，否则 unknown | 仅根据 PID 杀进程或启动第二个 writer |
| worker 超时/失联 | 确认旧 worker 退出/事务状态后恢复 | 超时即创建第二个 SQLite writer |
| 网络/renderer 窗口断开 | 保留 engine 状态，重新认证并 reset/续读 | 断开即自动完成或重放写入 |
| broker 异常退出/退出 deadline 到达 | 按 §11.2 转入有所有权的清理流程，保留 unknown 与 claim | 把 forceKill 请求当成进程已退出 |
| 会话删除后旧 job/输入重放 | deletion barrier 阻止重新投影或执行 | 已报删除成功后后台重生 |

### 11.2 退出与无界面运行

当前 [shutdown](../../../src/main/shutdown.ts) 在默认 6 秒 deadline 后发出 forceKill/dispose 请求即返回 `forced`，[App lifecycle](../../../src/main/bootstrap/app-lifecycle.ts) 随后 `app.quit()`；这不是资源全部退出的证明。新布局必须明确区分三方：

- **broker**：沿用现有平台的窗口关闭与 App Quit 区别。App Quit 停止新请求，发起 engine shutdown；保持现有交互 deadline，不为等待无限延长 UI 退出。deadline 到达只能报告强制退出请求/清理状态未知。
- **engine**：收到 shutdown 或监督 broker 的私有生命周期连接确认断开时，进入 cleanup-only，停止新准入、取消未派发队列并持久化终态，按既有 Provider stop 合同处理已派发工作。普通 renderer/远程消费者断开不触发该规则。
- **Provider/worker**：仅由登记且身份重验通过的控制路径停止。强制请求不等于退出，未知子进程/DB writer 不能被替代。engine 保留 claim、收据和清理状态；确认 writer 与登记资源收敛后才正常退出并移除 claim。

broker 已退出但 engine 尚未确认清理完成时，允许存在只清理、不接受新工作的 engine；这不是授权任务继续后台运行的新模式。下次启动只能连接该 engine 的状态/清理入口，或在确认旧 writer 已退出后恢复；不得自动夺锁。engine 自身也崩溃时保留磁盘 claim，由重启流程验证身份，未知就阻塞新 writer。首次独立进程发布必须包含 broker crash、超时清理、未确认进程和重连检查。

后续启用“退出窗口后继续运行”时必须单独交付：清晰的状态入口、显式停止 engine、无客户端审批策略、后台进程清理、更新阻塞提示和安装/卸载行为。未完成这些之前不默认常驻，不建立 launch agent。

### 11.3 升级与回滚

- engine build 与客户端版本握手；不兼容时只提供安全状态/退出引导，不让旧 writer 解释新 journal。
- 发布默认采用 drain-and-restart，不热替换正在使用的 adapter、native addon 或 session writer。
- 第一批迁移保持现有 canonical record 和 DB 业务表结构不变；App journal 为带版本的旁侧结构，DB 投影水位为新增的最小元数据表。旧版是否可安全忽略该表要独立验证，不以“仅新增”推定回滚安全。
- 不能在有活动/未知任务时切换 legacy/engine writer 模式。回滚先停止新准入、收敛或明确处理未知工作、关闭 writer、验证旧版本能读取 canonical artifacts，然后切换。
- 若出现不可逆 schema 变化，必须在对应迁移方案中提供备份、恢复验证和兼容矩阵；不能把切换开关当作回滚方案。
- 更改一次只改变一个权威写入者；shadow 只能计算并比较，不发送 Provider 输入、不提交 recorder、不双写用户 DB。

## 12. 按证据选择后续阶段，不串行执行全部路线

文件范围、粗估人日和止损条件统一放在[总览 §0.1](../headless-execution-engine-design.md)，避免维护两张互相漂移的计划表。当前建议只包含 P0＋P1；raw 队列可附带观测，不自动启用新上限行为。

- P1 只有 L1 改善、没有超过预登记噪声的 L2 目标改善：停止扩大，记录无端到端收益证据。不得以“已经做了 P1”推进 P2/P3。
- 持久化积压＋写放大预算成立：再讨论 P2 日志/落盘；DB 阻塞/成本成立：再讨论 P3。两个问题不互相充当依据。
- 隔离需求明确但退出语义不变：先比较 worker/utilityProcess。桌面退出后继续执行获批，才讨论独立宿主；私有 Node 不是必选。
- Renderer/历史驻留或目录扫描是瓶颈时，可单独选择 P6 假设，不先支付 P4/P5 的成本。
- P7 针对已通过的单个切片发布复验，不以完成全部远期架构为前提。

采用独立临时 workspace/userData 验收；collector 与优化分开提交。同一 cwd 一个写者，任何并行任务不独立改变 recorder 权威、IPC 授权或 Provider lifecycle。

## 13. 验证与性能实验

### 13.1 后续阶段的候选工作量

P0/P1 使用[首个切片 B](first-slice.md) 的 4/16 并发、1k/10k/50k 事件及冻结交互。下表只用于后续某阶段获批后的压力扩展，不要求当前先跑所有大规模负载。

| 场景 | 规模轴 | 关键输出 |
| --- | --- | --- |
| 并发执行 | 离线 fixture 1/4/16/64 run；报告实际容量与排队 | 总 CPU/进程树内存、首输出、排队、吞吐、停止/审批延迟 |
| 事件更新 | 1k/10k/100k 事件，固定新增/替换数量 | 查找次数、复制/编码/hash 字节、GC、精确最终内容 |
| 巨大工具输出 | 固定总字节、不同消息大小、慢存储 | 原始 backlog、spool、峰值 RSS、durable/terminal 延迟 |
| 长历史 | 4k/40k/100k 轮，固定页大小与交互 | 首可用页、metadata/stat/parse 字节、驻留窗口、原生选择/焦点 |
| 多消费者 | 无消费者、1/4/16 本地/远程读者，含慢读者 | 未变内容工作量、总传输、credit、reset、控制面响应 |
| 冷界面 | 访问大量不同会话/工作区再回访 | DOM/组件/终端资源、自然 GC 与独立诊断 GC 后驻留 |
| 宽目录/Git | 1k/10k/100k 条目；复用既有 dirty/clean 多仓库场景 | 并发 I/O、真实字节、稳定页、与 Git oracle 等价补丁 |
| 故障 | 前述每个提交/外部输入边界 | 无静默重放、无权限绕过、无丢失被伪装为完整 |

并发 64 是离线压力负载，不承诺真实 Provider 能在一台笔记本保持该并发。相同队列预算、总任务数、输入体积、有效输出和完成窗口一起比较；排队降低峰值必须同时报告尾延迟。

### 13.2 测量规则

- L1：编码、hash、clone、文件/Git 调用、队列字节、索引比较等工作量。
- L2：低负载同机受控和真实 App 的输入、首可用页面、CPU、内存、完成时间；串行通过现有 timing lock。
- L3：已确认部署 build 的真实日常同场景对照；沿用至少 30 样本、至少 2 会话要求。
- 当前 resource monitor 不能代表完整 Provider/MCP/subagent 进程树。新增观测必须验证 ownership、PID 复用和采样开销；不可观测标 unknown。
- 持久化 wall time 不当 CPU；单核百分比与整机百分比分开；RSS 求和不宣称精确物理内存，平台支持时补充 footprint/内存压力。
- 主进程、worker、engine、Provider 及 benchmark 自身成本分别列出，并提供总和口径；无法收敛的进程不从报告中消失。
- 正常 GC 与诊断强制 GC 分开；隐藏 offscreen fixture 不证明前台 GPU 或交互收益。
- 同一实验记录源码 commit、dirty 身份、完整 build、机器负载、workload、首次失败、部署状态。高负载毫秒不用于宣称收益。
- 新遥测只记录数字、阶段、版本与匿名操作身份，不记录 prompt、正文、用户路径、凭据。采集内容/保留策略变更先审批。

### 13.3 后续边界的正确性与负对照

以下按真正改动的边界选取；P1 必需项和最小负对照见首个切片 C，不为尚未实现的 engine 搭测试脚手架：

1. 重复/乱序 enrichment、text replacement、跨页锚点与未知 usage：完整重算 oracle 与增量结果相同。
2. 相同 requestId 不同输入拒绝；丢接受 ACK 不重发；旧 clientEpoch 不执行。
3. 容量等待期间撤权/配置变化/工作区改名：真正发送前拒绝，Provider listener 未执行。
4. 伪造 renderer actor、旧 epoch、错 scope、内容 ref 换目标：通过生产 wrapper/engine 注册入口拒绝。
5. SQLite commit 后崩溃：重放不双计，N+1 后重放 N 不倒退，旧 outbox 不覆盖新投影；journal 半条尾记录、内容损坏和任一必需 canonical 根失败不发布完整证据。
6. 慢客户端/大 reset/撤权：不会无限保留数据，也不会拖住 stop/审批。
7. engine/worker/broker 崩溃、6 秒退出 deadline、旧 writer 存活但失联：不能建立第二个 writer，强制请求不算退出证据。
8. Codex 共享 transport stop、Pi 背景子任务和审批等待：资源调度不误杀、不提前释放所有权。
9. renderer 原生键盘、鼠标、IME、选择、复制、终端与文件链接：不能用程序化 click 或 SSR 替代。
10. clientEpoch 到期但 queued/reserved 尚未派发：已接收操作不丢失，明确队列 expired 与 dispatch 互斥；recorder disabled 不等待不存在的产物。
11. 会话删除与恢复/DB job 并发、删除中崩溃、旧收据重放：删除后不重生；输入正文清理与最小防重 tombstone 分离，`.scry` 和原生历史保留。

每个关键保护至少一次旧实现或故意破坏后的失败证据。收据一致不替代 Provider 接受记录，SQLite 行数一致不替代 canonical 文件和原始证据比对。Provider 输入不静默重放的保证不外推到 recorder callback：[现有通知链](../../../src/core/turn-recorder/store-notifications.ts) 保留自己的重试/ACK 合同，不承诺 callback 外部副作用 exactly-once。

### 13.4 命令与执行范围

下列是仓库当前存在的入口，供未来对应实施阶段使用；**本次纯文档交付不运行这些测试或构建**：

```sh
npm run test:unit -- <实际受影响且已定位的测试文件>
npm run typecheck
npm run performance:measure -- --scenario <已注册且受影响的场景>
# 毫秒实验：先确认具体 workload 命令和路径，再由既有锁包装
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs <标签> -- <实际实验命令>
```

跨 engine/持久化/安全边界的阶段按 [扩大验证](../../agent/verification.md) 选择 `npm run test:coverage`、`npm run test:renderer:ui`、`npm run check:cli-release` 和现有 packaged/security gate，不把 focused 结果当发布验收。新增 Node 宿主必须扩展 package manifest、签名/native ABI、安装与升级检查。

真实 Provider 有账号/费用授权后才执行；真实手机通过 iCTRL 真机验收，不用模拟器替代。独立 test App 使用临时 userData/workspace，不要求停止用户日常 App。

## 14. 风险、取舍与停止条件

| 风险 | 取舍/限制 | 升级或停止条件 |
| --- | --- | --- |
| 多一个宿主增加基础内存/体积 | 现有布局优先，需要隔离才比较 worker/utilityProcess | 无明确需求或总足迹/响应收益不足则不提取；私有 Node 另行批准 |
| journal 与 canonical 双写增加 I/O | 只承担恢复必需变更，group commit 不提前 ACK | 固定负载总写入/终态延迟恶化时重新设计，不弱化 fsync 合同 |
| Provider 不支持背压 | 当前先观测；新准入策略与 spool 各自验证 | 未解决控制消息阻塞/磁盘容量时不执行硬截断、不宣称硬内存上限 |
| Rust 跨语言增加维护成本 | 当前保留既有 TS/Electron；仅对测得热点做等价原型 | 同 workload 无独立 L2 收益或 ABI/恢复复杂度过高时不引入 Rust |
| 外部可变源无法低成本证明未变 | 初期保留验证，移出交互路径 | 需要弱化权限/证据检查才变快则否决 |
| UI 淘汰破坏用户状态 | 固定交互中内容，独立保存执行与编辑状态 | 原生选择、草稿、终端或统计完整性回归则不启用淘汰 |
| engine 升级与退出语义变化 | 默认沿用现状，不常驻 | 明确关闭/审批/恢复 UX 与产物验证未完成则不启用后台持续执行 |
| 全局调度降低峰值但拖慢任务 | 同时报告 throughput、队列等待与尾延迟 | 不能仅凭 CPU/RSS 降低接受回归 |

## 15. 决策与后续交付

本次修订明确了 **P0＋P1 的工作项、oracle 与止损线**，并撤回私有 Node、新 framing 和 journal 的默认选型。它们不是留给实施者随意决定，而是尚未满足进入条件。维护者批准当前文档修订，不等于已批准 P0/P1 代码实施、后续架构、真实账号探针、安装常驻服务、新增日常遥测或正式门禁。

后续必须单独确认的策略变化：

- 新增日常性能采集字段和保留范围。
- 用户退出桌面后 engine 是否继续执行，以及无客户端审批体验。
- 候选预算升级为正式门禁，或放宽既有门限。
- 从 Node 引入 Rust、二进制协议或其他新增运行时依赖时的独立实验结论。

每阶段更新原实验记录中的实现 commit、验证、构建、安装与生效 build；本文保持设计状态，不把阶段名称或计划验收写成已完成事实。
