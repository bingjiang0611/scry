# 性能机会日志

由 `.agents/skills/scry-performance-climb` 维护。记录当前机会排名、大胆想法和覆盖缺口；实验（含失败）各自一个文件放在 `performance-experiments/`。数据结论必须注明来源与成熟度。排名超过 14 天或跨过一次发布需重新分析。

## 最新爬坡进展（2026-10-17）

用户选择方案一（常驻执行服务）与方案二（增量证据引擎）；已完成三个有独立计数与受控毫秒证据的前置优化，不代表两套架构已经交付。

| 实验 | 固定负载 L1 | L2 / L3 | 减少的工作 |
|---|---|---|---|
| [Pi Node 版本复用](performance-experiments/20261016-pi-node-version-reuse.md) | 五次环境解析的版本探针 5→1，五轮一致 | mac2 L2：中位批耗时557.70→400.39ms，减少28.2%；L3未验证 | 四个子进程不再启动；仍重验二进制元数据/环境，不缓存能力或trust |
| [遥测追加保留用量聚合](performance-experiments/20261016-usage-telemetry-incremental.md) | 10000行暖账本+五次遥测追加/查询，重读 5→0 / 4757290→0 bytes，五轮一致 | mac2 L2：中位批耗时26.26→1.43ms，减少94.6%；L3未验证 | 不再重读/parse整文件；性能记录仍完整保留 |
| [Pi只读probe关闭](performance-experiments/20261017-pi-probe-close.md) | EOF后有空闲handle：关闭grace到期1→0；4响应、1进程保持，五轮一致 | mac2 L2：总耗时1630.84→870.19ms；关闭761.07→2.26ms；L3未验证 | 成功只读探测立即TERM并仍确认退出，不把关闭移到返回后 |

前两个实验冻结collector `cafc418`、生产 `7ac7fcb`；第三个冻结测量 `1456e35`、生产 `afd8f03`。第三轮全量33个obs：1 better、30 unchanged、2 gating pass、3 macOS CPU指令candidate缺失，无worse。只收紧candidate平台基线，没有升级门禁或放宽。

**日志顺序缺陷后续已修复**：[同毫秒归档排序实验](performance-experiments/20261016-journal-order.md)。保留原专项22通过/1失败和基线负对照；新归档使用可跨重启恢复的单调排序时钟，不改文件格式或recordedAt。新增冻结时钟/重启/回拨回归在旧实现确定性失败，修复后全量3261通过/4 opt-in跳过；无法恢复已有同毫秒旧归档的歧义顺序。

**L2已在mac2补证**：[原始样本与方法](performance-experiments/20261017-mac2-runtime-evidence.md)。Apple M1/8核，Node24.18.0，同机同lockfile/collector、各5个fixture、串行锁内测量；负载7.95→7.12，highLoad=false，但接近8核阈值，不能称完全空闲。仅证明上述两个固定生产路径变快，不是整个App或12秒目录查询的收益证明。原本机10核负载10.36→9.39的highLoad=true结果保留，不用mac2结果冒充本机低负载结果；尚未安装或收集L3。

**第三轮RPC分段结果**：离线夹具确认了一项750ms EOF等待，mac2负载2.24→2.13、highLoad=false；启动到首响应约0.87s未变，不能声称真实12秒目录延迟已解决。mac2全量3263通过/4 opt-in跳过；首轮空HEAD与metadata fixture超时的修正、以及本机worker RPC通信超时未定位的限制均记录在实验中，不用后续通过抹去失败。

**后续优先顺序**：已达到本次会话3个优化实验上限，下一轮由agent先给真实turn+session finalization增加端到端计数和大仓库负载，验证共享after-tree。已有同名source-control collector未覆盖真实Service.diff的两次revision检查，新增场景不能静默替换旧workload。真实Provider启动/扩展/模型目录成本另验，不把离线结果当真实12秒根因。保持trust、证据收敛与崩溃恢复合同；原生客户端不在本轮范围。

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
| 热点无工作量计数：listCommands、runControls、desktopRemote catalog、真实规模 git | 爬坡只能看噪声大的毫秒 | 先加 collector 和大仓库负载 |
| 数据几乎全为 Pi | Claude 主路径无真实数据 | 用 Claude 时同样快照分析 |
| UI 发送/停止计数随时序波动 | 不能作门禁 | 需要更确定的触发点（例如固定批次的受控流） |
| Linux 基线、CPU 指令数 | CI 被账单阻塞，未在 Linux 实测 | CI 恢复后补 |

## 实验记录

每个实验一个文件，见 [performance-experiments/](performance-experiments/)。
