# M1–M6 实施与真实验收台账

## 按领域查看交付证据

- [仅 stable-map 获准 30 秒：单例已通过，全量仍有其他超时](../../docs/performance-experiments/20261029-workflow-stable-map-timeout-contract.md)

- [File 减冗余与终稿全量 4526/1/4：stable-map 仍未关闭](../../docs/performance-experiments/20261029-workflow-file-checkpoint-followup.md)

- [v4 生产工作台、独立冷读验收与仍失败的完整 unit 门禁](v4-workspace-delivery.md)

- [工作副本、Agent/check、诊断与输入观察](delivery-system-steps.md)
- [必需检查集合、诊断比较与声明保护端点子集](verification.md)
- [模板、编辑、发布与冻结实例](delivery-templates.md)
- [解释器、集合、loop、继续与显式重试](delivery-recovery.md)
- [同根修订与静态/动态历史结果复用子集](same-root-revisions-status.md)
- [生产修订预览、显式确认与冷启动重复命令子集](revision-entry-status.md)
- [单节点停止与 Node 测试报告的有界证据](node-control-evidence-status.md)
- [并行 fail_fast、自动停止来源与有界验收](parallel-failure-status.md)
- [结构父级、只读控制记录与当前验证缺口](frame-inspection-status.md)
- [App runtime 领域拆分与入口前置工作](app-runtime-decomposition-status.md)
- [Session history IPC 与显式 App-owned 状态](session-history-extraction-status.md)
- [Claude SDK 配置来源转发与运行职责拆分](claude-settings-source-status.md)
- [Conversation 请求解码与派发协议拆分](conversation-service-extraction-status.md)
- [受限规划参数、canonical SDK 结果与未通过的 Native/App 验证](authoring-result-status.md)
- [迁出 IPC/trace 的目录扫描与既有计数验证](catalogue-scan-status.md)

以下保留总合同、里程碑验收表与全局缺口。分文件不表示这些里程碑已完成。

- [规模偏好、冻结规划快照与仍未关闭的回归](size-guideline-status.md)

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
- 生产owner/observer审计：`index.ts` 的workflow executor仍调用唯一startAppRun；原生终态在最终录制处理后经onTerminal交回，startup与每次dispatch前核对冻结runtimeIdentity。`WorkflowService`恢复历史unknown只保留容量不重发。原有 UI smoke 是 API fixture，不能当完整生产 App 证明；后续已补单节点停止与 Node TAP 的隔离生产 App 子集，见上文有界证据。真实账号、完整 owner/observer 矩阵和完整功能验收仍保留。
- 实施并行关系：先提交M1已证实的缺陷修复，不等待所有App场景才开始M2/M3；所有M1验收项保留，最终逐项统一核对，不把读码审计当作运行证明。
- 2026-10-29 用量证据纵切已接入生产：Provider 终态 result 的 token/cost 及 TypeSafe/Jev 的 token 用量会进入 attempt/classifier durable outcome，再由 canonical execution inspection 投影到同源图和执行记录。缺失字段保持 `partial`/`unavailable`，SDK/价格表费用保持 `estimated`，不补零；Jev 未返回权威费用时明确显示费用未提供。隔离 Workflow App smoke 已核对 Provider exact 用量、classifier partial 用量及 unavailable 文案。本纵切未调用真实付费 Provider/Jev，不把合成 cost 当成 M6 真实账单验收。
- 2026-10-29 候选应用生产纵切已接入：Main 从 canonical system ledger 的精确 check step、持久化 input materialization 和 replica receipt 派生候选；Renderer 仅提交 workflow/step/operation 身份、预览哈希和两项显式确认，不提交路径、冻结检查或信任权限。应用前重验工作区授权身份、源码基线、候选与已检查输入、冻结检查和 mutation-boundary 哈希；写入前先持久化 `unknown` intent，终态保留 `applied/rejected/partial/unknown`、路径和原因，冷启动及丢 ACK 不重放。Manage 页可预览路径、确认写入/无自动回滚并读取持久回执。focused source/IPC/runtime 74/74、typecheck、build、workflow UI/App/routing smoke、performance feedback/baseline 均通过。全量 unit 最新为 4537 passed / 5 timed out / 4 skipped；5 项均为 5 秒超时，本轮按已确认策略不放宽或修复。完整 `performance:measure` 在高负载下被既有 `workflow-cold-governing` 5 秒预算阻断，不能据此给出毫秒结论。
- 2026-10-29 候选应用纵切已提交为 `529c55a033f33c3f3785471ba8e901848b3883fb`。随后按明确授权在隔离 HOME/userData、两个合成 workspace、无费用上限和全 Provider 范围执行当前构建的 M6 真实矩阵，证据根为 `~/.local/state/rotom/verification-evidence/scry-m6-real-20261029-084032/`。单 Provider 中 Codex 完成，实际模型 `gpt-6.1-sol`、usage 为 partial `20833/11` tokens；OpenCode 完成，实际模型 `big-pickle`、exact `6948/9` tokens、Provider 报告费用 `0 USD`。Claude、Qoder、Pi 在 Workflow 预览阶段分别因 Claude 探测进程 `SIGKILL`、Qoder `Transport closed`、Pi 不支持独立新会话而保持 unavailable；跨 Provider 因 OpenCode reviewer 不支持独立新会话而 unavailable。真实 TypeSafe/Jev 通过 Codemode 对合成 incident 完成 bool/choice/score，usage `556` tokens、模型报告费用 `0`；同一当前 App 内的 classifier 正确阻断为 `TYPESAFE_API_KEY is not configured`，没有补零或降级成成功。Codex 真实 bounded loop 完成两轮并返回 `improved-v2`；多角度方案模板完成 7 次真实调用；对抗复核在并行 counterexample 的结构化 JSON 不完整时失败，显式 retry 因缺少“未进入 Provider”的证据被拒绝，未重放。个人模板发布后在第二个合成 workspace 冷启动复用成功；模板 Agent 候选因所有当前可用角色均不支持受限编写输出而未 dispatch。两个 workspace 均未生成 `.scry/records`，真实候选写入组合也未执行，因此这些结果是部分 M6，不是 M1–M6 完成。
- 2026-10-29 后续生产补齐与真实重验位于 `~/.local/state/rotom/verification-evidence/scry-m6-native-default-20261029-093728/`。Provider 未指定模型时，Pi 可按其原生默认模型语义准入；其他 Provider 仍需要当前目录中至少一个模型，指定的模型始终必须存在于目录。OpenCode 以当前 controls 目录返回的默认 `big-pickle` 与 Codex `gpt-6.1-sol` 完成真实跨 Provider Workflow。Pi 在用户显式授权一次 `full_access`、隔离 HOME 和合成 workspace 后完成，实际模型 `ultimate`，usage `17912/15` tokens、费用证据 partial。Qoder 使用隔离 config 与只读认证目录 symlink 后完成，实际模型证据为 Provider 返回的 `auto`，usage unavailable；成功的当前 control 读取现在会作为 ready 健康证据，不再形成“必须先普通运行、Workflow 才能首跑”的循环依赖。Claude 按用户机器限制继续禁用，不再作为本轮验收前提。
- 同一证据根下，workspace recorder 已产生 7 条 canonical `.scry/records`：Codex 3、OpenCode 1、Pi 1、Qoder 2，全部 completed；不再沿用“records 为 0”的旧结论。真实合成源码应用组合完成：独立 prepare/check 固化 candidate，App 预览 `feature-2.txt`，显式确认后 durable receipt 为 `applied`，冷读目录不再返回候选；并修复 applied receipt 误保留 `application in progress` 原因的问题，真实重放确认终态没有 `reason`。生产 Workflow App 现在在 App-owned Provider 作用域真正收敛后写入 attempt-scoped terminal receipt；冷恢复只在 exact workflow/task/attempt/run 身份匹配时把旧业务结果保持 `unknown`、物理作用域标为 settled，仍不自动重发，手动 restart 从新 control-frame generation 开始。真实 Codex 运行已生成对应 `app_run_terminal` receipt；独立 Node controller 进程测试在“receipt 已持久化、Workflow outcome 尚未提交”的精确边界杀死旧进程，证明冷进程释放 capacity、不自动重发，并在显式 restart 后只派发一个新 attempt。该测试同时修复了冷恢复合成 outcome 丢失 requested model 与 runner-local approval cache 未恢复的问题。
- 2026-10-29 当前构建补齐了两个此前缺口。TypeSafe App 凭据解析不再把 Pi `auth.json` 中的 `!security ...` helper 当作 Bearer token；Main 只接受字面量、环境变量模板或严格匹配的 macOS Keychain 引用，不执行任意 shell，且拒绝符号链接 auth 文件。隔离 App 通过显式 login keychain 路径完成真实 bool/choice/score：`true/0.93`、`technical/1.0`、`4.21/0.80`，来源均为 `typesafe:jev-1.14.0`；独立公平硬币场景返回 `0.53`，被冻结 `0.9` 阈值阻断，后续 Provider attempt 为 0。Qoder 现在声明生产 `workflowAuthoring`：独立新查询、默认权限、`tools: []`、拒绝任意工具回调、无 skills/settings/MCP、非持久 session，并只把成功 result 中可解析的 JSON object 提升为 canonical structured output；普通 Qoder run 继续走原 adapter。当前隔离 App 用 Qoder `auto` 真实生成一 call + return 程序，预览 ready、程序通过 Main 校验并显式启动，worker 实际模型 `auto`，终态 completed，最终输出 `SCRY_M6_QODER_AUTHORING_OK`。汇总证据为 `~/.local/state/rotom/verification-evidence/scry-m6-native-default-20261029-093728/m6-current-authoring-typesafe-summary.json`。
- 下一执行顺序：若要求 M5.7 完整关闭，必须在安装后的原生 App 通过真实 UI 点击、坐标命中和焦点重放源码应用流程；当前源码应用仍是生产 API 驱动证据，不能冒充完整原生交互。本轮已在隔离 native Electron App 中生成 `ui-feature.txt` 的单候选并尝试接管 UI，但 `observe_ui` 的 fused capture 因 audio/video capture failure 失败，semantic outline 又递归为 Electron/Scry application 节点，无法取得可操作 renderer 控件；同样问题也出现在已安装日常 Scry 的只读观察，因此未退回程序化 DOM `.click()` 冒充原生验收。候选保留在证据根，App 与认证副本已清理。随后按 M1–M6 每项合同重新汇总最终矩阵。停滞恢复、App TypeSafe 矩阵、低置信度阻断和非 Claude 受限结构化编写已闭环；M5.7 原生 UI 仍未闭环时不调用目标完成。
