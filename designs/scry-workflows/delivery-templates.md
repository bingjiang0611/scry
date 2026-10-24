# M2/M5 模板与编辑交付证据

本页从 [m1-m6-delivery.md](m1-m6-delivery.md) 按职责拆分；原阶段证据与未完成项保持不变。

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
