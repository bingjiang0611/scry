# M3 解释器、恢复与重试交付证据

本页从 [m1-m6-delivery.md](m1-m6-delivery.md) 按职责拆分；原阶段证据与未完成项保持不变。

## 显式失败重试增量（M3，严格子集；整体仍未完成）

- 新增 `WorkflowApi.retry(workflowId, approval, { taskId, attemptId, expectedRevision }, commandId)`，经现有可信 IPC → Service → Runner → Interpreter 执行。先校验冻结程序/运行时、原根全部效果收敛和观察版本，再持久化 retry 控制段；只在原预算内追加 intent，不修改旧 attempt/outcome，不退款。每个同修订逻辑调用最多 6 次 admitted attempts，根仍最多 1000 次、控制段最多 256 个。
- 本轮只允许 `sequence/parallel/call/bind/return`，且选中的最新失败 outcome 必须 `settled + providerDispatch:not_attempted`。该证据来自原 canonical dispatch guard；普通 Provider 失败、unknown、停止 ACK、物理退出或 owner 死亡均不提供安全重发资格。动态 map/loop/branch/collect 等程序明确拒绝。成功 sibling 复用原不可变结果，选中失败 call 的旧控制帧不再当作已接受结果；依赖它的尚未开始消费者随后执行。这里没有实现一般动态依赖失效。
- 追加式 `previousAttemptId/retryCommandId` 链在 ownership/CAS 准入和恢复时校验，拒绝伪造前驱、丢失重发证据、同命令不同目标、陈旧版本和竞争准入。相同命令的当前/冷启动重交只读回状态。若已接受 retry 但尚无新 intent，显式 resume 可以继续这个已批准的 attempt，不会另建 retry；普通 resume 仍不把原失败变成重试。
- 验证：Node/web 类型检查通过；19 文件串行组合 **264/264**；新 retry focused **14/14**，覆盖成功复用、追加链、六次上限、unknown/未收敛/无证据拒绝、晚到物理收敛不变成重发许可、竞争/重复命令及待准入 retry 继续。跨进程场景通过：初次 pre-Provider 拒绝 → 新 attempt 完成后控制器 exit73 → 新进程继续，实际本地 CLI ledger 只有 first/second 各一次，预算为 3，复用准确新结果引用。所有原 deadlines 保持不变。
- 有效负控：临时禁用 pending-retry 选择后，同一关键用例立即失败（缺失正确控制帧），而不是复用旧失败后假绿。补晚到收敛测试时出现的首次 TS2322 是测试 spy 被推断成仅允许 completed；已改为生产 `WorkflowProviderExecutor` 类型，原失败日志保留，没有削弱断言。
- 构建及完整 `test:conversation:ipc` 通过；实际隔离 Electron main/preload 确认新 retry 方法存在，缺失历史得到准确拒绝、不造记录、不进入 Provider。现有完整场景 21 次调用均为离线 fixture；新 retry 正向证据来自真实 Service/Runner 与跨进程本地 CLI，不冒充真实 Provider 或完整 App 正向重试验收。`test:workflow:ui` 通过，但未新增重试管理按钮。
- 性能路径已登记；`performance:measure -- --scenario providers.catalog` 仍 exit1：`No counter collector matches providers.catalog`。最终组合与生产计时均标 `highLoad:false`，但没有可比较的性能结论；不声称性能通过或提速。历史超时、完整发布/CLI 门禁仍按下文保留，本轮没有关闭它们。
- 下一步由主实施会话继续：设计同根修订 lineage/storage 和动态目标依赖失效，随后实现可信 check/classifier、质量流程与管理/恢复 UI；真实 Provider/Jev、费用或业务写入仍到授权边界再询问。这个增量不是 M3 或 M1–M6 完成。

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
