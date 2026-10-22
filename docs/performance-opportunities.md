# 性能机会日志

由 `.agents/skills/scry-performance-climb` 维护。记录当前机会排名、大胆想法和覆盖缺口；实验（含失败）各自一个文件放在 `performance-experiments/`。数据结论必须注明来源与成熟度。排名超过 14 天或跨过一次发布需重新分析。

## 方案 A：按需 Provider 发现（按需层收口；mac2 Node/UI/计数通过，Swift 测试待完整 Xcode）

- 在隔离分支实现 metadata/selected 协议及能力协商；定时元数据不再初始化全部 Provider，仅选中 Provider/Profile/canonical cwd 才读取能力。同上下文只合并在途查询，沿用 Provider 已有实例机制；未新增 Pi settled cache 或统一常驻池。
- 固定三个上下文的 **adapter 入口计数**：metadata 0、两个重叠 selected 请求 1、显式 legacy 全量 3，五轮一致。注入 metadata 全量探测后回归确定性失败。这不是 CLI 进程数或 L2/L3 提速结论。
- 第二轮源码 `a742d62`、测试/诊断 `1588832`：补齐主机观察时间、独立发布版本、已知配置失效栅栏；旧在途数据不发布/不回填缓存，可见、focus 与成功手动重读保留用户选择，失败不复用旧成功值。底层 SDK 缓存/重载仍逐 Provider 决定，不承诺外部配置即时全部生效，不视为完整常驻 A。
- 本机类型/build、iPhoneOS unsigned SDK 编译、完整 renderer UI、25 项失效 focused 已通过；本机完整 unit 的 Rename 超时和 Swift TLS leaked promise 首次记录保留。用户授权 mac2 复验冻结 `54e9dd1`：完整 unit **3491 pass / 4 既有 opt-in skipped**、完整 renderer UI、类型/build、Swift build、完整43项计数及 ratchet/propose/guard 均通过。未修改测试期限，未应用1字节的无关 candidate baseline 提议。mac2 Swift test 因无 XCTest/完整 Xcode 未进入执行，不把它当作 TLS 问题已解决。
- 测试 owner 下一步在完整 Xcode 环境运行原 Swift 全套并复核 TLS；性能 owner 补独立冷/热 L2。mac2 计数时 load3.09→3.45/8核、highLoad=false，但这不是毫秒收益证明。三个 CPU 指令 candidate 缺失仍为 missing，不记0。未合入、push、安装或真机重放。范围、各轮原始失败及交付身份见[本次记录](performance-experiments/20261021-provider-discovery.md)。此前 0.2.216 安装问题是另一冻结产物，不混为本次安装结果。

## 0.2.216 安装进度（2026-10-21，包启动仍受阻）

完整 CLI gate 588 项、App unit 3463 项（另 4 opt-in skipped）、shell、类型检查和构建已通过；源码冻结 `a868251`。构建目录的签名包在私有 CLI/GUI 启动时收到 SIGKILL，尚未完成 packaged smoke，未执行安装。相同字节诊断副本与已安装 0.2.215 的对照结果、首次失败及日志见[实验记录](performance-experiments/20261021-desktop-ui-fluidity.md#0216-发布验证续跑2026-10-21)。下一步由发布/系统诊断 owner 定位该启动问题，不再重复全量测试碰运气；不修改系统防护或直接安装未通过门禁的包。

## Mac UI 流畅性续轮（2026-10-21，Pi 历史打开重复归档读取）

- 固定调用链复核确认：Pi 历史打开先用 `readTraceArchivePageAsync` 读取最近页；若同时存在 Pi 原生历史，随后无条件再次 `readTraceArchiveAsync` 以做 ID 对账。最近页已是 complete（`hasOlder=false`）时，这次完整读取是重复工作；超过 40 轮的 partial 页仍必须完整读取，不能把分页证据当成全量证据。
- 最小修复：native-history 对账复用已证明 complete 的首个 archive page；partial 页保留权威完整读取。不会改变 native/Scry ID 对账、cwd/provider/session 栅栏、附件 hydration 或错误状态。
- 证据：`src/main/session-history.test.ts` 新增 callback 负对照，complete page 不调用 full-read，partial page 调用一次；31 项通过。Pi 原生历史隔离 Electron 验收通过，验证 41 轮分页、archive reconciliation、无 Provider 执行。`npm run typecheck` 与 `npm run build` 通过。
- 性能级别：L1 代码路径/读取次数推导；本轮未做高负载下毫秒结论，也没有 L3 日常收益结论。减少的工作是 complete archive 的第二次读取，未移到后台、未缓存过期证据、未改变 workload。
- 限制与下一步：partial/legacy archive 仍可能读取完整源；需在并行工作冻结且机器负载正常时，以现有 history-opening native fixture 记录 archive read count 与点击→首个可用历史分段，再决定是否继续改动。`performance:measure --scenario navigation.catalog` 仍因无匹配 collector 不作为本轮证据。

## Mac UI 流畅性首轮（2026-10-21，源码已验证；首轮安装门禁受阻）

- 固定 277 会话原生 UI fixture：切换行执行 **555 → 2**，hover **280 → 5**；20 次流式更新仍不重绘 Sidebar。存档 277 行两次渲染的新建日期格式化器 **554 → 0**（复用模块实例）。均为 **L1**，不等于用户日常端到端耗时下降。
- 保留视觉与交互；取消 hover owner 的列表级 context 广播，memo 隔离无关行；减少动态效果时真正禁用 transition。完整 renderer UI、typecheck、build 通过。
- 两轮安装门禁的 unit 分别有 1/13 个失败（高负载下后端超时、清理失败及一个 Codex fixture SIGABRT）；未绕过门禁，未安装、未替换用户实例。修改隔离在分支，不混入主工作区并行 WIP。已安装 0.2.215 与当时源码 0.2.214 的版本差异本身不是阻碍；安装策略要求从已提交源码构建，后续恢复已确认 repair commit 已在提交树中。
- 下一优先：集成 owner 在并行工作冻结、负载正常后重验安装；性能 owner 单独测历史打开与 Provider 能力加载，现有等待不能靠动画修复。iPhone 留待真机轮次。
- 固定负载、负对照、首次失败和限制见 [实验记录](performance-experiments/20261021-desktop-ui-fluidity.md)。

## 目录观测与传输修复交付（2026-10-20，已安装、待手动重启）

[0.2.211交付记录](performance-experiments/20261020-catalog-observation-0211.json)已冻结本次范围：原样迁移此前 `ee782b4` 的最小脱敏目录观测，并将当前WIP中已有的Mac1连接元数据剥离修复纳入安装包。不实现按需刷新，不改变冷发现、进程退出、模型/权限或Owner/trust语义。

- App **0.2.211**、CLI仍为 **0.2.49**；安装build `f6c2a4d279d7a731369907876e52976cd717638cdd7cf541d6d75fd340e00dc1`，已按 `npm run install:mac:dev` 安装 `/Applications/Scry.app`，源码build与安装包嵌入值一致。已核对编译后的元数据剥离逻辑、三个registry观测入口及两个Pi观测名称。
- 验证：完整typecheck、3486 unit（4项既有opt-in跳过）、shell、587 CLI release、完整renderer UI（含Credits）、packaged resource/ABI/security/remote-host门禁通过。Pi工作量对照均不变：RPC进程1→1、响应4→4、grace expiry 0→0、环境Node进程1→1；无worse，不报毫秒或提速。
- 保留首轮聚焦合并命令120秒超时；拆分用例和最终全量通过，未放宽断言或测试超时。安装取证先后修正了VM缺少原生 `structuredClone`、把动态registry事件名误当完整字面量的工具假设；这些不是产品故障。
- 安装基于 `be907ef` + 已冻结的既有WIP基线 `b1df508a…` 及本次迁移/版本变更。72项既有脏路径已逐项验哈希，package原有脚本修改保留。既有remote/iOS工作不混入本次源码提交；不能声称仅凭新提交即可复现整个WIP安装包。
- **尚未生效/未验收**：用户进程PID14356仍运行0.2.209/build `6bd35f8c…`，未被自动重启。需用户手动退出并重开Scry后，由我确认运行build及gateway绑定，再在已获准的iPhone13重放Mac2文件夹/Provider/模型路径。修复版真机结果、完整首次目录/relay可见耗时仍未验证；不把安装成功当作手机错误已修复。

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

**后续优先顺序**：本轮性能包已安装且运行身份已核对，接下来按当前新 build 采样；同场景两侧各≥30样本、≥2会话且核对环境/数据健康后再做L3，判断真实优先级，不为继续降次数删除身份、filter或revision校验。若继续优化Provider启动/扩展/模型目录，agent先补真实listCommands/runControls的端到端分段；真实账号/费用授权不足时不运行，不把离线结果当12秒根因。未推送、未正式发布；后续并行提交不自动算作已安装。保持trust、证据收敛与崩溃恢复合同；原生客户端不在本轮范围。

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
