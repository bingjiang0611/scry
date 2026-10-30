# 性能机会日志历史：2026-10-17

从 [机会索引](../performance-opportunities.md) 原文搬移；仅调整相对链接，历史状态不代表当前安装状态。

## 最新爬坡进展（2026-10-17）

用户选择方案一（常驻执行服务）与方案二（增量证据引擎）；已完成五个有独立计数与受控毫秒证据的前置优化，不代表两套架构已经交付。

**0.2.197 当前交付状态（2026-10-17，已安装并核对实际运行）**：

- 冻结安装源码 `313f451`（base `2adcfdb`），包含五项优化。构建期间稍后提交的 `2405d92` **不在本安装包中**，不得称为最新 main 完整交付；main 中该改动保留。版本元数据通过 `ae84ff2` 集成，原始安装源码仍以 `313f451` 为准。
- App **0.2.197**、CLI **0.2.49**，完整 build ID `5ef349e1d00e156fdcbedff0e1705e039b0969a23f8c7a77da38418482d4bf44`。冻结包 typecheck、3331 unit（4既有 opt-in skipped）、shell、587 CLI release、packaged check 与全部 packaged smoke 通过。
- 首次新签名包 CLI 仍曾 SIGKILL（PID11281），原始 `pack.log` 保留。深度签名与同一原生二进制诊断通过后，同一未改动包通过剩余打包门禁；未改测试、安全策略或重签名来绕过。终止来源仍未知，不能因后续成功宣称根因修复。
- 用户已授权正常退出旧 App 并启动新版。前台退出两次都中断了作为 Scry 子进程的当前 Pi，且均未安装；最后交由独立 launchd 一次性任务正常退出 PID23211，再调用原样的 `scripts/install-macos.mjs`。安装器返回成功（自带目标 CLI/版本校验），目标 asar/可执行文件 SHA 与冻结产物一致，目标深度签名通过。**安装时间 2026-10-17T12:39:42.021Z**，目标 `/Applications/Scry.app`，旧版备份 `/Applications/.Scry.app.backup`。
- **实际生效证据**：新 PID **35636** 的真实 userData 由已打开的 `scry.db` 路径确认；真实 packaged 日志匹配版本/build，首条 **2026-10-17T12:39:42.982Z**。安装后快照经现有 gzip-aware `readRecords` 解析 82713 条、issues为空，其中新 build 659 条、1个会话；这些只是身份与运行记录，**不是659个完成场景，也不是L3改善结论**。一次性诊断器最初将 gzip 当 JSON 解析失败，改用现有 helper 后通过；这不是产品失败，未改日志或分析合同。
- 核对证据：`/tmp/scry-install-performance.ROQOkg/handoff-receipt.json`、`runtime-verification.json`、`install-identity.json`、`install.log`。保留初次失败/最终检查日志与诊断构建；安装任务正常完成、exit0、仅运行1次，已 `bootout` 自有服务 `gui/502/com.scry.install.performance.ROQOkg`，未留下活跃安装任务。未推送或正式发布；此为本机 Apple Development 签名安装，不冒充 Developer ID 公证发布。
- 本地日志快照：`/Users/baobingjiang/scry-performance-archive/20261017-{before,after}-0.2.197-ROQOkg`。安装前保留旧证据；当前热点必须显式选择新 build，旧 build 只作历史对照。日常 baseline 的场景/环境/source匹配与 L3 仍未验证；需要同场景两侧各 ≥30 样本、≥2 会话和数据健康证据后再比较。

**前次集成交付快照（0.2.196 验证包，仅作历史记录）**：

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
| [Pi Node 版本复用](../performance-experiments/20261016-pi-node-version-reuse.md) | 五次环境解析的版本探针 5→1，五轮一致 | mac2 L2：中位批耗时557.70→400.39ms，减少28.2%；L3未验证 | 四个子进程不再启动；仍重验二进制元数据/环境，不缓存能力或trust |
| [遥测追加保留用量聚合](../performance-experiments/20261016-usage-telemetry-incremental.md) | 10000行暖账本+五次遥测追加/查询，重读 5→0 / 4757290→0 bytes，五轮一致 | mac2 L2：中位批耗时26.26→1.43ms，减少94.6%；L3未验证 | 不再重读/parse整文件；性能记录仍完整保留 |
| [Pi只读probe关闭](../performance-experiments/20261017-pi-probe-close.md) | EOF后有空闲handle：关闭grace到期1→0；4响应、1进程保持，五轮一致 | mac2 L2：总耗时1630.84→870.19ms；关闭761.07→2.26ms；L3未验证 | 成功只读探测立即TERM并仍确认退出，不把关闭移到返回后 |
| [终态共享 after-tree](../performance-experiments/20261017-terminal-shared-after.md) | 5000文件、不同脏基线：Git 24→17，写树2→1，五轮一致 | mac2 L2：整体777.59→540.32ms（30.5%）；首个turn结果约424ms不变；L3未验证 | 两个before锚点共用一个不可变终点；最后一个持有者负责清理，完整完成边界仍等待清理 |
| [真实 Service.diff 双校验](../performance-experiments/20261017-service-diff-revision.md) | 5001 tracked、4 dirty、1 remote：Git24→18，原生status2→2，remote查询6→0 | mac2有效L2：507.64→382.85ms（24.6%）；首组高负载作废，全部样本留存；L3未验证 | 只不做两个校验不需要的本机remote展示查询；不缓存、不删除revision材料 |
| [桌面远程 trace 增量](../performance-experiments/20261023-desktop-remote-trace-delta.md) | 1000 items：线上字节 55.9 MB→1.8 MB；安静轮询 10.6 MB→4.2 KB；提交次数 127→102。5000 items：基线 165 次超限、显示 2380/5001，候选 0 次错误、显示 5001/5001 | L2 受控 fixture（负载 4.9/3.7，非 highLoad）：1000 items 下提交 2002.7→941.0 ms，客户端 91.1→6.7 ms；L3 未验证 | 未变 items 不再序列化、传输、校验或提交；宿主仍做 O(n) hash；空闲时轮询从 1.5 s 退避到 5 s |

前两个实验冻结collector `cafc418`、生产 `7ac7fcb`；第三个冻结测量 `1456e35`、生产 `afd8f03`。第三轮全量33个obs：1 better、30 unchanged、2 gating pass、3 macOS CPU指令candidate缺失，无worse。只收紧candidate平台基线，没有升级门禁或放宽。

**日志顺序缺陷后续已修复**：[同毫秒归档排序实验](../performance-experiments/20261016-journal-order.md)。保留原专项22通过/1失败和基线负对照；新归档使用可跨重启恢复的单调排序时钟，不改文件格式或recordedAt。新增冻结时钟/重启/回拨回归在旧实现确定性失败，修复后全量3261通过/4 opt-in跳过；无法恢复已有同毫秒旧归档的歧义顺序。

**L2已在mac2补证**：[原始样本与方法](../performance-experiments/20261017-mac2-runtime-evidence.md)。Apple M1/8核，Node24.18.0，同机同lockfile/collector、各5个fixture、串行锁内测量；负载7.95→7.12，highLoad=false，但接近8核阈值，不能称完全空闲。仅证明上述两个固定生产路径变快，不是整个App或12秒目录查询的收益证明。原本机10核负载10.36→9.39的highLoad=true结果保留，不用mac2结果冒充本机低负载结果；尚未安装或收集L3。

**第三轮RPC分段结果**：离线夹具确认了一项750ms EOF等待，mac2负载2.24→2.13、highLoad=false；启动到首响应约0.87s未变，不能声称真实12秒目录延迟已解决。mac2全量3263通过/4 opt-in跳过；首轮空HEAD与metadata fixture超时的修正、以及本机worker RPC通信超时未定位的限制均记录在实验中，不用后续通过抹去失败。

**第四步共享终点已验证**：冻结测量 `7ad8957` / `67a8252`，生产 `aff6006`。首版因首个turn结果晚34ms被用户拒绝；引用持有版保留首次可用边界，清理仍在整体测量窗口与诊断耗时内。隐藏真实App离线UI/IPC流程独立核对7对归档快照（3对含文件改动），两次重启通过。本轮mac2全量首次3273断言通过但worker RPC超时，改为异步等待测量CLI（`8987f46`），保留原断言、负载和120秒上限；最终3274通过/4既有opt-in跳过。旧本机worker失败的完整归因仍不追认。36个obs在收紧前为3 better、31 unchanged、2 gating pass，另3个macOS CPU指令candidate缺失，无worse；只降低三个candidate平台基线。

**第五步真实 Service.diff 已验证**：冻结 `8514551`，生产 `06a3f41`；两个时间点的完整 revision 材料与公式不变，仅内部投影不取 remotes。普通面板、写入、PR/传输仍取完整 status。9 项新增验收、故意去掉 post-check 后 5 项确定性失败的负对照、mac2全量3284通过/4既有opt-in跳过、隐藏真实App源代码管理UI均通过，无外部GitHub写入。首组L2 `highLoad=true` 不作收益结论，观察到负载恢复后补得有效组（3.03→3.86 / 8核）；没有改 workload、timeout 或丢弃样本。40 obs：3 better、35 unchanged、2 gating pass，另3个CPU指令candidate缺失，无worse；只降三个candidate基线。旧11次同名负载与8次门禁不变。

**后续优先顺序**：本轮性能包已安装且运行身份已核对，接下来按当前新 build 采样；同场景两侧各≥30样本、≥2会话且核对环境/数据健康后再做L3，判断真实优先级，不为继续降次数删除身份、filter或revision校验。若继续优化Provider启动/扩展/模型目录，agent先补真实listCommands/runControls的端到端分段；真实账号/费用授权不足时不运行，不把离线结果当12秒根因。未推送、未正式发布；后续并行提交不自动算作已安装。保持trust、证据收敛与崩溃恢复合同；原生客户端不在本轮范围。
