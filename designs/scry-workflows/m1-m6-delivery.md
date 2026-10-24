# M1–M6 实施与真实验收台账

## 按领域查看交付证据

- [工作副本、Agent/check、诊断与输入观察](delivery-system-steps.md)
- [必需检查集合、诊断归一与回归比较子集](verification.md)
- [模板、编辑、发布与冻结实例](delivery-templates.md)
- [解释器、集合、loop、继续与显式重试](delivery-recovery.md)

以下保留总合同、里程碑验收表与全局缺口。分文件不表示这些里程碑已完成。

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

- 初始审计基线：当时 `src/shared/workflow.ts` 只有 sequence/parallel/call/return，编译器拒绝其他指令。该句不是当前实现状态；后续 bind/branch/map/collect/loop 与模板数据发布进展见上文，准确语法见 [program-ir.md](program-ir.md)。M2–M4 整项仍未完成。
- 当前 M1 基础原生离线证据：`~/.local/state/rotom/verification-evidence/scry-managed-crash-yrbngh7d/`，但不覆盖完整App/SQLite/WorkflowProgram，更不是M6。
- 首个实际缺陷：`WorkflowRunner.runBlock` 的 sequence fail-fast 漏掉 blocked，根虽最终显示 blocked，后继仍可能执行。已先新增回归并观察旧实现失败；改为仅 completed 且 settled 的子块可继续。10文件109项focused、Node/web types、App build通过；负对照与green日志在 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-m1-m6-gates.dcg8Lz/`。上述日志另有只读持久副本 `~/.local/state/rotom/verification-evidence/workflow-m1-sequence-m6jzgze1/`。当前App重放/性能覆盖仍待核对，不算M1完成。`performance-paths.json`把workflow IPC归到providers/catalog，但没有workflow-runner专用counter，不拿目录基准冒充调度门测量。
- 生产owner/observer审计：`index.ts` 的workflow executor仍调用唯一startAppRun；原生终态在最终录制处理后经onTerminal交回，startup与每次dispatch前核对冻结runtimeIdentity。`WorkflowService`恢复历史unknown只保留容量不重发。现有UI smoke是API fixture，不将它当完整生产App证明；该验收继续保留到完整功能交付。
- 实施并行关系：先提交M1已证实的缺陷修复，不等待所有App场景才开始M2/M3；所有M1验收项保留，最终逐项统一核对，不把读码审计当作运行证明。
- 下一执行顺序：收口 M1 生产 owner/observer/recording 与控制合同；落地 M2 编译器/模板及 M3 解释器；然后 M4 质量/检查/写入、M5真实交互、M6授权真实矩阵。任何阶段仍有未满足项都不调用目标完成。
