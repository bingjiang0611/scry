# 性能机会日志

由 `.agents/skills/scry-performance-climb` 维护。记录当前机会排名、大胆想法和覆盖缺口；实验（含失败）各自一个文件放在 `performance-experiments/`。数据结论必须注明来源与成熟度。排名超过 14 天或跨过一次发布需重新分析。

## 最新爬坡进展（2026-10-17）

用户选择方案一（常驻执行服务）与方案二（增量证据引擎）；已完成五个有独立计数与受控毫秒证据的前置优化，不代表两套架构已经交付。

**当前交付状态（2026-10-17，源码已合入，未安装）**：

- 优化源码：`7ac7fcb`（前两项）、`afd8f03`、`aff6006`、`06a3f41`。通过 `89e4465` 合入 main，合入前 main 为 `a091c22`；原生会话 fork、远端会话改动均保留。
- 构建：验证产物 App **0.2.196**，完整 build ID `1d7585fc0e27063072cc5fc0975b074a3a192800dedb1d68cf4888da9710b2e1`。产物 SHA 与源码树对应证据在 `/tmp/scry-perf-integration.B1UmYE/identity.json`；这是测试构建，不是已安装实例。
- 安装/生效：本次未安装、未推送或发布。宿主实际版本/build ID、安装/首次生效时间、日常 baseline→candidate 映射仍为 `unknown`。L3 待验证；旧 build 热点不能据此判为优化回归或触发同一优化重做。
- 验证级别：下表 L2 保留原实验源码归属；集成版重验功能及 40 项工作量计数，没有重新测量 L2 毫秒，也没有日常 L3 结论。

### 集成验收与未通过项

代码复查保留 main 较完整的 legacy 日志迁移/排序实现；Pi 只统一异步 fs import，保留 native fork 的身份、配置指纹与回收行为。自动合并的 turn/session diff 仍先封口 preview、等待 idle，再保持 turn→session 发布和 archive 收敛顺序。最终完整测试、CLI、UI 与打包使用集成树 `2b520429bb13904a9ee869e546fd1c609b7abb58`；验证快照 `2d1abee` 与源码 merge 的树一致。重点测试先前快照与此树仅有 skill 镜像文档差异，源代码一致；40 项计数也对同一集成源码执行。

| 检查 | 结果 |
|---|---|
| 重点冲突/相邻路径 | 201 项通过，覆盖 Pi/fork、日志、用量、共享 diff 与 session baseline |
| `npm test` | 最终 3331 通过、4 既有 opt-in skipped；shell 通过 |
| 首轮完整测试 | 3330 通过、1 失败：skill 在 `.agents` / `.claude` 镜像漂移。同步三份文档后完整重跑通过；未改测试断言或超时 |
| `check:cli-release` | 类型检查、587 项相关测试、CLI build 与 package smoke 通过（CLI 0.2.49） |
| App build / `test:renderer:ui` | 隐藏真实 App 全套通过，包含 Credits、远端会话 parity、源代码管理、归属与统一对话重启/fork 路径；无真实账号/Provider 探针 |
| `performance:measure` | 40 obs；38 candidate unchanged、2 gating pass，另3个CPU指令 candidate missing；8/11旧门禁、17/1共享树、18/2/0双校验保持 |
| `pack:artifact` | 构建成功，但 `check:packaged-app` 在私有 CLI `--version` 收到 SIGKILL（PID 96233）；后续 packaged smoke 未执行，不算完整打包验收通过 |

`codesign --verify --deep --strict` 对同一产物通过。macOS 对 PID 96233 记录 `Unable to apply provenance sandbox`，但不能据此确定谁发送了 SIGKILL。没有重试碰运气、换路径、改签名、关闭安全软件或放宽边界。用户在得知该结果后明确选择**仅合入源码**；发布/安装安全门禁未获豁免。首轮失败、最终测试、签名与打包日志留在 `/tmp/scry-perf-integration.B1UmYE/`；测试 App 已由 fixture 结束，诊断产物暂留供排查。

| 实验 | 固定负载 L1 | L2 / L3 | 减少的工作 |
|---|---|---|---|
| [Pi Node 版本复用](performance-experiments/20261016-pi-node-version-reuse.md) | 五次环境解析的版本探针 5→1，五轮一致 | mac2 L2：中位批耗时557.70→400.39ms，减少28.2%；L3未验证 | 四个子进程不再启动；仍重验二进制元数据/环境，不缓存能力或trust |
| [遥测追加保留用量聚合](performance-experiments/20261016-usage-telemetry-incremental.md) | 10000行暖账本+五次遥测追加/查询，重读 5→0 / 4757290→0 bytes，五轮一致 | mac2 L2：中位批耗时26.26→1.43ms，减少94.6%；L3未验证 | 不再重读/parse整文件；性能记录仍完整保留 |
| [Pi只读probe关闭](performance-experiments/20261017-pi-probe-close.md) | EOF后有空闲handle：关闭grace到期1→0；4响应、1进程保持，五轮一致 | mac2 L2：总耗时1630.84→870.19ms；关闭761.07→2.26ms；L3未验证 | 成功只读探测立即TERM并仍确认退出，不把关闭移到返回后 |
| [终态共享 after-tree](performance-experiments/20261017-terminal-shared-after.md) | 5000文件、不同脏基线：Git 24→17，写树2→1，五轮一致 | mac2 L2：整体777.59→540.32ms（30.5%）；首个turn结果约424ms不变；L3未验证 | 两个before锚点共用一个不可变终点；最后一个持有者负责清理，完整完成边界仍等待清理 |
| [真实 Service.diff 双校验](performance-experiments/20261017-service-diff-revision.md) | 5001 tracked、4 dirty、1 remote：Git24→18，原生status2→2，remote查询6→0 | mac2有效L2：507.64→382.85ms（24.6%）；首组高负载作废，全部样本留存；L3未验证 | 只不做两个校验不需要的本机remote展示查询；不缓存、不删除revision材料 |

前两个实验冻结collector `cafc418`、生产 `7ac7fcb`；第三个冻结测量 `1456e35`、生产 `afd8f03`。第三轮全量33个obs：1 better、30 unchanged、2 gating pass、3 macOS CPU指令candidate缺失，无worse。只收紧candidate平台基线，没有升级门禁或放宽。

**日志顺序缺陷后续已修复**：[同毫秒归档排序实验](performance-experiments/20261016-journal-order.md)。保留原专项22通过/1失败和基线负对照；新归档使用可跨重启恢复的单调排序时钟，不改文件格式或recordedAt。新增冻结时钟/重启/回拨回归在旧实现确定性失败，修复后全量3261通过/4 opt-in跳过；无法恢复已有同毫秒旧归档的歧义顺序。

**L2已在mac2补证**：[原始样本与方法](performance-experiments/20261017-mac2-runtime-evidence.md)。Apple M1/8核，Node24.18.0，同机同lockfile/collector、各5个fixture、串行锁内测量；负载7.95→7.12，highLoad=false，但接近8核阈值，不能称完全空闲。仅证明上述两个固定生产路径变快，不是整个App或12秒目录查询的收益证明。原本机10核负载10.36→9.39的highLoad=true结果保留，不用mac2结果冒充本机低负载结果；尚未安装或收集L3。

**第三轮RPC分段结果**：离线夹具确认了一项750ms EOF等待，mac2负载2.24→2.13、highLoad=false；启动到首响应约0.87s未变，不能声称真实12秒目录延迟已解决。mac2全量3263通过/4 opt-in跳过；首轮空HEAD与metadata fixture超时的修正、以及本机worker RPC通信超时未定位的限制均记录在实验中，不用后续通过抹去失败。

**第四步共享终点已验证**：冻结测量 `7ad8957` / `67a8252`，生产 `aff6006`。首版因首个turn结果晚34ms被用户拒绝；引用持有版保留首次可用边界，清理仍在整体测量窗口与诊断耗时内。隐藏真实App离线UI/IPC流程独立核对7对归档快照（3对含文件改动），两次重启通过。本轮mac2全量首次3273断言通过但worker RPC超时，改为异步等待测量CLI（`8987f46`），保留原断言、负载和120秒上限；最终3274通过/4既有opt-in跳过。旧本机worker失败的完整归因仍不追认。36个obs在收紧前为3 better、31 unchanged、2 gating pass，另3个macOS CPU指令candidate缺失，无worse；只降低三个candidate平台基线。

**第五步真实 Service.diff 已验证**：冻结 `8514551`，生产 `06a3f41`；两个时间点的完整 revision 材料与公式不变，仅内部投影不取 remotes。普通面板、写入、PR/传输仍取完整 status。9 项新增验收、故意去掉 post-check 后 5 项确定性失败的负对照、mac2全量3284通过/4既有opt-in跳过、隐藏真实App源代码管理UI均通过，无外部GitHub写入。首组L2 `highLoad=true` 不作收益结论，观察到负载恢复后补得有效组（3.03→3.86 / 8核）；没有改 workload、timeout 或丢弃样本。40 obs：3 better、35 unchanged、2 gating pass，另3个CPU指令candidate缺失，无worse；只降三个candidate基线。旧11次同名负载与8次门禁不变。

**后续优先顺序**：建议先由用户确认合入/安装，再采同场景≥30样本、≥2会话的L3，判断真实优先级，不为继续降次数删除身份、filter或revision校验。若继续优化Provider启动/扩展/模型目录，agent先补真实listCommands/runControls的端到端分段；真实账号/费用授权不足时不运行，不把离线结果当12秒根因。当前已按用户授权合入源码，未安装或推送；安装前还需通过被 SIGKILL 阻断的打包运行验收。保持trust、证据收敛与崩溃恢复合同；原生客户端不在本轮范围。

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
