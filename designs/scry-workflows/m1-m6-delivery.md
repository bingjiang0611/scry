# M1–M6 实施与真实验收台账

## 交付合同

目标是完成 M1–M6 并交付真实验收报告，不是再交付一个 M0、单个夹具或仅设计方案。规范以 [implementation-plan §9](implementation-plan.md#9-实施顺序与可证伪验收)、[执行语义](execution-semantics.md)、[运行管理](run-management.md)、[入口语义](chat-entry-semantics.md)、[模板生命周期](template-lifecycle.md)、[资源约束](runtime-limits.md) 为准。规范中旧的“尚未实现”文字不替代当前代码核查。

授权写入范围：`/Users/baobingjiang/IdeaProjects/vibecoding/scry-workflow-m0` / `feat/workflow-m0`；不混入其他工作树。基线 `cb8237a`，启动时工作区干净。保留不 push、不安装、不擅自调用真实账号/费用/外部数据发送或应用 patch 的约束。实现及临时 workspace/userData 的安全离线验证自主进行；M6 真实 Provider、Jev 数据/费用和写入应用在发生前确认尚缺的具体授权，不能用目标持续性补授权。

完成必须逐项以当前代码、真实持久化/进程/界面、负对照与真实调用证据核对。下表默认全部待完成或待重新验收；已有 M0 子集和离线成功不能自动把对应整项标为通过。最终报告区分：实现、单元/合同、隔离 App、离线 SDK、真实账号、设备、部署和已知限制。

## M1：启动、控制与收口

| ID | 完成要求 | 当前工作/证据 |
| --- | --- | --- |
| M1.1 | canonical startAppRun owner、独立 session 与全 run observer；终态、作用域、recording outcome 分开 | M0 已有接缝，须核对生产调用链并做当前 App 验收 |
| M1.2 | typed preload / trusted wrapper / sender、schema、path 拒绝，listener 不执行 | 须运行实际注册 wrapper 反例 |
| M1.3 | profile/模型/权限/仓库 trust 按当前 Provider 重验，不静默换模型或沿用旧 capability | 须核对启动、切换与重挂 |
| M1.4 | 停止/再次停止 intent 持久化、不同 commandId、未知不释放容量 | 已有基础，须当前回归及 App 重放 |
| M1.5 | 可信模型、工具、权限、配额阶段分别表达，缺能力明确 unavailable；不从沉默推断等待 | 部分原生观测已存在，须能力合同与实际来源验证 |
| M1.6 | managed 归档/recording 未收口不提前成功、推进或释放必要资源 | 独立十一场景是基础；完整 owner/observer 接缝待验 |
| M1.7 | 后台隐藏/退出保存、冷启动只恢复已证明状态，历史不可用 fail-closed | 已有基础，须当前版本统一核对 |
| M1.8 | blocked/failed/stopped/unknown 不能作为成功序列前驱或产出最终成功报告 | 已修复序列对blocked继续派发；旧实现负对照失败（2次而非1次），修复后相关109单测、types/build通过；当前App重放仍待执行 |

## M2：入口、完整程序与模板编译

| ID | 完成要求 |
| --- | --- |
| M2.1 | 聊天/显式命令/手动与自动模式；direct/workflow/template_edit 互斥，不劫持原生命令 |
| M2.2 | 规模建议仅软建议，默认/会话/项目来源与下一次生效；单次入口不污染会话 |
| M2.3 | 路由额外调用与费用授权，规划与模板共用唯一 WorkflowProgram |
| M2.4 | 规范全部控制指令、typed 值/条件/作用域/依赖/终止校验；map/branch/loop 不降格为固定样例 |
| M2.5 | unknown 条件不当 false、无限循环/非法依赖/越权步骤拒绝；不可用能力在确认前拒绝 |
| M2.6 | 预览冻结程序、角色/profile/model、来源修订、预算与能力，不靠重新解释文本执行 |
| M2.7 | 个人/项目模板保存、草稿、修订、来源快照；手动编辑与 Agent 候选修改不直接覆盖 |
| M2.8 | Agent 参数化不得携带私有运行状态，写入权限不会由生成程序自授 |

### M2 当前已实施的数据合同基础（不是M2完成）

- 首个M1缺陷已本地提交 `4abbd9d`；没有把读码或109测试升级为完整App验收。
- 唯一WorkflowProgram增加可选call.outputSchema；编译器规范化并纳入修订/4MiB预算，Runner追加冻结格式要求，并在Native result后真实校验完整JSON。数据合同无效时记录failed且不推进后继；未settled作用域仍unknown并占容量，不退款。
- 只支持有限类型/枚举/数组/对象，深度16/节点256、数组≤4096、复用原16,384字符输出上限；不执行schema扩展、截取JSON片段、类型强转或补零。null/false/0/显式unknown保持原样。具体已落地语法见 [program-ir.md](program-ir.md)。这是宿主类型校验，不是Provider原生强制JSON、工具禁用或内容真实性证明。
- 新增22项回归，11文件131项Workflow测试、Node/web types、build通过；故意关闭运行时数据门后6项失败，恢复后35项相关测试通过。只读源码/命令证据 `~/.local/state/rotom/verification-evidence/workflow-m2-values-8k8viz79/`，不代表真实Provider/App验收。
- M2剩余全部控制指令、typed表达式与作用域、路由/模板/发布仍未完成；下一步直接实现map/branch/loop及数据表达式，连同M3持久控制帧实现执行/恢复。M1生产App证明与其余目标继续保留，不用数据合同小交付替代。

## M3：持久解释器与恢复

| ID | 完成要求 |
| --- | --- |
| M3.1 | 控制帧、绑定、join、iteration/attempt、expected revision 与不可变子 outcome 引用 |
| M3.2 | 根准入先写预算/intent，结果先持久化再推进；不得只因 checkpoint 未前进重发 |
| M3.3 | 共享槽位默认 min(16, availableParallelism)，配置1–256；4097项整批拒绝、第1001次不发送 |
| M3.4 | 动态 map/branch/loop 持久 checkpoint，carry/最佳候选、完成 sibling 与依赖恢复不重跑 |
| M3.5 | unknown 保留预算和容量；外部结果未知不自动重发，不假装 exactly-once |
| M3.6 | 先证明原 scope 收敛再最多五次停滞重启，等待排除来源充分；能力缺失时拒绝而非猜测 |
| M3.7 | nothing_to_resume 不重开；运行中业务输入拒绝，恢复观察与恢复执行明确区分 |
| M3.8 | 模板发布收据/冲突检查与实例快照；改修订不重置根预算或更换运行中快照 |

## M4：质量模式、检查与写入

| ID | 完成要求 |
| --- | --- |
| M4.1 | 规范全部六种质量模板真正经同一编译器/解释器执行 |
| M4.2 | 对抗复核、独立反例能推翻候选，反馈实际改变下一版；无合格项不得假选赢家 |
| M4.3 | 多角度起草/交叉评审/裁决/综合再验证，硬约束未知不能被加权分抵消 |
| M4.4 | main 执行有限 argv 的 check，占共享槽位不计 Agent attempt；退出/范围/截断/诊断来源诚实 |
| M4.5 | Jev typed schema/criteria/概率/来源与置信度；错误 unavailable，实际复核，不用假概率替代真实API |
| M4.6 | 工作副本包括脏文件/未跟踪输入快照；组合 patch 冲突或检查回归阻止应用；基线变化拒绝覆盖 |
| M4.7 | 应用需要具体授权，取消/失败不误删现场，不声称副本是安全沙箱 |
| M4.8 | 中间结果在引用存储中，真实父请求只含 root return 报告/必要引用，不泄漏内部逐轮上下文 |

## M5：生产界面与控制

| ID | 完成要求 |
| --- | --- |
| M5.1 | 三种入口真实交互、每运行自动关联；重挂不双发，退出模式不误停 |
| M5.2 | 来源/规模/权限/费用预览与确认，unsupported 与 unknown 不画成成功 |
| M5.3 | 管理、停止/再次停止、依赖恢复、后台/退出、历史异常处理 |
| M5.4 | 模板保存/编辑/diff/冲突/来源，新版、另存、仅本次不串源 |
| M5.5 | 同源代码视图和实例连线图，轮次、分支、候选、证据与 retry 用量 |
| M5.6 | 原会话无安全回注能力时不伪造 turn；长列表/流式/订阅有界与清理 |
| M5.7 | 当前代码独立 test userData 的真实 App 交互；DOM/坐标/焦点不得由源码或程序化 click 冒充 |

## M6：真实验收与报告

| ID | 完成要求 |
| --- | --- |
| M6.1 | 先冻结源码/构建/CLI/Provider/profile/模型/权限与验收场景，并明确账号、数据及费用范围 |
| M6.2 | 单 Provider → 跨 Provider，真实 session/终态/实际模型/usage/工具与作用域证据可核对 |
| M6.3 | 真实 Jev 分类、低置信度复核和失败处理，数据授权不由调用成功倒推 |
| M6.4 | 循环/对抗复核/多方案/写入组合逐项真实验证，不用独立夹具替代程序级验收 |
| M6.5 | 模板 Agent 修改与跨会话/项目复用，版本/私有状态/费用与权限隔离 |
| M6.6 | 最终当前版本需求矩阵、反例、命令/结果、真实 App/账号证据、失败/skip/未知、进程与临时资源收敛、commit/install/push 状态报告 |

## 初始审计与正在执行

- 已核对上述六份规范及仓库执行/验证指导；当前类型 `src/shared/workflow.ts` 仍只有 sequence/parallel/call/return，编译器对其余指令拒绝，不能把 M2–M4 当作已有实现。
- 当前 M1 基础原生离线证据：`~/.local/state/rotom/verification-evidence/scry-managed-crash-yrbngh7d/`，但不覆盖完整App/SQLite/WorkflowProgram，更不是M6。
- 首个实际缺陷：`WorkflowRunner.runBlock` 的 sequence fail-fast 漏掉 blocked，根虽最终显示 blocked，后继仍可能执行。已先新增回归并观察旧实现失败；改为仅 completed 且 settled 的子块可继续。10文件109项focused、Node/web types、App build通过；负对照与green日志在 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-m1-m6-gates.dcg8Lz/`。上述日志另有只读持久副本 `~/.local/state/rotom/verification-evidence/workflow-m1-sequence-m6jzgze1/`。当前App重放/性能覆盖仍待核对，不算M1完成。`performance-paths.json`把workflow IPC归到providers/catalog，但没有workflow-runner专用counter，不拿目录基准冒充调度门测量。
- 生产owner/observer审计：`index.ts` 的workflow executor仍调用唯一startAppRun；原生终态在最终录制处理后经onTerminal交回，startup与每次dispatch前核对冻结runtimeIdentity。`WorkflowService`恢复历史unknown只保留容量不重发。现有UI smoke是API fixture，不将它当完整生产App证明；该验收继续保留到完整功能交付。
- 实施并行关系：先提交M1已证实的缺陷修复，不等待所有App场景才开始M2/M3；所有M1验收项保留，最终逐项统一核对，不把读码审计当作运行证明。
- 下一执行顺序：收口 M1 生产 owner/observer/recording 与控制合同；落地 M2 编译器/模板及 M3 解释器；然后 M4 质量/检查/写入、M5真实交互、M6授权真实矩阵。任何阶段仍有未满足项都不调用目标完成。
