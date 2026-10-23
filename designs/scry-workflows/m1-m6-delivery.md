# M1–M6 实施与真实验收台账

## main 副本与检查增量（M3/M4 原语；整体仍未完成）

- 新增 replica/check 数据节点，仍走 compiler → Service → canonical Runner → Interpreter → main effect host；没有第二套调度器或任意宿主函数 API。main 冻结命令/解释器/环境/入口文件指纹；同根真实副本使用 opaque authority、输入清单、目录 inode 与租约，不从 Agent JSON 或普通路径推断权限。副本包含当前 dirty/untracked/ignored 内容；边界和上限见 [程序合同](program-ir.md#main-工作副本与检查步骤已接入非完整质量模式)。
- 系统 intent/结果独立持久，不计 Agent 尝试、不退款；共享原槽位、原根 CAS/epoch/控制段。结果落盘失败也不丢掉原 native scope 的占用；晚到物理收敛只更新范围证据，不赋予重发资格。冷启动缺失 outcome 保留系统容量；退出治理也检查该账本。父 checkpoint 失败复用准确结果；缺失 stdout、错误 artifact 身份或副本收据拒绝，不再执行检查补证据。
- 计划预览分页显示命令、目标、cwd、超时和解析器，并说明本机权限与副本非沙箱。进度区单列最近 64 个 main 系统结果，区分“已记录结果”和“检查未通过”；最终报告不再把纯程序结果误标成 Agent 输出。模板禁止主机 authorization，提取时删除该字段，实例重新冻结并审批。
- 当前 Node24.18.0/macOS：新增 **3 文件 36/36** 通过；最后源码相关 **12 文件 154/154** 通过，包含程序文本预算回归；Node/web types、增强的真实 Chromium 输入 workflow UI fixture、build + 完整 production conversation IPC 通过。生产 preload/main 在独立 userData/工作区中实际执行两次本地 Node 检查：exit0→true、exit17→false；各只有一次 native 执行，原工作区未被脚本写入、Agent 尝试为 0、重复 start 不重跑，Provider 增量为 0。完整原有 conversation 场景的 21 次调用仍全部是离线 fixture，不是真实账号/SDK 验收。
- 负控有效：上一 App bundle 在同一生产新场景以“未实现 replica/check”拒绝，当前 bundle 通过；临时去掉槽位对 native scope 的等待后，“结果 artifact 写失败仍须保留容量”测试在 queued=0（应为1）处失败。模板测试首次使用非 UUID templateId 失败，已修正 fixture 为正式合同要求的 UUID，未修改 validator 或删断言。自审补齐 replica source 的 4 MiB 程序总文本计数，并在 main 冻结字段加入后重验整个程序；临时禁用计数后新增回归明确失败。单次准备中完全相同的 check 共用一次冻结/指纹读取，spy 验证实际一次，没有给出毫秒提速结论。
- **组合检查未全绿**：26 文件 325 项中 324 通过；既有 1000-attempt 用例在原 5000ms deadline 超时。取父提交 Runner 的临时对照也在相同 deadline 超时；这不证明全部根因或所有共享依赖与本次无关。随后当前源码的单场景 CPU 采样运行通过（1 passed/11 未选择，约3738ms），主要采样落在 MemoryWorkflowStore.save/控制帧复制验证；不据 focused 通过关闭组合首败，也未增加 deadline、缩减工作量或重跑刷绿。后续仍由主实施会话定位并修复可证明的工作量问题。
- `performance:measure -- --scenario providers.catalog` 仍因 `No counter collector matches providers.catalog` unavailable/exit1；登记来源不是 collector，不能宣称性能通过或提速。UI mechanical detector 返回空 findings；外部 warning-text 参考仅用于权限后果文案，不代表视觉/完整 App 已全部验收。日志保留在 `/tmp/scry-workflow-template-editor.ZnkC6L/system-*`。
- 主实施会话继续接入：副本 Agent 的 App authority 与 Recorder/归档关系、诊断数据消费与 classifier、质量流程/必需验证、组合/应用/清理；再完成同根修订恢复、chat 路由和其余管理 UI。现有 Manager 原语不是这些流程已完成。真实 Provider/Jev、费用及业务 patch 仍保留明确授权边界；未安装、未 push、未升版本。

## 显式失败重试增量（M3，严格子集；整体仍未完成）

- 新增 `WorkflowApi.retry(workflowId, approval, { taskId, attemptId, expectedRevision }, commandId)`，经现有可信 IPC → Service → Runner → Interpreter 执行。先校验冻结程序/运行时、原根全部效果收敛和观察版本，再持久化 retry 控制段；只在原预算内追加 intent，不修改旧 attempt/outcome，不退款。每个同修订逻辑调用最多 6 次 admitted attempts，根仍最多 1000 次、控制段最多 256 个。
- 本轮只允许 `sequence/parallel/call/bind/return`，且选中的最新失败 outcome 必须 `settled + providerDispatch:not_attempted`。该证据来自原 canonical dispatch guard；普通 Provider 失败、unknown、停止 ACK、物理退出或 owner 死亡均不提供安全重发资格。动态 map/loop/branch/collect 等程序明确拒绝。成功 sibling 复用原不可变结果，选中失败 call 的旧控制帧不再当作已接受结果；依赖它的尚未开始消费者随后执行。这里没有实现一般动态依赖失效。
- 追加式 `previousAttemptId/retryCommandId` 链在 ownership/CAS 准入和恢复时校验，拒绝伪造前驱、丢失重发证据、同命令不同目标、陈旧版本和竞争准入。相同命令的当前/冷启动重交只读回状态。若已接受 retry 但尚无新 intent，显式 resume 可以继续这个已批准的 attempt，不会另建 retry；普通 resume 仍不把原失败变成重试。
- 验证：Node/web 类型检查通过；19 文件串行组合 **264/264**；新 retry focused **14/14**，覆盖成功复用、追加链、六次上限、unknown/未收敛/无证据拒绝、晚到物理收敛不变成重发许可、竞争/重复命令及待准入 retry 继续。跨进程场景通过：初次 pre-Provider 拒绝 → 新 attempt 完成后控制器 exit73 → 新进程继续，实际本地 CLI ledger 只有 first/second 各一次，预算为 3，复用准确新结果引用。所有原 deadlines 保持不变。
- 有效负控：临时禁用 pending-retry 选择后，同一关键用例立即失败（缺失正确控制帧），而不是复用旧失败后假绿。补晚到收敛测试时出现的首次 TS2322 是测试 spy 被推断成仅允许 completed；已改为生产 `WorkflowProviderExecutor` 类型，原失败日志保留，没有削弱断言。
- 构建及完整 `test:conversation:ipc` 通过；实际隔离 Electron main/preload 确认新 retry 方法存在，缺失历史得到准确拒绝、不造记录、不进入 Provider。现有完整场景 21 次调用均为离线 fixture；新 retry 正向证据来自真实 Service/Runner 与跨进程本地 CLI，不冒充真实 Provider 或完整 App 正向重试验收。`test:workflow:ui` 通过，但未新增重试管理按钮。
- 性能路径已登记；`performance:measure -- --scenario providers.catalog` 仍 exit1：`No counter collector matches providers.catalog`。最终组合与生产计时均标 `highLoad:false`，但没有可比较的性能结论；不声称性能通过或提速。历史超时、完整发布/CLI 门禁仍按下文保留，本轮没有关闭它们。
- 下一步由主实施会话继续：设计同根修订 lineage/storage 和动态目标依赖失效，随后实现可信 check/classifier、质量流程与管理/恢复 UI；真实 Provider/Jev、费用或业务写入仍到授权边界再询问。这个增量不是 M3 或 M1–M6 完成。

## 模板工作台增量（M2/M5，整体仍未完成）

- 已实现只读 builtin 分发源、16 项模板摘要与私有草稿分页、冻结定义提取、显式参数/默认值选择、独立草稿、源码/结构同源视图、完整源码及连续变化范围核对、发布/准确修订删除/历史恢复、绑定后进入显式审批的准备入口。全部仍使用原 compiler → Service → Runner → Interpreter，不执行另一套模板运行时。
- Portable role preference 与真实 runtime binding 分开校验；提取不复制 workspace、profile、permission、runtime identity、attempt 或运行输出。提示词/固定值仍可能含敏感内容，不宣称自动去敏。
- 当前真实隔离 Electron 生产 preload/main 交互已验证：内置只读、另存新身份、修改提示词及控制流、保留并重新打开无效草稿、保存前审阅、准确字节发布、仅准备不发送模型请求、删除后保留证据并审阅恢复。480px 桌面 renderer viewport 检查不是手机/真机验收；截图已保留。
- 自审发现并修复“无效草稿借用有效基线结构”的问题。新增生产 UI 断言在未修复版本明确失败；修复后通过。不以旧基线证明当前候选有效。
- 本增量验证：11 文件/149 项 focused 测试、原 workflow UI fixture、生产 conversation IPC + 新模板原生输入交互曾通过。最后一次完整 conversation 命令又遇 180s 工具截止/exit 137：build 和 ownership IPC 已通过，unified 只保留 21 条输入，没有完成收据，不能以旧通过覆盖。此后新增独立模板入口，当前源码 typecheck/build + `node scripts/electron-security-smoke.mjs --dev-workflow-template-editor-only` 通过，整个独立场景 Provider 调用为 0；不是账号/真实 Provider 验收。
- 打包证据对应最后 loader UI 状态调整之前的源码，当前 App 包未重新完整验收。本地 `pack:artifact` 在 240s 工具期限被终止：build、CLI build、development signing、`check:packaged-app` 已通过，整个打包命令没有成功收据。后续独立 `smoke:electron` 在 external-links fixture 30s 超时，虽打印业务断言通过标记，仍未正常退出；保留首败与现场，不标全门禁通过。未安装、未 push、未升版本。
- 必需性能测量已尝试，`providers.catalog` 没有 counter collector，返回 unavailable/exit 1；机器负载约 84–87/10 cores。新增 trace 与路径登记不等于性能测量通过。
- 目录初始/来源切换时立即标为 loading，不把尚未完成的查询显示为空；最终独立模板交互覆盖该路径。独立场景首次草稿列表等待曾失败，增加诊断后通过，未证明首败原因，不把诊断重跑当首败已关闭。
- 证据：`~/.local/state/rotom/verification-evidence/workflow-m2-template-editor.LfTzPQ/`；原日志 `/tmp/scry-workflow-template-editor.ZnkC6L/`。保留 native select、select-all、异步文件断言、缺失 Browser domain 等 fixture 首次失败和修正过程；其中错误的“等待保留草稿按钮启用”负控没有触及目标断言，不作为回归证明。
- 仍待同一实施链完成：Agent candidate authoring、完整输入/输出/验证提取合同、chat 路由与数据/成本授权、M3 失败/修订恢复与可信 check/classifier、M4 质量模式、M5 其余运行治理交互、M1/M6 授权真实矩阵。完整打包/CLI/七项延期失败及性能 collector 也仍开放；不把本增量当 M1–M6 完成。

### 外链退出诊断增量（不关闭历史门禁）

- 首败日志无法决定 marker 在原 30s deadline 前还是 cleanup 期间到达；`app.exit()` 也不是 production `before-quit` 路径，不能归因于 workflow shutdown。
- `external-links-smoke.mjs` 现记录最多 32 条单调时钟事件：assertions、exit request、deadline、process exit、stdio/child close 与登记进程 cleanup。deadline 先固定当时输出/身份，再清理，不用 cleanup 期间晚到的 marker 证明按时通过。成功仍同时要求 marker + child close code 0，deadline 仍为 30s。
- 当前正常 fixture 通过；另用临时副本故意在 assertions 后挂起退出：4.518s 收到 marker，30.004s 时 root 仍活且没有 exit request，30.573s 登记的 4 个进程已清理；即使 cleanup 后 child code 0，整项仍 exit 1。此负控证明未把 marker 或 cleanup 当正常完成。
- 原 timeout 的具体原因仍未知。下次发生时凭新增 deadline 快照决定是执行耗时、native exit 还是 stdio/子进程问题；不加超时，不把诊断通过当历史 full gate 已关闭。日志为 `/tmp/scry-workflow-template-editor.ZnkC6L/external-links-{timeline,with-deadline-evidence,hold-exit}.log`。

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
- 支持有限类型/枚举/数组/对象及新增union，深度16/节点256、数组≤4096、复用原16,384字符输出上限；不执行schema扩展、截取JSON片段、类型强转或补零。null/false/0/显式unknown保持原样。具体已落地语法见 [program-ir.md](program-ir.md)。这是宿主类型校验，不是Provider原生强制JSON、工具禁用或内容真实性证明。
- 新增22项回归，11文件131项Workflow测试、Node/web types、build通过；故意关闭运行时数据门后6项失败，恢复后35项相关测试通过。只读源码/命令证据 `~/.local/state/rotom/verification-evidence/workflow-m2-values-8k8viz79/`，不代表真实Provider/App验收。
- 新增bind/branch及有限表达式：字段投影、比较、保守unknown布尔组合、count/concat、保留成员的group/unique、保留matched/rejected/unknown的filter/partition。编译检查类型、前置依赖、兄弟隔离及分支私有绑定；分支结果带arm标签，未选arm记skipped且不派发。该阶段规划提示仅声明当时语法；后续map/loop实现见M3。
- 同一Runner新增CAS控制帧与内容寻址值存储，真实文件锁串行跨store竞争；选择落盘后才执行子任务，结果先落盘再推进。unknown及其他终态不可被重置覆盖。没有把这些帧当作已实现完整恢复执行；显式栈的后续进展见M3，后续map/loop、carry/最佳候选进展见M3，恢复与sibling复用仍缺。
- 本阶段Node24.18.0/macOS：13文件160项Workflow测试、Node/web types及build通过（focused-delivery.log/typecheck-delivery.log/build-delivery.log）。最终源码unknown→else负对照为2失败/13通过（错误completed和额外派发）；按SHA256恢复原字节后相关42项通过（restored-delivery.log）。首轮长ID临时文件超限及测试数据类型失败均保留，分别修复writer临时名和准确JSON类型，没有删断言或加超时。
- 本阶段只读证据位置：`~/.local/state/rotom/verification-evidence/workflow-m2-controls.boPZeS/`。性能命令对映射的providers.catalog报告无collector，不是性能通过，也不是Runner性能证明。
- map/collect后续进展见M3；规范中的classifier call target、剩余表达式/集合操作、loop高级恢复、路由/模板/发布及M3完整动态执行/恢复仍未完成。候选筛选与裁决属于M4质量策略，不因旧台账写过choose而新增规范未要求的独立执行指令。M1生产App证明及M4–M6继续保留，不用本阶段单测/存储合同代替完整交付。

### M2/M3 模板数据发布基础（不是模板全生命周期或 M1–M6 完成）

- 新增有限 `WorkflowTemplateDefinition`、个人/项目来源、主进程生成 ID、真实 UTF-8 字节 SHA-256、草稿 CAS 和候选指纹。参数 schema/default、角色偏好及 body 复用既有 schema/作用域/依赖编译器；角色偏好不包含 profile、权限或 runtimeIdentity，也不授予执行能力。无效源码只留在 App-owned 草稿。
- 当前定义仍是固定目录 JSON；不可变内容及实际观察的来源快照、发布 intent/收据在 App-owned 数据域。保存验证准确基线和已审阅候选，先持久 intent 再原子发布；中断后只核对文件，不重写。另存生成新 ID；外部修改冲突保留候选；显式刷新重读，不以 mtime 或成功文本充当证据。保留 BOM 原字节，不静默改变修订。
- 项目目标锁在同一宿主用户的共享私有临时目录，不在项目内，也不因 userData 不同而分裂。两个数据域中，第一个发布器暂停时另一个不能覆盖。工作流根、控制帧及模板锁均要求证明旧 owner 不存活；活 PID、未知身份或损坏 owner 不能因时钟过期被接管。Recorder 的既有默认锁策略未改。
- 新模板 IPC 使用生产 trusted wrapper；scope 仍以已有项目 authority 为准。目录与三份 authority 索引使用异步 I/O，沿用现有主索引/备份/拒绝合同，不建立第二套授权表。拒绝符号链接、越权根、超限定义及私有运行字段，列表每页至多100个 ID。
- 当前 Node24.18.0/macOS：25文件290项串行 focused、Node/web types、593项 CLI release/独立包 smoke、当前生产 preload/main conversation gate、既有工作流交互 smoke 及本地 pack:artifact/security smoke 通过。两个独立 Node 进程分别在 intent 后与目标发布后实际退出，冷控制器不重发，后者还核对 inode/mtime 未变。生产模板 API 验证个人/项目、另存 ID、准确源码、重复收据与外部冲突；模板步骤的 fixture Provider 账本零新增。原 conversation 场景仍有21次测试 Provider 调用，不是真实账号。
- 六个故意破坏对照分别产生3/2/1/1/4/1个失败：活/未知 owner 接管、略过基线、恢复重写、按 userData 分裂项目锁、同步 authority 读取、剥掉 BOM。源码均按原字节恢复。首轮测试数据的非 canonical 临时路径、缺少已有 session 规范化字段，以及初版测试类型错误已修正；不改业务断言或 deadline。证据：`~/.local/state/rotom/verification-evidence/workflow-m2-template-publication.zSIN60/`。
- 当时尚缺（实例化后续进展见下节）：模板实例化并冻结定义/参数/实际角色/程序快照、输入输出与验证合同的完整提取、builtin、历史/恢复/删除接口、Agent authoring transport、source/diff/保存 UI 和真实交互。这里只证明数据发布基础，不是 M2.7、M3.8 或 M5.4 整项验收。真实断电、不同宿主/临时目录命名空间、不合作进程的检查后抢写不在本次证明内；不是跨文件 exactly-once。
- 接下来由本任务接通现有 Service/compiler 的模板实例化，再完成编辑入口与其余 M1–M6。无 Provider/Jev 发送、patch apply、安装、push 或版本升级。七项延期全量失败、历史并行恢复超时和无性能 collector 仍开放；当前 collector 查询对 providers.catalog/startup.recovery/新模板 trace 均为空，没有宣称性能测量通过。

### M2/M3 模板冻结实例（仍不是模板全生命周期或 M1–M6 完成）

- 新增生产 trusted `workflow:instantiateTemplate` 与 typed preload API，异步重验已有工作区 authority/current cwd。saved ref 或准确 draft revision/candidate 才可冻结；私有不可变源码、来源/修订、实际参数与角色/runtimeIdentity、编译程序均纳入既有实例与修订合同。参数降低为带 schema 的普通 bind，不做文本替换、不调用规划模型、不新增执行链。
- 显式实际角色不同于便携偏好；拒绝 renderer runtimeIdentity、缺失/多余/类型错误的参数和不完整绑定。能力不可用保留 unavailable，不改用其他 Provider。必须显式审批，开始/继续时重验实际 runtime。Only This Run 不发布；重复/冷恢复/双控制器竞争不能覆盖已执行根。
- 27文件309项 focused 按三个不重叠串行分组通过；Node/web types、当前生产 IPC（模板步骤零新增 Provider 调用、普通 bind 经真实 Service/Runner 执行）、既有 workflow UI fixture、本地 pack:artifact/打包安全 smoke 通过；本地包不是发布或 CLI gate 全绿。槽位真实排队、active 调用、父 checkpoint 失败后续接均验证源更新/删除不串实例；后者不重发已提交调用。
- 三项故意破坏各触发1个预期失败：覆盖已存在根、去掉参数 schema 导致默认字面量错误收窄、用当前源码替代不可变历史。均按完整源码字节恢复。首轮 fixture 的未改变草稿/空 invariants、测试类型及错误文案匹配已修正，没有修改业务保护或 deadline。生产 smoke 的原 catalog 没有模型与 workflow capability，因此首次如实显示 unavailable；新增显式 opt-in 的合成 catalog/作用域 fixture，没有放宽生产 gate。
- 限制保留：首次26文件合并运行在180s工具期限后中止，只记录到首文件15项通过；拆分通过不证明合并/默认并行稳定。默认 CLI release 本次592通过、1个未修改的 Recorder 超长 prompt 用例在5000ms超时；同用例受控单进程诊断通过，不把它当整项 gate 通过。历史七项延期失败、恢复并行超时及无性能 collector 也未结案。原失败日志保留。
- 证据：`~/.local/state/rotom/verification-evidence/workflow-m2-template-instance.zaLvJf/`。没有安装、push、版本升级、真实 Provider/Jev 发送或 patch apply。下一步由本任务继续输入/输出/验证提取、builtin、历史/恢复/删除与编辑入口，再推进其余 M1–M6；真实账号/费用/写入另需明确授权。

### M2/M3 模板历史、恢复草稿与删除 API（不是模板 UI 或 M1–M6 完成）

- 新增生产 trusted/preload `templates.history/revision/restoreDraft/delete`。只分页列实际保留的源码引用（至多100项），不把未发布候选当已发布版本；缺失/越权/损坏记录不补假数据，不扫描 Git。公共读取及重复收据仍重验项目 authority，运行的私有冻结读取保持独立。
- 恢复生成准确旧内容的独立草稿，绑定明确的当前基线或 absent/null，不直接改文件；之后仍经既有候选审阅/CAS 发布。同 ID 删除后可恢复；无效历史只成为无效草稿。删除只移除确认修订的当前定义，不删除历史、其他同名来源或运行快照。
- 删除与发布共享跨 userData 的项目目标锁；保留基线快照、先 durable intent 再 unlink/目录同步。中断后只核对后置条件并同步目录，不再次删除：存在/替换为 unknown，准确不存在且基线证据完整为 reconciled_absence；完成收据不因后来恢复而再次操作。不是对删除 actor 的归因或跨文件 exactly-once。
- 当前定向覆盖历史准确字节/BOM、失效与缺失、页边界、恢复不写、删除 CAS、授权撤销、损坏/符号链接、重复收据及跨域锁。三个真实 Node 子进程在 intent 后或 unlink/同步后退出，冷控制器保留仍存文件或后来替换的 inode/mtime，缺失时不重建模板目录。故意采用最新修订、重删、恢复时直接写分别触发预期失败，源码已恢复。
- 本阶段证据：`~/.local/state/rotom/verification-evidence/workflow-m2-template-history.xxjQbq/`。生产 IPC 将真实新 API 与原冻结实例串联，删除后旧实例仍走同一 Runner；模板步骤零新增测试 Provider 调用，整个 conversation 场景仍21次合成调用，不是真实账号/模型。最终检查与来源清单见该目录。
- 未完成 builtin、完整输入/输出/验证提取、Agent authoring、source/diff/保存界面、修订程序恢复及其余 M1–M6；无性能 collector。前阶段默认 CLI release 的1项5000ms超时及旧七项延期/并行稳定性问题未被本阶段通过抹掉；未重跑该未改动失败集合，也未将其报告为全绿。没有安装、push、版本升级、真实 Provider/Jev 调用或 patch apply。下一步由本任务补 builtin/提取合同及编辑入口。

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

### M3 当前执行栈进展（不是M3完成）

- 已用唯一WorkflowInterpreter显式activation stack替换Runner递归控制求值；Native调用、预算、slots和outcome仍走原Runner，不引入第二套程序或生成JS。
- framed sequence增加cursor与带版本的已提交child/result引用；子结果先持久化、父cursor提交成功后才进入后继。注入父提交失败，已完成首个子任务可查，第二个不发送。
- Node24.18.0/macOS：13文件161项Workflow回归、Node/web types、build通过；省略父checkpoint负对照3失败/13通过，按SHA256恢复后16项相关测试通过。只读证据：`~/.local/state/rotom/verification-evidence/workflow-m3-stack.CQmGyT/`。
- map后续进展见下节；仍缺普通M0程序控制帧统一、跨进程恢复、loop/carry/最佳候选的恢复和依赖/sibling恢复。历史unknown仍不可重发/退款。本阶段没有真实App/Provider验收，既有性能collector缺口与七项延期门禁保持未验证，不因本阶段focused通过消失。

### M3 动态map与受控集合进展（仍非M2/M3完成）

- 同一IR/解释器新增动态map与显式collect，完整输入/稳定key/批次上限先验，受共享slots和根预算控制；已证明item内流水与跨窗口补位，不设整页barrier。
- 宿主mint typed集合引用，manifest保存每项状态/物理settled及不可变结果引用；失败/unknown/pending不删。cold读取核对hash/workflow/count/结构。collect保留失败摘要与0值，不把unknown当空或恢复成功。
- Node24.18.0/macOS：14文件172项focused、Node/web types、build通过；关闭重复key预检后1失败/10通过（发生本应禁止的Native test-double调用），SHA256恢复后11通过。证据：`~/.local/state/rotom/verification-evidence/workflow-m3-map.Yvzbbh/`。
- 嵌套collection字段投影和超4MiB集合的按项group/filter后续进展见下节；仍缺普通M0统一持久化、完整loop/carry/最佳候选的依赖恢复。map本身不是M3恢复完成；Provider executors仍是test double，无App/账号验收。M1、M4–M6、性能collector缺口和延期门禁保持原状态。

### M3 嵌套受控集合投影（局部验收）

- main 的 known value 增加位置明确的 `collectionFields`，经 outcome.value、parallel、collect、字段投影及普通数组变换保留受控集合读取权。不会从模型/literal descriptor 或旧记录补发读取权。每值最多4096位置，持久化仍限8MiB；冷读校验实际manifest及准确count，缺失/伪造/跨workflow/重复位置均拒绝。
- 普通数组索引的authority一次分组，重排按索引映射，避免每个成员扫描所有位置。manifest同一次值读取去重，后续读取不缓存“仍存在”的假设；实际输出payload仍按项读取。暂无相应性能collector，不宣称提速。
- 当前typecheck、11文件/140项focused回归、build与生产preload/main→Service→Runner→Interpreter通过；新增生产场景在冻结模板中执行嵌套map→collect→field→map，准确得到0/false，Agent预算及Provider调用均0。未修复bundle同场景明确失败，保留负控。
- 证据 `~/.local/state/rotom/verification-evidence/workflow-m3-nested-collections.ygomyZ/`，原始 `nested-*.log` 与 `authority-first.log` 在 `/tmp/scry-workflow-template-editor.ZnkC6L/`。首个测试错误地用了局部return、首个缺失manifest用例路径错误，均保留，不冒充目标负控。
- 当前必需性能测量仍exit 1/unavailable（providers.catalog无collector，负载约25/10 cores）。未重新完整打包、未安装、未push、未升版本；此前完整conversation/pack截止、CLI及七项延期失败仍开放。
- 当时剩余的host collection按项group/filter已见下一增量；真正失败/修订恢复、可靠停滞/重启策略、main check/classifier和其余M1/M4–M6仍缺。该增量不闭合整体M3。

### M3 按项group/filter与纯产物跨进程身份（局部验收）

- 受控集合支持group/unique/filter/partition，不必先collect成4MiB JSON；一个payload读取完成后才读取下一项。manifest仍限8MiB/4096项，保留group keys与最终普通JSON仍有4MiB界限。不是无限流/无限批次。
- 复用同一generator表达式实现和原Control/Runner，保留0、false、失败覆盖率、unknown分类/理由和嵌套读取权。派生valueRef只引用纯数据，不可冒充Agent效果证据。未sealed、停止、缺文件、跨workflow、双重reference和值/metadata边界均拒绝或明确unknown。
- 自审发现generation参与纯产物key会错误失效已有消费者；新增真实独立进程负控在约2.3s明确因“恢复所需输入/控制帧不一致”失败（非timeout），修复后复用原partition/group准确引用、零Agent派发。不是一般失败重试或改修订恢复。
- 当前typecheck、4文件/52项focused、workflow UI、build和完整production conversation IPC通过。完整conversation的21次调用均为离线fixture；模板/新集合场景调用增量为0。旧bundle在同一生产新语法候选校验阶段失败。
- 组合回归首败保留：12文件/156项有4个原跨进程场景5000ms超时；修复generation后12文件/157项有156通过、原loop跨进程场景1项5000ms超时。原5项独立运行通过、冻结旧实现5项也通过，不能以单独通过关闭组合门禁或证明首败与改动无关。未提高deadline、未删断言/skip。当前/旧实现的串行phase诊断约2.1s，无原首败phase数据，原因仍未决定。
- 必需性能测量exit1/unavailable：providers.catalog无collector，机器负载约30/10 cores。没有L1/L2/L3提速结论。
- 证据：`~/.local/state/rotom/verification-evidence/workflow-m3-streaming-collections.x0Ge4c/`；原始日志`/tmp/scry-workflow-template-editor.ZnkC6L/streaming-*.log`。同时保留初始fixture根sequence错误、错误英文错误文案预期及schema双包outcome的首败，不作为目标负控。
- 当前完整conversation gate通过，不擦除旧cutoff。完整pack/CLI、七项延期失败与历史超时根因仍开放；该串行组合门禁的最新结果见下一节。未push、未安装、未升版本。M3失败/修订恢复、停滞重启与M4质量执行仍待实施。

### M3 测试收敛与超时现场（不改变生产执行语义）

- 独立进程诊断提交`366d58d4`保留有界阶段、独立时钟和清理前现场。负控使用原5000ms超时：清理前exitCode仍为null，owned IPC清理后才close(75)，不能把晚到关闭当作按时通过。证据`~/.local/state/rotom/verification-evidence/workflow-m3-recovery-diagnostics.nbl974qr/`。
- 该版本的下一次组合命令中，独立进程6项通过，但纯loop有4项原5000ms超时、其中3项清理ENOTEMPTY；工具在180s截止，整条命令未完成。源码证明loop fixture未持有Runner原Promise，超时后直接删除目录，可能与仍在进行的持久化竞争。这解释清理缺陷，不解释最初五秒耗在哪里。残留目录已被部分删除，只能作为事后片段，不能倒推超时点。
- `src/main/workflow-loop.test.ts`现持有原测试body及Runner原run Promise；清理先停止获登记的fixture，释放已登记的纯测试pending gate，等待原body（包括直接store调用）与原run Promise，再用已有activeWorkflowIds确认控制段已退役。stop ACK、Root返回和所有作用域/后续写入收敛不混同；未收敛则保留目录并使清理失败。一个刻意pending的纯测试fake只在teardown显式释放，不改变迟到成功断言或真实Provider合同。
- 失败保留原目录、相邻清理前diagnostic JSON与独立cleanup JSON，清理后不会覆盖原现场；持久化begin/end/rejected、开放操作与128条ring记录均不含输入/输出内容。标准库event-loop histogram有界记录样本及最大delay，无样本标unavailable。这不是性能collector或提速证据。沿用原5000ms测试、2000ms目录锁与原hook界限，不加sleep/retry。
- 新增两项回归：阻塞写入未结束时禁止删除；stop已ACK但scope未收敛时保留目录。临时副本恢复“先删目录”后，新回归因remove被提前调用立即失败；另一个受控副本在原5000ms超时后才释放直接store写入，现场保留并证明该写入于cleanup closed前完成，原超时仍失败。两个副本均已移出仓库。Node/web类型检查、loop单文件17项及同组12文件160项串行组合均通过（Node24.18.0/macOS arm64，测量机器负载仍高于10核）。当前这组门禁已绿，不能以此关闭历史超时根因、并行/完整发布门禁或providers.catalog collector缺口。
- 证据`~/.local/state/rotom/verification-evidence/workflow-m3-loop-cleanup.vb1ns0a_/`，原始`loop-cleanup-*.log`在`/tmp/scry-workflow-template-editor.ZnkC6L/`。本次只改测试与台账，不重新构建/安装App，不push，不调用真实Provider/Jev，不升版本。一般失败节点重试、成功sibling复用/消费者失效与修订恢复仍未实现；下一步先落实append-only attempt链和明确replay eligibility，不能把已settled直接当作允许重发。

### M3 有界loop与逻辑退出进展（仍非M2/M3完成）

- 新增具名initial/invariants/stateSchema/carry及显式policy，1–1000轮边界；唯一解释器调用body，主进程循环控制器提交状态，不创建模型调度回合或新AST。
- typed carry与原始/当前/best引用、ready/committed轮次、不可变轮次记录和完整退出原因已落盘。未知不进入下一轮；失败提交不新派发；连续两轮无进展与非相邻振荡区分，比较内容而非artifact nonce。
- known逻辑退出可经批准步骤生成partial报告，但根不green；这一状态穿过所有已有容器。停止与后到success均记录，停止/错误/unknown不被覆盖。generic best引用和模型布尔不是独立质量证明。
- Node24.18.0/macOS：15文件187项focused、Node/web types、build通过；关闭no_progress门后1失败/14通过（多发2轮），SHA恢复后15通过。首轮纯控制blocked丢失缺陷已在共同父状态折叠修复，裸loop拒绝测试改为明确边界合同，并保留拒绝。证据：`~/.local/state/rotom/verification-evidence/workflow-m3-loop.xauZEM/`。
- 仍缺真实main check/可靠比较器、定时事件截止、普通M0控制帧统一、实际跨进程/依赖/sibling恢复、剩余指令和生产App/UI验收。本阶段没有真实Provider调用；M1、M4–M6、性能collector缺口及七项延期门禁仍未结案。

### M3 显式继续与跨进程恢复进展（仍非M1–M6验收）

- 新Runner根（含普通M0控制块）统一持久化，根所有权version2、epoch和有界控制段进入原File/Memory store。typed preload/可信IPC新增resume；Service重验冻结runtime能力，Runner仍复用唯一原App executor。根CAS先接管再执行，保留旧帧和原预算；旧epoch写入被拒绝。
- 根据已提交意图/outcome、原输出hash、输入/分支帧复用已完成调用及封口map；已知派发前失败也不重试。无outcome意图、业务unknown（包括物理已settled）、无证明退出的活owner及旧无所有权记录拒绝。loop恢复initial/current/best、carry、invariants、轮次记录、内容历史和无进展计数，不改写旧终态。
- 独立Node控制进程+真实本地CLI效果账本共5场景（含二次恢复只落entered后再次退出的依赖链复用）：子完成/父cursor前硬退出、活owner拒绝并在关闭后继续、无outcome意图拒绝、第二轮ready后恢复并准确两轮无进展退出。真实子进程不是真实Provider账号/SDK；deny-network、临时HOME/workspace也不是文件系统沙箱。
- 当前Node24.18.0/macOS：18文件217项focused串行通过，最终fixture聚焦零新增效果后12项恢复回归通过；Node/web types、build、生产conversation IPC、CLI release 589项及pack:artifact安全smoke通过。关闭缓存效果复用后，独立进程测试失败且账本有两次first；恢复SHA后通过；只取最近空帧的另一个负对照使依赖链恢复失败。证据：`~/.local/state/rotom/verification-evidence/workflow-m3-recovery.46r4VG/`。
- 失败保留：两轮默认并行focused各1项5秒超时（活owner、loop），三进程用例的一轮专用串行检查也超时1项；初始化故障fixture先只覆盖save而未覆盖新claim，已补claim故障且保留save/停止断言；进程fixture缺required的首轮类型错误已修复。活owner删除一次不增加验收信息的冷启动后，扩大并行仍有loop超时；三进程fixture最终聚焦两个已提交依赖调用并断言零新增效果，不再附加另有场景证明的新调用。高机器负载只作环境证据，因果未证明；串行通过不等于并行门禁通过，也未提高deadline。原7项延期门禁、性能collector缺口仍开放。
- 后续本任务继续完成：完整依赖/sibling与每个提交边界恢复、停滞重启、remaining IR/路由/模板、M4/M5及真实完整App/Provider M6。安装、推送、真实账号/Jev发送与apply均未执行；未获具体授权前不做这些外部动作。最新包仅在worktree的dist，不替换用户App，不升版本。

### M3 缺失历史 no-op 合同（局部验收）

- 缺失记录的Service/Runner和可信resume入口统一返回`nothing_to_resume + null`；不创建替代根、不调用规划/能力探测/Provider、不清除其他未收敛运行的容量。缓存回执也不能绕过approval身份检查。已有记录仍按冻结程序workspace授权，不使用进度摘要作为authority。
- 18文件223项focused串行及Node/web types通过；隔离Electron以当前build的生产preload/main执行3次缺失历史请求（含重复commandId），目录和测试Provider入口账本不变。conversation gate连同构建通过。旧legacy抛错的负对照有2项失败，进度摘要冒充workspace授权的负对照有1项失败，产品源码按SHA恢复后61项直接回归通过。源码/日志：`~/.local/state/rotom/verification-evidence/workflow-m3-missing-history.ZhQY4H/`。
- 这不补齐完整已有运行恢复、模板生命周期、质量系统步骤/副本/应用、管理UI、真实Provider/SQLite验收或性能collector；历史并行超时和七项延期门禁仍未结案。未安装、未推送、未调用真实账号/Jev或应用patch。

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
