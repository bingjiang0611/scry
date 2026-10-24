# 程序控制状态与恢复合同

本页从 [program-ir.md](program-ir.md) 按职责拆分；原阶段证据与未完成项保持不变。

## 控制状态持久化的当前范围

新Runner根执行（包括普通sequence/parallel/call/return）统一写入内容寻址的值artifact与CAS控制帧。帧记录程序修订、作用域、输入来源、分支选择与decision/result引用。值先落盘，再提交引用它的帧；选择帧成功后才派发被选子任务。校验失败、缺artifact、修订/输入不符或已终态帧均拒绝覆盖。unknown帧不可重置为entered/completed。

新运行的作用域身份含程序修订及分支选择来源；无version2执行所有权的旧记录只保留观察路径，不自动升级为可执行运行。现有Agent预算/intent与outcome仍由同一Runner提交，不因控制帧退款或重发。

控制求值现已从Runner递归方法迁入唯一`WorkflowInterpreter`：sequence/branch通过显式activation stack求值，parallel各fiber有独立栈，Native调用仍委托原Runner/slots/intent/outcome链。带控制帧的sequence在子结果提交后持久更新cursor和带revision/resultRef的children引用，然后才进入后继；cursor表示已登记子结果数量，不单独授权派发，未知/失败结果仍停止依赖。

测试注入父cursor提交失败后，首个子调用的outcome/终态帧/值仍可由独立store读取，第二个调用不执行。引用读取同时校验frame revision、resultRef和内容hash，不把未完成帧当已提交结果。省略父checkpoint的负对照使3项测试失败。

最初显式栈阶段的161项回归与限制保留于`~/.local/state/rotom/verification-evidence/workflow-m3-stack.CQmGyT/`；后续普通程序统一持久化与显式继续见下节。**这仍不是M3整体恢复完成**，观察式历史恢复本身始终不派发。

## 显式继续与跨进程恢复的当前范围

`window.scry.workflow.resume(workflowId, approval, commandId)`复用Service、唯一Interpreter/Runner及原App executor链。新根记录带`execution.version:2`、owner与最多256个控制段；命令回执有界且持久，重复命令不重发。完成运行返回`nothing_to_resume`并附原进度；缺失记录返回`{state:"nothing_to_resume",progress:null}`，不合成进度、空根或新执行。已有记录的workspace授权仍来自校验后的冻结程序，不以进度摘要代替。完整依赖恢复及已知失败attempt的明确重试仍待实现。

- 先核对冻结程序、角色/profile/模型/权限、当前runtime能力、原意图/outcome与单调根预算。未知业务结果即使物理settled也拒绝；PID仍存活或无法证明原owner退出则不接管。旧无所有权记录只读。PID复用按仍存活拒绝，不声称识别并接管复用后的进程。
- 接管以根元数据CAS提交新epoch/控制段；旧epoch不能覆盖根、增加预算或再派发。旧终态帧不改写；新帧通过generation与origin关联旧证据。恢复核对分支选择及输入来源，复用有hash校验的原输出和已封口集合引用，不重新调用已完成或已知失败的任务。
- 每个逻辑节点的历史帧读取成本随控制段线性增长，最多256段；若实际量测显示这成为主因，再增加受canonical帧校验的索引，不以索引取代权威记录。loop从持久ready/committed恢复carry、initial/current/best、invariants、迭代记录、内容历史及无进展计数；不把逻辑迭代当transport重试。两个进程间在第二轮ready处退出的场景验证了第二轮消费candidate-1、两轮无进展退出、原seed/best保留及根预算3而非重置。
- 5项独立控制进程场景使用真实本地Node子进程和effect ledger；覆盖子结果完成后硬退出、活owner拒绝、无outcome意图拒绝、loop恢复，以及第二个控制器只写entered帧后再次退出。最近控制帧不覆盖更早已提交结果/loop/decision的证据；三进程回归要求两个已提交依赖调用都复用，零新增效果。macOS用deny-network策略、隔离HOME/工作区；不是文件系统沙箱，也不是账号/模型、真实Provider SDK或完整App的Workflow验收。
- 18文件217项focused在`--maxWorkers=1`通过；其后仅将三进程fixture专注到两个已提交依赖调用（不再附加本已另测的新调用），最终12项恢复回归及types通过。当前App代码的build、conversation IPC、589项CLI release合同及打包安全smoke通过。故意绕过旧效果复用后，用例失败且effect ledger确有两次first；故意只取最近空帧后，已提交依赖链恢复失败。两处均按原SHA恢复；产品源码与通过217项时相同，最终fixture日志另存。初始化存储故障注入随新CAS入口移至claim，同时保留save故障及全部断言。
- 两轮默认并行focused各有1项5秒超时（活owner、loop）；新增三进程用例后，一轮专用串行进程检查也超时1项，日志和失败现场均保留。最终活owner用调用测试的独立进程做拒绝检查，三进程用例要求零新增效果；删除的是重复冷启动/非本场景必需的新调用，不删除owner、依赖链、预算或旧引用断言。10核机器曾记录load38/109/98，后一次约24/20/25，不能据此断言根因。最终12项通过不抹掉这些失败，不提高deadline，不声称默认并行门禁已绿；后续由本任务继续定位争用/收敛。既有7项延期全套失败、Runner性能collector缺口也未关闭。

缺失历史响应后续验证：18文件223项focused串行通过；生产构建的preload/main在独立Electron实例中执行3次缺失历史请求（含同commandId重复），均返回无进度no-op，目录和测试Provider入口账本不变。恢复旧legacy抛错使2项回归失败；错误地采用进度摘要作workspace授权使1项回归失败，之后按SHA恢复产品源码。证据：`~/.local/state/rotom/verification-evidence/workflow-m3-missing-history.ZhQY4H/`。此API局部验收不证明已有运行的完整恢复、真实Provider/SQLite或生产管理UI。

源码与日志：`~/.local/state/rotom/verification-evidence/workflow-m3-recovery.46r4VG/`。产物为未安装的本地Scry0.2.210；打包/通用IPC smoke不代表新的恢复API已在生产Workflow UI、SQLite归档链和每个提交边界端到端验收。

## 证据

结构化输出前一阶段：11文件131项Workflow回归、types/build通过；故意关闭输出合同后6项失败。证据范围保留于目标台账。

本阶段命令、源码快照和负对照保留在`~/.local/state/rotom/verification-evidence/workflow-m2-controls.boPZeS/`。生产Runner与真实临时文件存储的合同测试证明选择先持久化、未选arm不执行、unknown不当false、跨store CAS、内容hash及不可覆盖终态。故意将unknown路由为else后两条回归失败（错误completed及额外派发），随后恢复原字节并通过。

首轮测试发现长ID的临时文件名超限，已在原atomic writer修复；首轮typecheck发现测试数据的可选undefined推断，已用准确JSON值类型修正。未扩大超时或删断言。最终检查数与日志见证据目录及台账。

真实App、真实Provider/费用、Provider原生JSON/工具禁用及M2/M3完整控制指令尚未验收。性能命令对providers.catalog返回`No counter collector matches`，不是性能通过；尚无Runner专用计数证据，不作更快声明。
