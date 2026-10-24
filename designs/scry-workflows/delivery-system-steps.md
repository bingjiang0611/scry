# M3/M4 工作副本与检查交付证据

本页从 [m1-m6-delivery.md](m1-m6-delivery.md) 按职责拆分；原阶段证据与未完成项保持不变。

## 20 KB 门禁下的职责拆分（本轮附加；非新执行链）

- 原提交被共享 hook 拦截：当前 worktree 缺其 checker，四个旧文件也超过完整暂存版本20,000字节上限。维护者明确批准拆分后，补入与主线 `fdb511d7` 完全同 blob 的 checker；不跳过 hook、不放宽上限、不改共享 Git 配置。
- canonical Runner 保留运行/停止/恢复/owner/CAS 与持久化；contracts 保存原类型及同一 ScopeError/Dispatch 类并由旧路径 re-export；slots 原类原样移动；effects 与 system handler 按 Agent/SystemStep 拆分，二者仍用同一个 reservation queue、同一个 Runner persist callback。不是新增调度器。live feed 生命周期移回 observation 模块，补回归防止 root id 混入原 attempt identity，仍保持 owner fence 与幂等 close。
- 系统测试按副本 Agent、输入/诊断、系统持久化划分，共用原 fixture；未删场景或断言。设计台账按系统步骤/模板/恢复拆分，程序说明按核心/集合/恢复拆分；导航及已知引用已核对。结构核对证明 Slots 类、17个根生命周期方法（仅预期的委托名替换）及原23个文档章节内容均保留。
- 拆分后 Node/web types、24文件 **283/283** 串行检查、build + 完整 production conversation IPC 通过。Vitest69.53s，10核load13.41→14.13、highLoad=true，不作为提速证据。第一轮 split 类型检查发现旧import与一处frame copy import，已修正；无 deadline 或门禁放宽。未关闭既有扩大组合/CLI/collector问题。日志：`/tmp/scry-workflow-template-editor.ZnkC6L/input-snapshot-split-*`。

## check 输入观察与期间差异增量（M3/M4 子集；整体未完成）

- 检查前，在副本串行 lease 内重新采集实际输入，而非沿用副本最初 receipt 的 hash。完整清单按有界不可变 string parts 保存，观察头绑定 root/step/phase；before 引用必须先写入原 canonical intent，持久化失败不启动 native。相同 fresh-scan hash 的原始 parts 在同根复用，观察头/时间仍各自独立；没有另起调度器或退款/重置预算。
- 只有本次登记 native scope 已证明关闭，才采集 after；比较内容 hash、文件类型、mode、链接目标/长度，按 path 稳定排序得到 added/modified/removed。结果属于该副本/步骤的**观察区间**，不证明由该进程独占造成；不是原子文件系统快照、完整审计或可还原的文件内容版本。沿用原扫描边界：根 `.git`/`.scry` 排除；不收集 mtime/xattrs 或两次观察之间发生后又撤销的变化。
- 原 `check` 值增加 optional `inputs.before/after/changes`，原 field/concat/map 等可消费；summary 只携带有界引用，不把大清单塞进 progress/IPC。旧结果没有字段就没有该证据，不补造或重跑。scanner 失败/取消、native 仍开放、差异 >4096 项或 >2 MiB 均是 unavailable、无 items；完整程序值仍受 4 MiB 限制。超出差异上限需明确缩小目标或设计经批准的集合合同，不自动分批绕过4096上限。清单沿用32768条/8 MiB、文件内容2 GiB上限，未调大。
- 真正退出0与 post-evidence unavailable 是两件事；保留实际命令结果，质量比较必须另检查证据可用性，不能由 passed 一项认证整体质量。unknown/stop ACK 不触发 after 扫描、不释放未收敛容量，晚到物理关闭仍不给重发资格。缺 before/after/changes、任一末尾 part、跨根引用或 intent 关联不一致均阻止冷恢复，不靠再次执行补证据。
- Node/web types 与 **18文件240/240** 串行相关检查通过（Vitest61.29s，10核，load6.17→6.26，highLoad=false；不是提速证据）。新增实文件内容/增删/mode/link 比较；合成 >4 MiB/>4096行清单的完整分片、Unicode跨边界、末片缺失及同数据不同观察头；前置checkpoint拒绝；Agent先改候选再check的区间隔离；未知scope容量；post不可采集；冷继续证据缺失/篡改。禁用 before-check checkpoint 的负控明确失败。类型首败为新union推断、常量名和fixture callback未更新；Mac临时路径首败改为canonical realpath；首轮 production fixture 误用不存在的 record 表达式，被正式 validator 拒绝，改用现成 concat；未削弱校验、断言或 deadline。
- 最新 build + 完整 production conversation IPC 通过：本地 Node 子进程启动后自行读取实际 FileStore intent/header/全部parts并校验 hash，随后只在副本写一项 marker，退出1并输出两项 TS诊断；同一程序精确汇合诊断与期间差异，native只有1次、Agent尝试/Provider增量0、源marker不存在、同命令不重跑。原副本 Agent/真实managed Recorder/归档和冷权限拒绝继续通过；全部Provider仍为离线fixture，不是真实账号、tsc或仓库业务检查验收。
- 新工作确实增加前后两次有界目录/hash读取；字节复用测试只证明 immutable parts身份复用，不代表整体耗时改善。已执行 catalog measure，仍因无匹配collector exit1/unavailable，不关闭该性能门禁；1000-attempt组合超时、CLI及七项历史延期也未关闭。未安装/push/升版本/调用真实Provider或Jev/产生费用/应用业务patch。日志：`/tmp/scry-workflow-template-editor.ZnkC6L/input-snapshot-*`。
- 主实施会话下一步：冻结候选与独立验证副本的输入关联、必需验证集合及可信进展/回归比较，再推进 classifier、修订恢复、组合/应用/清理与生产管理/聊天入口。该增量不等于质量流程或M1–M6完成；变化清单也不补齐 Recorder 的 Git baseline/diff。

## main 诊断的数据流消费增量（M3/M4 子集；整体未完成）

- check 的有界程序值新增 `diagnostics` envelope：available/derived/items 或 unavailable/reason。真实解析项包含 file/line/column/code/message，可通过原 field/map/collect/branch 消费；不建立第二个质量解释器，也不从 Agent 自述补诊断。诊断不可用时无 items，读取会阻止下游，不伪造空集合或零错误。
- 新字段在 schema 中保持 optional，已经提交的旧结果不被修改、补造字段或重新执行；旧程序仍可消费原 passed 等事实，旧值没有诊断集合就没有这份证据。沿用每值 4 MiB、集合 4096 的限制；超限仍保留失败证据，不截断为通过。
- Node/web types 与 17 文件 **230/230** 串行相关检查通过；冷 Service 在 check 已提交、父 cursor 失败后直接读取两条真实 TS 诊断进入 map/collect，native count 仍为1。unrecognized 输出没有 items，消费者 blocked；模拟既有六字段值仍能冷继续且不重跑。临时移除程序值的 diagnostics 后，两项关键断言均明确失败，未弱化断言。首轮 fixture 误把已冻结 authorization 与新 parser 一起提交，被正式 validator 拒绝；改用既有 sourceBody 提取再重新冻结，而非放宽校验。
- build + 完整 production conversation IPC 通过：真实本地 Node 在登记副本返回 exit1，main 派生 TS2322/TS7006 两项；模板经同一 canonical map/collect 精确返回这两条完整诊断，Agent 尝试/Provider 增量0、native只有一次、源不变、同命令不重跑。原副本 Agent 与 Recorder/归档/冷权限拒绝场景仍通过。并非真实 tsc/仓库测试或真实 Provider/Jev 验收。
- 剩余工作仍由主实施会话推进：检查前后输入/改动快照与验证归属、可信进展/回归比较、classifier、必需验证及完整质量流程，随后修订恢复、组合/应用/清理和管理/聊天入口。现有输入副本、诊断数据和离线 App 证据不能替代完整质量合同。历史性能 collector/1000-attempt/CLI/延期门禁不因此关闭；未安装、push、升版本、产生费用或应用业务 patch。日志：`/tmp/scry-workflow-template-editor.ZnkC6L/diagnostics-*`。

## 副本 Agent 的 App authority 与归档增量（M1/M3/M4 子集；整体未完成）

- `call.replica` 是可选的有限表达式；省略时仍运行于已批准源工作区。表达式参与类型检查、总文本预算、控制帧 inputKey 与模板结构引用；只有同根 main 铸造的副本 sidecar 能执行，普通 JSON 描述不能授权。仍使用 canonical Runner → 原 App executor，不增加调度器或 renderer 任意目录接口。
- effect 前持久 Agent intent/预算，并关联副本引用。main 取得串行租约，签发不可序列化、限本次执行的内存 grant；App 起跑和 dispatch 前重验副本目录身份及源项目权限。实际副本的 Provider/profile/model/permission/运行时目录仍重新读取；只有有效 grant 允许把 cwd 绑定回已批准源位置，其余 fingerprint 字段不能变化，原生仓库 executable/MCP/Hook trust gate 未绕过。
- result producer 与原 physical scope 都收敛后才释放副本租约和内存 grant；stop ACK 不是释放证据。等待租约时可取消，未进入 executor 可明确记录 not_attempted；未证明作用域收敛的未知执行保留租约及原容量/预算，不回退到源目录。父 checkpoint 失败冷恢复复用已提交 Agent outcome，不再调用；intent 丢失副本关联会拒绝恢复。
- App/Recorder/archive 使用实际副本 cwd。catalog 保留 `workspaceScope:workflow_replica` 的真实会话证据，但不投影为普通项目，也不从它生成全局项目权限；pending→native→terminal、重启和 Qoder catalog 补证保留来源。显式目录选择的原权限政策未改变。计划预览分页展示副本 Agent 目标及本机权限/非自动写回后果。
- Node24.18.0/macOS：Node/web types 与 17 文件 **227/227** 串行相关检查通过。新增覆盖 grant 伪造/跨 host/错误 cwd/过期拒绝、一次副本写入且源不变、cold reuse/关联篡改拒绝、排队取消、stop ACK 和先物理收敛仍等待结果 producer、catalog 来源不丢失。禁用 main grant 成员检查后，描述符伪造回归确实失败；未扩大 deadline。
- build + 完整 production conversation IPC 通过。既有 unified 21 个离线调用之外，本增量实际经过 preload/main → canonical Runner → App adapter 派发 **1** 个离线 Provider：只写副本，Agent 预算 1；真实 managed Recorder 生成 1 个 canonical turn，App trace archive 精确关联该 run/cwd。普通 start 私有目录在当前/冷 App 都拒绝且不进入 Provider；重复 start 当前/冷重交均不增加调用。第三次隔离 App 重启专用于这项验证，原 unified 两次身份重启验收保留。Native Chromium workflow fixture 验证分页、目标引用、授权文案和原焦点/审批流程；mechanical detector 无 findings。
- 首败保留：租约测试把 acquire 的 allowIncomplete 参数误当 try-lock 而在 5000ms 超时，改为观察真实 release 边界并保持原 timeout；一次 TS2322 源于字段分隔符笔误。生产 fixture 首次在 calls ledger 创建前取样、一次漏声明 orchestrator、一次误按顶层 runId 查 archive；分别修正执行顺序、正式角色声明、按现有 turns envelope 查询，没有改业务 validator、计数断言或套空结果。最后一次串行包装器曾因其他 worktree 持有 timing lock 返回75；未删锁或干扰进程，确认原 PID 已退出后才继续。
- **限制与下一步**：此证据是离线 adapter 的真实 App/Recorder 链，不是真实账号/SDK；副本当前不携带 .git，session diff 明确 unavailable/not_git，不能当作完整 Git baseline/diff/patch 质量证据。下一步由主实施会话补诊断程序消费和质量快照/验证合同，再接 classifier、修订恢复、组合/应用/清理和剩余 UI。providers.catalog collector 仍缺失；既有组合 1000-attempt 超时、CLI/七项延期问题未关闭。未安装、push、升版本、调用真实 Provider/Jev、产生费用或应用业务 patch。日志：`/tmp/scry-workflow-template-editor.ZnkC6L/replica-agent-*`。

## main 副本与检查增量（M3/M4 原语；整体仍未完成）

- 新增 replica/check 数据节点，仍走 compiler → Service → canonical Runner → Interpreter → main effect host；没有第二套调度器或任意宿主函数 API。main 冻结命令/解释器/环境/入口文件指纹；同根真实副本使用 opaque authority、输入清单、目录 inode 与租约，不从 Agent JSON 或普通路径推断权限。副本包含当前 dirty/untracked/ignored 内容；边界和上限见 [程序合同](program-ir.md#main-工作副本与检查步骤已接入非完整质量模式)。
- 系统 intent/结果独立持久，不计 Agent 尝试、不退款；共享原槽位、原根 CAS/epoch/控制段。结果落盘失败也不丢掉原 native scope 的占用；晚到物理收敛只更新范围证据，不赋予重发资格。冷启动缺失 outcome 保留系统容量；退出治理也检查该账本。父 checkpoint 失败复用准确结果；缺失 stdout、错误 artifact 身份或副本收据拒绝，不再执行检查补证据。
- 计划预览分页显示命令、目标、cwd、超时和解析器，并说明本机权限与副本非沙箱。进度区单列最近 64 个 main 系统结果，区分“已记录结果”和“检查未通过”；最终报告不再把纯程序结果误标成 Agent 输出。模板禁止主机 authorization，提取时删除该字段，实例重新冻结并审批。
- 当前 Node24.18.0/macOS：新增 **3 文件 36/36** 通过；最后源码相关 **12 文件 154/154** 通过，包含程序文本预算回归；Node/web types、增强的真实 Chromium 输入 workflow UI fixture、build + 完整 production conversation IPC 通过。生产 preload/main 在独立 userData/工作区中实际执行两次本地 Node 检查：exit0→true、exit17→false；各只有一次 native 执行，原工作区未被脚本写入、Agent 尝试为 0、重复 start 不重跑，Provider 增量为 0。完整原有 conversation 场景的 21 次调用仍全部是离线 fixture，不是真实账号/SDK 验收。
- 负控有效：上一 App bundle 在同一生产新场景以“未实现 replica/check”拒绝，当前 bundle 通过；临时去掉槽位对 native scope 的等待后，“结果 artifact 写失败仍须保留容量”测试在 queued=0（应为1）处失败。模板测试首次使用非 UUID templateId 失败，已修正 fixture 为正式合同要求的 UUID，未修改 validator 或删断言。自审补齐 replica source 的 4 MiB 程序总文本计数，并在 main 冻结字段加入后重验整个程序；临时禁用计数后新增回归明确失败。单次准备中完全相同的 check 共用一次冻结/指纹读取，spy 验证实际一次，没有给出毫秒提速结论。
- **组合检查未全绿**：26 文件 325 项中 324 通过；既有 1000-attempt 用例在原 5000ms deadline 超时。取父提交 Runner 的临时对照也在相同 deadline 超时；这不证明全部根因或所有共享依赖与本次无关。随后当前源码的单场景 CPU 采样运行通过（1 passed/11 未选择，约3738ms），主要采样落在 MemoryWorkflowStore.save/控制帧复制验证；不据 focused 通过关闭组合首败，也未增加 deadline、缩减工作量或重跑刷绿。后续仍由主实施会话定位并修复可证明的工作量问题。
- `performance:measure -- --scenario providers.catalog` 仍因 `No counter collector matches providers.catalog` unavailable/exit1；登记来源不是 collector，不能宣称性能通过或提速。UI mechanical detector 返回空 findings；外部 warning-text 参考仅用于权限后果文案，不代表视觉/完整 App 已全部验收。日志保留在 `/tmp/scry-workflow-template-editor.ZnkC6L/system-*`。
- 副本 Agent 的 App authority 与 Recorder/归档关系后续进展见上节；主实施会话继续接入诊断数据消费与 classifier、质量流程/必需验证、组合/应用/清理；再完成同根修订恢复、chat 路由和其余管理 UI。现有 Manager 原语不是这些流程已完成。真实 Provider/Jev、费用及业务 patch 仍保留明确授权边界；未安装、未 push、未升版本。
