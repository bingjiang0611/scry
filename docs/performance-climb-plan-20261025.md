# 2026-10-25 性能爬坡执行计划

## 授权与目标

用户已批准按三套方案的推荐次序制定计划并开始优化：证据/查询为主线，Provider 初始化争取早期收益，客户端先改增量数据流而非重写原生壳。

目标是删除不必要工作、降低必要工作的成本、隔离交互阻塞。三者分别记账；不能用缓存旧事实、移出计时窗口、减少采集或降低安全保障冒充性能收益。

2026-10-26补充授权：UI维护完成后，用户明确允许目录fsync批次实验，公开返回点和双权威耐久性不得减弱；仍未授权格式迁移、合入原开发分支、推送或安装。

本轮使用独立 worktree，冻结起点 `d822f840`，不混入原工作区的 CLI WIP。默认仅本地提交；不合入、不 push、不安装。存储格式迁移、日常采集变更、额外驻留资源预算、真实付费 Provider 与原生客户端迁移仍单独确认。

## 当前证据

日常观测 App 0.2.223，build `2d6b6d7e0d9dba6cce72d3fbc23f842c1a99e726ff793e3be6578eddbfe5a56a`；2026-10-24T11:45Z—2026-10-25T09:39Z，62,153条、1个App会话。完整源码到此build的manifest映射 unknown，不用它证明某个提交回归。

| 机会 | 观测或代码依据 | 首个验收重点 |
|---|---|---|
| Pi 目录 | probe p50/p95 2.03/3.86s；首响应约1.99/3.82s；已有会话池与probe并发合并 | 目录生命周期和真实刷新，不重做进程池/close优化 |
| 证据处理 | trace queue p95 473ms；出队后处理p50/p95 49/103ms | 内容/FS/sync真实工作量；Provider结束到durable完整时钟 |
| 终态diff | 一个13样本分组p95 6.98s，其中diff阶段6.68s | dirty/workload、fallback与共享快照；不提前提交 |
| 统计 | stats p50/p95 0.99/2.11s；主进程同步聚合 | 先取消无人消费的请求，再测查询/物化/worker |
| 历史/远程/UI | warm归档仍检查全目录metadata；delta revision仍hash全部事件；turn壳未真正窗口化 | O(page/visible/changed)，同时保留外部修改、重连、选择和可访问性 |

这些是机会线索，不是受控基线。已有计数/实验见[性能闭环](performance-loop.md)、[机会日志](performance-opportunities.md)和[证据引擎](performance-experiments/20261022-evidence-engine.md)。

## 先复用既有成果：不重复已否证的实验

调查到历史分支 `perf/kernel-first-experiments-scry-performance-kernel-ryYbvT`：

- `2f338041` 等记录了Pi native ESM刷新边界。`new_session`或loader局部失效不能证明完整extension/config/auth重载；本轮不继续保留settled目录缓存。后续由Provider维护者先给出完整刷新合同，再决定常驻实现。现在保留fresh probe。
- `436d63d` 已冻结 `analytics.data-updated-unused` 测量，`9471221` 曾删除无人消费的全局stats/billing刷新。当前起点尚未包含对应代码。**本轮迁移既有测量和优化并重新验证，不把旧L1/L2冒充当前结果。** 历史固定负载是240个结果/工具、5次dataUpdated，不能缩小。

## 分阶段执行

| 阶段 | 范围、所有者 | 完成条件 | 状态 |
|---|---|---|---|
| 0 身份与计划 | agent：隔离cwd、依赖、源码与结果目录，核对既有实验 | 无他人WIP混入，测量与生产分别提交 | 已完成；计划`7787c78a`，测量`cd40ee06`，结构`138b4217`/`3afb730f` |
| 1 删除无消费者计算 | agent：迁移上述统计刷新collector和最小生产变更 | 旧实现负对照；5轮L1；受锁L2；可见analytics刷新仍有效；UI/全量unit/type/build检查 | L1/L2已补证；组合unit/type/build/IPC通过；2026-10-26完整UI门禁已一次通过 |
| 2 证据写入窄切片 | agent：测量content突发、重复body、双authority写入、directory/file sync | 不改格式；目录批次需授权；各文件及公开返回点耐久性不减 | `34a6371f`、`16941f1f`之后，授权实验`129f1bf3`合并单事件双权威的目录准备；L1及两种次序受控L2成立，未跨事件缓冲 |
| 2a 测量口径维护 | 用户已批准替换两项错误candidate；agent修正复测 | API尝试次数/返回payload字节；旧定义保留；其他75项不动 | 已完成；旧实现6个负对照失败，新回归通过，mac2全量4031通过/4原有skip；不是产品提速 |
| 3 查询与归档索引 | agent：固定40/400/4000轮与大账本；外部修改/删除/repair验证 | 先移除重复查询，再决定增量projection和专用执行进程；derived可重建、canonical不变 | 已测40/400/4000轮：正文已并行且限40；全成员指纹校验随N增长。无生产改动，见本轮诊断 |
| 4 Provider运行层 | agent + 上游维护者：完整刷新合同与隔离reload夹具 | 配置/模型/auth/extension/executable变化正确失效；再验证热目录收益、冷启动与驻留成本 | 原刷新边界阻塞，禁止重复旧假设 |
| 5 客户端增量 | agent：在写入点产生event revision，真正窗口化投影 | 固定大负载O(变化/可见)，重连、tombstone、选择、读屏、anchor不回归 | 首个窄切片`67952e75`：远程delta复用变更前缀；数组复制仍O(N)。独立夹具维护`b9ff9cc2`已关闭旧55s大场景阻塞；新集成UI首次失败另记 |
| 5a 独立集成 | 独立验证后，用户批准仅合入开发分支，不安装/推送 | 区分基线失败与集成回归，完整验收后再提交合并 | 独立merge `bda0c854`，4089 unit通过/4原有skip，完整UI链与性能门禁通过；开发分支已快进到`586bbaeb` |
| 6 交付与L3 | agent准备产物；用户批准合入/安装并正常使用 | build→源码映射明确；每侧同场景≥30样本、≥2会话 | 已按授权合入开发分支；未安装、未推送，无L3 |

原生桌面、blob pack格式迁移和常驻预热资源增加不在本轮自动实施范围。不是因为不够激进，而是先证明能解决当前瓶颈，再承担不可逆迁移成本。

## 本机首轮结果（2026-10-25，历史记录）

详见[实验与验证记录](performance-experiments/20261025-unused-analytics-climb.md)。固定5次dataUpdated：stats 5→0、billing 5→0、SQL 130→0，重复5/5一致；native回归保留已打开分析的刷新。工作是真的不再执行，没有后台补算。

用户选择严格遵守完整文件20KB门禁，因此先按职责拆分台账与integration hook。最初扩大到大组件的拆分未通过检查，已撤回；保留既有props/API后无需修改大组件。没有放宽门禁、删测试或缩小固定负载。

结构与优化分别提交。类型、构建、focused60用例通过；UI检查中断后续完剩余7段，含当前production App的临时Git和真实IPC。全量unit组合执行仍未完成，存在冻结起点的2项CLI失败及Git基准阶段阻塞；分段验证不冒充全量成功。

L2前后两侧均highLoad=true，本轮按持续高负载收尾，不开展第二实验。下一步由agent在负载合适时先完成L2与全量unit；再进入证据写入窄切片。未合入、未push、未安装，用户运行实例不变。

## mac2续跑结果（2026-10-25）

用户已授权mac2。详见[续跑记录](performance-experiments/20261025-mac2-climb.md)和[原始样本](performance-experiments/20261025-mac2-climb-evidence.json)。

- 统计固定5次后台刷新：低负载中位15.972→0.002998ms，SQL130→0。只证明受控后台工作，不外推整App延迟。
- 新增内容复用窄切片：完整字节比较替代第二次SHA-256；固定32次复用，hash64→32、读8MiB不变、sync32不变、写0不变。单组中位43.743→35.149ms，但波动较大，不承诺稳定百分比。
- 修复本轮skill镜像漏同步。原有CLI两项失败用已提交的`5bb630e1`作为独立验证依赖，不改原工作区WIP。最终组合树`f8051074`：3968 unit通过、4既有探针跳过；类型、App/CLI构建、生产IPC与编译Core检查通过。
- 完整UI仍在mac2的55秒综合夹具期限失败；原始基线同样失败，诊断显示53.6秒才开始等待断线。其余26段已验证，没有扩大期限。该夹具由agent另列维护任务，发布前收敛。
- 性能门禁通过，52条观测、3项CPU指令candidate未测。4个历史`worse`已做`cd40ee06`同机对照，前后相同或处于既有4-byte tolerance内；不抬基线或升门禁。
- 约两小时预算内收尾。下一轮由agent测量冷写与双authority路径；不启动第三实验，不默认改格式、减sync或增加驻留资源。未合入原工作区、未push、未安装，L3仍未验证。

## 目录发布续跑（2026-10-25）

详见[实验记录](performance-experiments/20261025-directory-publication.md)、[计数/样本](performance-experiments/20261025-directory-publication-evidence.json)和[阶段诊断](performance-experiments/20261025-directory-publication-profile.json)。

- 冻结旧实现后，在共享`mkdirDurable`先检查目录，取消注定失败的mkdir。单份/双份目录API80→52、167→109；sync56/116及其顺序不变。
- 有明确取舍：stat36→44、75→92，作为2项有意增加的candidate `worse`保留，不抬基线；不能用总量下降把它们抹掉。另4项历史偏差已重做本轮基线同机对照。
- 低负载单组中位154.854→141.336ms、292.670→289.947ms，样本重叠，不宣称稳定提速。额外诊断显示当前编译Core的sync等待占66%–81%，不含App投影，也不是CPU占比。
- 生产`16941f1f`；组合验证快照`dd5abea1`含已有CLI修复：3985 unit通过、4既有探针跳过；类型、App/CLI构建、真实生产IPC、编译Core无native-addon检查通过。
- 新用例证明旧实现仍有多余mkdir，故意删除父目录sync也会失败。没有减少sync、改格式、删断言或抬超时。
- 本轮没有UI源变更，不重跑已知总期限不足的完整UI大夹具；发布前仍需单独收敛该问题。未合入原工作区、未push/安装，L3未验证。
- 下一轮由agent转向查询/归档索引的固定规模测量。不继续在当前持久化约束下微调目录；批量sync和格式迁移要另行确认。

## 查询与远程投影续跑（2026-10-25）

详见[本轮实验与失败记录](performance-experiments/20261025-query-and-remote-projection.md)、[分页原始样本](performance-experiments/20261025-archive-scaling.json)和[投影原始证据](performance-experiments/20261025-remote-projection-evidence.json)。

- 归档warm页40轮，在40/400/4000轮历史下中位9.175/10.938/38.393ms；正文稳态始终40文件，全成员lstat为N+80。没有删新鲜度校验。最初误判已并行正文为串行，纠正后撤回未完成的归档拆分，没有把它提交或当作收益。
- 远程合并复用已有`recordTraceItemsChange`，20次文本尾部更新的投影前缀读取100020→0；合并数组读取100000不变。没有新增缓存、改协议或轮询。冻结测量`2866eed1`，生产`67952e75`。
- 低负载普通数组merge+project中位0.366→0.160ms/20次，candidate有1.828ms离群值。不宣称稳定比例或用户体感改善；这不是Chromium paint。
- 组合`0f4fadc1`含已有CLI修复：3990 unit通过、4原有opt-in跳过；类型、构建、43 focused通过。完整UI第19段仍触发旧综合夹具55秒截止；前19段与后续7段通过，完整UI不能标绿。
- 全台账门禁通过；6项candidate worse逐项保留/解释，同机对照重验历史差异。仅收紧本指标，没有顺带收紧无关项。当前App构建与测试来源已记录，未合入、push、安装或进行L3。
- 下一步建议先将既有完整UI夹具维护作为独立任务；若继续持久化大收益，则需要确认是否允许批量发布改变目录同步粒度，并先证明返回前durability不减。不要为了继续爬坡而无限寻找亚毫秒收益。

## 完整UI验收维护（2026-10-26）

该阶段用户只选择独立修复UI夹具，当时未授权改变同步粒度；后续补充授权见下一节。详见[维护与首轮失败记录](performance-experiments/20261026-ui-acceptance.md)及[证据](performance-experiments/20261026-ui-acceptance-evidence.json)。

- `b9ff9cc2`只改测试：巨型脚本按真实职责拆成模块，默认活动/工作区/运行/主机四个隔离场景。每场景55秒、条件7秒、visibility baseline75秒均不变，完整套件可合计更久。
- 原191个检查与255个等待保留，增加1个前置等待；地址编辑的“不启动Provider”改比本场景初始提交数。已归档轮次和第三个项目成为显式前置数据，相关生命周期与授权行为仍原生验证。
- 完整`test:renderer:ui`一次exit0。12个bundle内变异触发实际保护；两个陈旧slash变异目标已修复，不把“target not found”算敏感性通过。
- 组合`976331dc`含独立CLI修复：344个unit文件4008通过、4既有跳过；采用文件串行，保留首次默认并发的高负载超时记录。类型、本机focused28和构建/真实IPC通过。
- 当前默认完整UI阻塞已关闭，但高负载下其它既有fixture/unit仍有波动。本轮不作耗时改善声明，不改全局CI并发/超时、不改产品逻辑。
- 未合入原开发分支、未push、未安装、无L3。下一步由用户选择是否进入交付集成；若继续持久化协议实验，仍须单独允许批量目录同步并验证返回前durability。

## 单事件双权威目录批次（2026-10-26）

用户随后明确选择继续批量同步实验。详见[协议与完整验证](performance-experiments/20261026-content-copies.md)、[原始测量](performance-experiments/20261026-content-copies-measurements.json)及[验收证据](performance-experiments/20261026-content-copies-evidence.json)。

- 实时队列实际逐条持久化，故只批同一正文的App/workspace两份副本，不假装存在4事件实时批量。所有祖先目录先durable，才允许任一正文最终link；文件数据、发布、清理barrier均保留。格式不变，无跨调用缓存。
- 固定4×256KiB双根：sync/open116→88，stat92→68，摘要12→8；读/写/link/rm各8不变。夹具共同祖先较深，不把减少28次套到任意真实目录。
- 三轮计时完整保留：首次highLoad无效；两次低负载采用相反顺序，双根中位284.6→215.2、234.1→167.6ms。单根控制存在漂移，不宣传稳定比例或App/L3提速。
- 测量`1fae1e62`、生产`129f1bf3`分离。组合`1dd69260`含原CLI修复，unit4023通过/4既有跳过；类型、CLI构建、当前App生产IPC通过。两处SIGKILL恢复及错误注入通过，不当成断电模拟。
- 只收紧5个本轮candidate；全量门禁通过但仍有5个worse、3个CPU missing。追查相邻+6字节后发现两项旧files计数器口径有误，不能继续当成真实次数/字节；新publication计数器不受影响。
- 下一步应优先修测量口径并决定旧candidate替换，不继续基于错误数字优化。未动原开发工作区，无push/安装/L3。

## 文件读取口径修正（2026-10-26）

详见[维护记录](performance-experiments/20261026-read-meter.md)和[批准/原始证据](performance-experiments/20261026-read-meter-evidence.json)。

- 用户明确选择“修复并替换”：退役两项错误files candidate，新建`io.read.api.calls`与`io.read.payload.bytes`，旧定义及历史保留。其他75项逐项不变，无门禁放宽。
- 修复Promise双计、同步读把文件名当内容字节；实际返回内容及partial/EOF独立回归通过，旧实现6个直接反例失败。固定业务负载与断言逐字未改。
- mac2初始5轮调用次数均214；返回payload基线1397923字节，样本跨度55字节。该量不是物理磁盘读量；仍为零容差candidate，未归一化或升门禁。
- focused36通过，类型通过；完整验证组合4031通过/4原有skip。全量门禁通过，仍有3个历史candidate worse及3项CPU missing；不把计数更正冒充优化。
- 本轮仅测量与台账代码，不重建或安装App。下一步由用户选择基于当前已提交开发HEAD进行独立集成，还是等并行CLI/recorder WIP落定；不覆盖用户未提交改动。

## 独立集成检查（2026-10-26）

[首轮失败记录](performance-experiments/20261026-integration-check.md)保留不变。通知重试实现提交后，按既有授权继续[第二轮集成](performance-experiments/20261026-integration-r2.md)：只取开发已提交源码，没有复制WIP。

- 验证输入为开发`e1b120cc`+性能`9d2d04c0`+诊断`39b1488c`，两机测试tree `8d0a951b`。后续开发纯文档`c7388c38`一并纳入，生产/测试/配置逐路径不变；独立merge `bda0c854`。
- 4089 unit通过、4原有skip、0失败；完整原UI命令链、类型、CLI构建及性能门禁均通过。74项观测、3个历史candidate worse和3个CPU缺失仍如实记录，没有调基线。
- UI旧两项偶发失败根因仍未知。只增加失败时焦点/命中证据，不改断言或超时；本轮通过不等于该问题已修复。
- 本机旧tmp目录已不存在，恢复到`~/.local/state/scry-performance-resume-20261026.3YkqtM/`；Git与mac2旧记录仍保留。用户后续批准“仅合入开发分支”，已从`c7388c38`快进到`586bbaeb`，完整tree与独立分支相同；未push、未安装。

## 单实验流程

1. 冻结 workload、源码/依赖身份与计时边界。测量代码、collector、workload变更单独提交。
2. 在旧实现上跑测量和敏感性检查；新检查应能识别真实重复工作。失败保留，不靠重试、sleep、超时放宽变绿。
3. 单假设最小实现。减少的工作必须说明去向：不再执行、合并、缓存命中或仅移出关键路径。
4. L1：对应collector至少5次；`npm run performance:measure -- --scenario <场景>`，必要时`--compare <测量提交>`。
5. L2：所有毫秒测量经 `node .agents/skills/scry-performance-climb/scripts/timing-run.mjs <标签> -- <命令>`。固定同负载，保留冷/热与首次操作；highLoad=true时毫秒结论不可信。
6. 验证：受影响测试、`npm run typecheck`、本项目普通代码检查；生产变更提交前全量`npm run test:unit`。UI变更加`npm run test:renderer:ui`及隔离当前App交互；不可用明确记录。
7. 台账只收紧：`npm run performance:propose -- <观测文件> --write`；跑ratchet tests与 `performance-ratchet.mjs guard`。candidate不擅自升门禁，不放宽上限。
8. 每个实验单独记录优化commit、验证范围、首轮失败、合入/构建/安装状态与baseline/candidate build。L1不冒充L2，旧L2不冒充本轮L2。

## 收尾与继续条件

每个假设最多3轮实现尝试；本轮最多3实验或约2小时。持续高负载时交付L1并明确L2未验证；不通过反复测速挑样本。遇到外部结果unknown、需要新费用/权限/格式决策时停下对应分支，不重放外部写入。

每轮更新此计划和原实验记录。未完成阶段由agent负责下一次继续，阻塞项写明依赖与解除动作。用户当前授权覆盖计划内的本地爬坡，不必逐个小修复再确认；仍保留上述明确的外部动作与迁移审批。
