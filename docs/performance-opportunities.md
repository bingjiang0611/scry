# 性能机会日志

## 本地可见需求与同进程锁争用（2026-10-30，L1 / 受控 L2）

用户确认完整方案后，本地 Legacy/Unified/Side Chat 实时 Diff 按消费者需求采集；隐藏正文但可见 Overview/Diff/Agents 时仍保持鲜活。返回视图在真实隔离 App 内验证 2 秒内显示新证据，原动画和两份 CSS 字节不变。无需求控制的旧 artifact、窄 Files、最大化 Overview 均有失败对照与最终源码验收。远程没有可见性协议，保守维持采集，不假装全面远程停采。

同绝对锁路径进程内 FIFO 保留每次真实文件系统锁与全部同步屏障。受控同工作区 N5 commit 尾部均值 243.65→165.28 ms、锁尝试 26.33→5、owner 读取 31.33→10；持有时间也变化，不把全部毫秒收益归给队列。810 次内容读取中 205 次成功路径无重复，不凭猜测增加缓存。

冻结 Native N1/3/5 共12个低负载案例：N5 Git 213.5→135，但总完成 27.30→27.53 秒、内存不改善，不能称整体更快。归档解压后重验36 records、720完整文件、14400有序delta、2880工具双 authority blob、2160完整patch引用。最终236/CLI55单测5118通过，完整UI原脚本重放、ratchet及开发包通过；原始焦点瞬态失败未归因，保留而不称修复。用户选择只保留ZIP，本轮未安装、未重启、未push；磁盘目标检查期间由227变为235，未将其当作本轮安装或日常loaded版本。完整范围、失败与原始证据见[实验/交付](performance-experiments/20261030-live-diff-demand-lock-queue.md)；无真实Provider或日常L3结论。

## 并发 preview 与目录批处理（2026-10-30，L1/L2 受控验证）

保留 0.2.234 credits/圆角改动后，首轮兼容 preview 只共享在途读取；同一 diff snapshot 的 patch 只合并公共祖先目录准备，每个文件及链接仍完整同步。N=1/3/5 Git 100→70、252→162、411→254；main sync attempts 下降 14.5%。离线 Native 两次/格完成均值 22.98→22.76、26.12→25.64、30.33→26.93 秒；高负载 N=5 整组保留并另做完整对照，不混入 L2。

54 records、1080 文件及完整工具输出、21600 有序 delta、4320 份工具双 authority blob、3240 patch 引用全部核验。GPU CPU 上升、RSS 不全面改善，不能称整体 CPU/内存优化；扫光三种候选无收益，未采用、不降帧。不是隐藏 run 全面停采、跨轮读缓存或全局写调度完成。已安装 App 0.2.235 / CLI 0.2.54（日常实例未代为重启）；源码、完整门禁、原失败与剩余边界见[本轮记录](performance-experiments/20261030-preview-and-content-batch.md)。L3 未执行，不改 ledger 或门禁上限。

## Managed Claude 工具 Hook（2026-10-29，L2 已验证）

每会话仍有 42 个 shell，但重复工具 Hook 不再启动 CLI；CLI 42→2。最新 Side Chat 基线的 N=1/3/5 ABBA 保守 Hook CPU 降幅为 78.39% / 79.44% / 81.87%。完整工具/文件/文本证据、恢复边界与视觉实现保留。Renderer CPU 上升约 22%–58%，Git 增量已定位为更多真实快照，不能据此宣称 App 整体更快或内存改善；不改动画/节流来美化数字。

已集成并安装 0.2.232，私有 CLI 0.2.53；日常实例未由本任务重启。两组独立实验、失败与负向控制、source/build 映射，见 [实验收口](performance-experiments/20261029-managed-hook-skip.md)。L3 未验证；下一步由用户正常使用新 build 收集同场景至少 30 样本、至少 2 会话，再做只读对比。未改门禁上限、未升 candidate、未调用真实 Provider。

由 `.agents/skills/scry-performance-climb` 维护。记录当前机会排名、大胆想法和覆盖缺口；实验（含失败）各自一个文件放在 `performance-experiments/`。数据结论必须注明来源与成熟度。排名超过 14 天或跨过一次发布需重新分析。

## 静态交接批次 A（2026-10-22/23，仅 perf/handoff，待核验）

- A1：启动身份采集从同步全表 ps 改为有超时的异步单 PID；受控 6 个启动样本由每次 720–725 行降为 1 行，ps 次数不变。身份未知仍 fail closed，Claude/Qoder stop/abort 有生产路径回归。
- A2：recent/project 元数据键缓存及单例；一轮受控流程 read 6→2，同时间戳 exact no-op 的 write/fsync 14/28→8/16，不同时间戳仍为 14/28。不改变持久性，不以计数冒充耗时。
- A3：隐藏 60 秒的 list/catalog/status/intents 为 20/20/30/40→0/0/0/0；显示时先撤回旧在线/活动确认，旧请求结束后刷新，错误与历史保留。
- 三项均只有 L1 证据，不宣称 L2/L3。未安装或合入 main。实验与完整验证见 [批次报告](handoff/perf-2026-10-22/reports/A.md)；批次 B 等 A 核验后再执行。

## 批次 C：工作区 numstat 只读化（2026-10-22，分支待核验）

- `agent:gitDiff` 不再复用 recorder before-tree；固定9/5001 tracked、5 dirty负载，Git仍8次，新写对象4→0。源码 `0dcd7fe`，测量 `26cca06` / `c2802e1`；进行中请求合并、刷新保留旧证据并标来源，不缓存已完成结果。
- L2固定API各6样本：p50 **277.29→224.18ms / 289.90→218.83ms**；8核load6.81→6.63、highLoad=false但非空闲机。不是日常L3；完整哈希次数unavailable，不把0对象写入说成0哈希。
- 最终unit **3711 pass / 4 opt-in skipped**，typecheck/CLI build、真实source-control App/UI、workspace刷新fixture与安全冒烟通过。完整renderer UI仍被基线`bf92d04`同样复现的workspace dirty标记超时阻断，其余11组原命令逐组通过。特殊index、属性/规范化、子模块等不等价范围明确unavailable；不改recorder或台账。
- 见[实验与全部样本](performance-experiments/20261022-workspace-numstat-readonly.md)、[批次C报告](handoff/perf-2026-10-22/reports/C.md)。未合入、未安装、不要求用户重启；审查方核验后决定合入。

## 批次 D transcript 观察者（2026-10-23，分支待核验、未安装）

- `perf/d-renderer-transcript` / `3256e68`：1000 轮、30 字原生输入的选择检查 30000→120；IO 1000→1，只有 4 轮正文保留 disclosure 观察。局部选择分发有 L2 证据，不宣称整体输入/流输出更快。
- App body 已实测，当前不拆 App；全量 unit 与 43 项计数通过，完整 renderer UI 保留改动前同样失败的 workspace dirty 断言。未合入、未安装、无 L3。
- 方法、前后数字、失败与后续 owner 见 [同一实验记录](performance-experiments/20261023-renderer-transcript-observers.md) 和 [D 报告](handoff/perf-2026-10-22/reports/D.md)。

## A+B 当前交付（2026-10-22，已合入 main、开发签名版已安装）

- A 按需层与 Provider-specific 安全复用收口；不是全 Provider 统一常驻。OpenCode 五对低负载受控读取确认启动 3→1、三读合计中位 1939→932ms；首次冷读没有提速证据。Qoder 保留 live/初始化寿命与关闭所有权，Pi 继续 fresh，不能虚构原生 reset 合同。
- B 交付批量 Git patch、Pi 按身份先选页后读正文、归档基表＋单轮 delta、journal 大载荷只写一次。初版读路径退化及 metadata 误改远程源版本已修复，原失败/高负载记录保留。
- 原 A/B 冻结 `4d561dd`：mac2 **3528 pass / 4 opt-in skipped**；类型、App/CLI build、全套 renderer UI、shell、CLI tarball 冒烟和 43 项计数/ratchet 通过。3 个 CPU instruction candidate 仍 missing；4 个必要新工作的 worse 不抬基线，4 项收紧 proposal 仅生成、不应用。
- 生产 Electron IPC，4000 canonical＋4001 native 轮次、最新/旧页各40：同正文 SHA，暖两页合计中位 **958.1→154.6ms**；单独旧页 **0.8→39.0ms**，因为不再预读全部正文且重新核验来源。独立锁内负载均低于8核；这不是屏幕绘制/真实 Provider/L3结论。
- 最终代码 `b155baa` 已合入 main，保留期间并行 Pi 修复；**3699 pass / 4 opt-in skipped**，完整 UI、类型、App/CLI 构建、CLI tarball、安全冒烟与 43 项计数门禁通过。本机开发证书产物 **App 0.2.219 / 内置 CLI 0.2.51** 已原子安装，深度签名通过；未 push、未公证、未重启日常实例，L3 未测。
- 见[合入、签名安装、当前验证与原始失败](performance-experiments/20261022-main-integration.md)及[原 A/B 实现、每项 worse 与受控 L2](performance-experiments/20261022-evidence-engine.md)。下列旧条目保留各阶段当时的状态，不覆盖为新的部署事实。

## Qoder：初始化证据不再被重复读取续期（2026-10-22）

- Skill/命令来源时间固定为初始化完成，过期新读取正常排空旧实例、确认关闭后再初始化；模型仍live。未增加5秒空闲保留、30秒目录TTL或20秒初始化期限。
- 修正关闭失败失去所有权、获取/退休竞态、释放等待应取消请求、刷新期间失效漏关替换实例。冻结受检树`2c9e602`；父任务101项Qoder focused通过，移除最终屏障时微任务offset4确定失败。
- mac2完整unit **3510 pass / 4既有opt-in skipped**、类型/build、完整43项计数门禁通过。完整UI首轮workspace dirty标记失败，基线单跑和同候选完整复核通过；原失败保留、未分类，不改UI断言或期限。必要初始化成本不宣称为提速。见[本轮合同与原始失败](performance-experiments/20261022-qoder-initialization-lifetime.md)。未合入、push或安装；完整A/Pi刷新合同及可信L2仍未完成。

## Qoder：先修正模型来源，不盲目扩大实例寿命（2026-10-22）

- SDK1.0.17 的 initializationResult/supportedCommands 永久复用初始化快照；reloadPlugins 不构成模型/认证/启动配置的完整刷新合同。保持原5秒空闲回收和30秒catalog缓存，不宣称Qoder长期常驻完成。
- 修正已有模型刷新链路：cache MISS 始终获取原生 live 模型，保留effort/default，空列表不回退旧初始化值，失败不复用旧成功值；仅发现控制查询设置persistSession:false。源码 `5d11ab5`/调用点简化 `dddc43e`，回归 `36ee5f1`。
- 新测试对旧代码6项失败；本机87项Qoder focused与完整类型检查通过；mac2冻结`dddc43e`完整unit **3496 pass / 4既有opt-in skipped**、类型/build、完整43项计数ratchet通过。新增live请求是获得当前证据的必要工作，不宣称提速。见[合同、证据与剩余边界](performance-experiments/20261022-qoder-live-controls.md)。后续由性能owner先约束初始化证据寿命/失效，再评估更长保留；Pi维持新进程，未合入、push或安装。

## OpenCode：有界原生实例跨能力刷新周期复用（2026-10-22）

- 用户限制只修改 Scry，本轮不改 Pi/Rotom。OpenCode 空闲保留60秒与桌面60秒能力读取相撞，生产提交 `06591d9` 改为可续租90秒；请求/测试期限、30秒模型目录缓存、原有指纹重验和活跃操作保护不变，空闲实例仍按原策略淘汰。
- 相同三读、每读间隔60秒：生产 manager 回归与独立受控 Node HTTP 子进程都观察到启动3→1；后两次不再重复启动，指纹重验和真实SDK调用保留。不是所有 Provider 的常驻完成。
- mac2 `74520c8` 完整 unit **3493 pass / 4既有opt-in skipped**、类型/build、完整43项计数与ratchet通过。锁内五对耗时样本遇到8核load17.99→22.55、highLoad=true，L2不可信，不报告提速。性能owner后续在空闲窗口复验同一harness；Pi保留新进程，Qoder未扩大寿命。见[实验与边界](performance-experiments/20261022-opencode-control-lease.md)。未合入、push或安装。

## 方案 A：按需 Provider 发现（按需层收口；mac2 Node/UI/计数通过，Swift 测试待完整 Xcode）

- 在隔离分支实现 metadata/selected 协议及能力协商；定时元数据不再初始化全部 Provider，仅选中 Provider/Profile/canonical cwd 才读取能力。同上下文只合并在途查询，沿用 Provider 已有实例机制；未新增 Pi settled cache 或统一常驻池。
- 固定三个上下文的 **adapter 入口计数**：metadata 0、两个重叠 selected 请求 1、显式 legacy 全量 3，五轮一致。注入 metadata 全量探测后回归确定性失败。这不是 CLI 进程数或 L2/L3 提速结论。
- 第二轮源码 `a742d62`、测试/诊断 `1588832`：补齐主机观察时间、独立发布版本、已知配置失效栅栏；旧在途数据不发布/不回填缓存，可见、focus 与成功手动重读保留用户选择，失败不复用旧成功值。底层 SDK 缓存/重载仍逐 Provider 决定，不承诺外部配置即时全部生效，不视为完整常驻 A。
- 本机类型/build、iPhoneOS unsigned SDK 编译、完整 renderer UI、25 项失效 focused 已通过；本机完整 unit 的 Rename 超时和 Swift TLS leaked promise 首次记录保留。用户授权 mac2 复验冻结 `54e9dd1`：完整 unit **3491 pass / 4 既有 opt-in skipped**、完整 renderer UI、类型/build、Swift build、完整43项计数及 ratchet/propose/guard 均通过。未修改测试期限，未应用1字节的无关 candidate baseline 提议。mac2 Swift test 因无 XCTest/完整 Xcode 未进入执行，不把它当作 TLS 问题已解决。
- 测试 owner 下一步在完整 Xcode 环境运行原 Swift 全套并复核 TLS；性能 owner 补独立冷/热 L2。mac2 计数时 load3.09→3.45/8核、highLoad=false，但这不是毫秒收益证明。三个 CPU 指令 candidate 缺失仍为 missing，不记0。未合入、push、安装或真机重放。范围、各轮原始失败及交付身份见[本次记录](performance-experiments/20261021-provider-discovery.md)。此前 0.2.216 安装问题是另一冻结产物，不混为本次安装结果。

## 历史交付与实验

- [2026-10-20/21：CLI、通知、目录与 UI](performance-experiments/20261021-opportunities-history.md)
- [2026-10-17：爬坡与集成验收](performance-experiments/20261017-opportunities-history.md)

历史原文按段搬移以满足每个 staged 文件 20,000 bytes 的提交上限；下方初始排名与缺口保留。

## 原始机会排名（2026-10-16，日常记录首次分析）

来源：本机日常记录快照，两个 packaged build（0.2.192）：`d1464a62`（03:03–06:11 UTC，11181 条）与 `cafee00e`（06:11–08:11 UTC，14633 条）。成熟度：`single-session`，几乎全为 Pi，机器负载高且日志不记录负载。以下全部是**线索**，未经受控复现。

| 排名 | 机会 | 证据（p50 / p95，n） | 为什么重要 | 置信度 |
|---|---|---|---|---|
| 1 | **git 相关等待**：三个环节都在用户等待路径上 | `ipc.agent:gitDiff` 741–1041 / 3282–5020 ms（n=137、177）；turn 结束 `stage.diff_complete` 1617–3120 / 3424–12850 ms；发送前 `stage.git_baseline_ready` 615–722 / 1901–5324 ms | 每轮对话至少碰一次；受控基准中 git 子进程占操作耗时约 98%，每个约 30–50 ms；真实仓库比 1 文件固定负载大得多 | 中 |
| 2 | **Provider 命令/运行控制查询** | `ipc.agent:listCommands` 2255–2284 / 5540–7653 ms（n=41、60）；`ipc.agent:runControls` 2260–2310 / 7810–8098 ms（n=37、48） | 看起来是很少变化的信息，却每次要 2 秒以上；无工作量计数、无受控基准 | 中（耗时确定，原因未查） |
| 3 | **远程 catalog 调用频率** | `ipc.desktopRemote:catalog` 2 小时 1962 次（约 16 次/分钟），291 / 1107 ms | 单次不算慢，但总量最大（Σp50 约 571 s），会抢主进程 | 中（是否轮询未查） |
| 4 | Provider 进程启动 | `stage.provider_launch` 603–701 / 1760–3289 ms | 发送后用户等待的一部分；可预热 | 中 |
| 5 | 历史加载长尾 | `session_history.load` 归档阶段 184 / 1318 ms；`ipc.agent:loadSession` 202 / 807–861 ms | p95/p50 达 5–7 倍，长尾明显 | 低 |
| 6 | 主进程事件循环卡顿 | `eventLoopMaxMs` 一段窗口 p95 339–424 ms | 卡顿会拖慢所有 IPC | 低（与负载混杂） |

`agent.first_text` 总耗时 14–71 s 主要是模型耗时，不归 Scry 代码；其中 Scry 自己的阶段已在上表拆出。

## 大胆想法池（未实验）

- **git 常驻化**：用常驻 `git cat-file --batch` / `git status` 守护进程代替每次 fork；或 FSEvents 监听驱动的增量 git 状态，用户打开面板时直接取。
- **git 结果缓存**：按 HEAD、index mtime、工作区文件 mtime 失效；界面必须能区分“缓存命中且已验证”与“正在刷新”。
- **turn 结束 diff 移出关键路径**：先显示“完成”，diff 在后台收敛，证据面板标“diff 计算中”。需确认不破坏 recorder 两阶段提交（diff 证据收敛前不能提交 record）。
- **发送前 git 基线与 Provider 启动并行**。
- **Provider 预热池**：空闲时预启动一个 Provider 进程，发送时直接复用；需逐 Provider 确认会话/权限语义不被串用。
- **listCommands/runControls 缓存**：按 Provider 可执行文件指纹 + 配置文件指纹缓存；Profile/模型切换时失效。
- **远程 catalog 改推送**：变更时通知，取代定时拉取。
- **大 trace 流式传输**：MessagePort 分块，避免一次性 structured clone。
- **启动快照**：V8 snapshot / 延迟加载非首屏模块（启动路径目前未被日常记录观测到，先测量）。

## 覆盖缺口（尚未测量或无法测量）

| 缺口 | 影响 | 建议 |
|---|---|---|
| ~~日志只保留约 5 小时~~ | 已改为 gzip 归档 + 64 MiB 上限（估算约 340 小时使用），新版安装后生效 | 发布后确认归档实际增长 |
| 日志不记录系统负载 | 毫秒数无法区分“代码慢”和“机器忙” | 在 resource 样本中记录 `os.loadavg()` |
| IPC 工作量维度为 `unmeasured` | 无法按仓库大小、会话长度分层 | 给 gitDiff/loadSession/listCommands 记录规模维度 |
| 未观测路径：startup、compose、evidence、terminal（因 build 而异） | 启动速度、输入框响应完全无真实数据 | 补观测点 |
| listCommands、runControls、desktopRemote catalog 缺少完整调用链计数 | Git已补受控5000/5001文件基准，但日常规模分层仍缺；Provider热点仍易混入启动/扩展成本 | 先补端到端分段，不用已有离线probe替代真实调用链 |
| 数据几乎全为 Pi | Claude 主路径无真实数据 | 用 Claude 时同样快照分析 |
| UI 发送/停止计数随时序波动 | 不能作门禁 | 需要更确定的触发点（例如固定批次的受控流） |
| Linux 基线、CPU 指令数 | CI 被账单阻塞，未在 Linux 实测 | CI 恢复后补 |

## 实验记录

每个实验一个文件，见 [performance-experiments/](performance-experiments/)。
