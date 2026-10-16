# 持续性能闭环

目标：日常发现慢点 → 提出可检验的假设 → 固定基准验证 → 发布 → 同场景实际使用对比 → 防止回退。不是保证所有操作已优化，也不把微基准当作用户体验验收。

## 路径地图和覆盖边界

权威清单是 [`scripts/performance-paths.json`](../scripts/performance-paths.json)，可运行 `npm run performance:inventory` 检查引用和注册入口。新增未归类的 main IPC channel / named trace 会使检查失败。namespace 下新增方法自动归属该组，但仍需人工更新相应的具体场景、数据规模和验收。

| 路径 ID | 用户操作 | 并行责任组 |
|---|---|---|
| startup | 启动、恢复 | startup-navigation |
| providers | Provider、模型、权限、MCP、Skills | analytics-capabilities |
| navigation | 项目、会话列表、管理和切换 | startup-navigation |
| history | 历史打开、分页、缓存恢复 | history-storage |
| compose | 输入、附件、草稿 | compose-live-control |
| send | 发送准备、首个 Provider 输出 | compose-live-control |
| stream | 流式对话、Markdown、滚动、传输 | compose-live-control |
| controls | 停止、steer、问答、后台任务、并发 | compose-live-control |
| persistence | 终态收口、证据存储 | history-storage |
| evidence | 工具详情、文件足迹、Overview | analytics-capabilities |
| analytics | 用量、费用、诊断与性能面板 | analytics-capabilities |
| workspace | 文件浏览、读写、预览、外部打开 | workspace-source-control |
| source-control | Git、diff、PR、review | workspace-source-control |
| terminal | 终端输入输出、恢复、历史 | terminal |
| remote | 远程桌面、手机、配对、重连 | remote-device |
| resources-shell | 全局交互、设置、资源、退出 | startup-navigation |

每项的 `operations` 是已接入的观测口径，`benchmarks` 是本次自动比较的固定场景，`sources` 是真实入口，`gap` 是明确待验收项。空 benchmarks 不是通过，也不是全路径基准覆盖。现有 native session-open、Git、历史归档和 soak 检查仍可单独运行，不能把这些历史结果冒充本次执行。

本地固定 harness 覆盖清单中的全部 16 个用户路径组。它调用真实 production domain/file/process 实现，并在每个场景断言内容、计数和成功 outcome；`domain` 是计算/投影，`disk` 使用临时目录中的真实 catalog/archive/workspace，`process` 使用真实本地 Git 子进程。它不把标签贴到无关基准，也不把 mock 返回计时当作能力执行。手机直连 host 请求、终端输入到回显、按键到绘制、外部应用打开、真实 Provider 和网络各跳尚不是完整动作链；它们在清单中保留独立验收任务，而不是硬编码为 0。

## 日常记录

正常启动默认写入 `<Electron userData>/performance/performance-{0,1,2,3}.jsonl`。macOS 默认目录通常是 `~/Library/Application Support/scry/performance`；以实际 userData 为准，不扫描用户会话文件。

- 只记录代码定义的操作/阶段、数值、Provider ID、结果状态、时间、构建身份和环境；不记录提示词、路径、附件、工具正文、错误正文、账号或凭据。
- 没有遥测服务器、自动上传或新特权 IPC。采集异常 fail open，仅固定警告，不阻断 Agent。
- `SCRY_PERF_RECORD=0` 关闭磁盘记录。`SCRY_PERF_LOG=1` 独立开启原有 stdout 诊断；只关闭磁盘而保留 PERF_LOG 仍会启用监测。
- 内存待写队列上限 256 KiB，另有一批最多同等大小的在途写入；每 5 秒刷新。4 个文件各不超过 5 MiB，总保留上限 20 MiB，旧数据按文件轮转，不承诺保留多少天。
- 溢出不阻塞业务，累计 dropped count；正常退出写入 health 记录。进行中的 session、崩溃、磁盘错误和未刷新的最后窗口不等于完整数据。读取崩溃尾行保留问题标记，不能给改善结论；新启动不把 JSON 拼在截断尾行后。
- 构建时对整个 `src/`、package/lockfile 和 Vite 配置计算指纹并嵌入 main。它标识**编译时的源码/依赖配置快照**，不是已签名包的二进制哈希。纯 renderer 修改也产生新身份，运行时不扫描/哈希源码或 bundle。
- 开发服务器的可变 renderer 标为 `unfrozen-development`，不能做版本收益比较；使用 `npm run build` 后的固定构建或正式安装版本比较。保留 App 版本、平台/OS release、架构、CPU 型号/核数及 Electron/Node 版本，不混合这些环境。
- 可见 renderer 每 5 秒报告帧/长任务聚合，隐藏或超长挂起窗口不当卡顿；不支持 longtask observer 时显式标记，报告不会显示成零长任务。全局聚合不意味着能归因到某个按钮。

`completed` 表示测量的里程碑达到：IPC 是 Promise resolved，不是业务成功；`error` 是抛出/拒绝；`cancelled`、`unavailable` 单列。首段文本是 main 收到文本而非屏幕绘制。历史错误/过期分页和无输出 run 也会结束其 named trace，不只保留成功快样本。

## 发布后比较

先关闭待比较的 App，确保退出刷新；在轮转前另存需要长期比较的 performance 目录。备份也是本机诊断数据，不自动共享。

```bash
# 列出 retained builds 和记录健康状态
npm run performance:report -- '<userData>/performance'

# 将轮转日志复制到一个尚不存在的目录（只在本机；每文件检查并保存 SHA-256）
node scripts/performance-report.mjs snapshot '<userData>/performance' /tmp/scry-observation-snapshot
# 只选择一个准确的 build ID，不能用版本号代替或混入其他构建
node scripts/performance-report.mjs baseline /tmp/scry-observation-snapshot '<build-id>' /tmp/scry-baseline.json

# 用上一步的完整 build ID，比较相同机器上的两个固定构建
npm run performance:report -- '<userData>/performance' '<baseline-build>' '<candidate-build>'
```

单构建 baseline 包含全部路径组、操作/阶段、Provider、环境、workload、结果分布及带单位的 p50/p75/p95。资源和 renderer 窗口也纳入报告；一个窗口有多个指标，但只算一个记录。缺失路径为 unavailable，不支持的 long-task 指标单列，不能补零。路径被观测只表示出现过某项操作，可能只是后台轮询，不证明整个用户动作链已完成。

快照不是文件系统不可变对象，也不保证多文件原子捕获；读取时校验保存的哈希，修改/缺文件会使报告带问题标记。单构建报告始终是 provisional 观测，不作为已成熟 SLO 或版本改善结论。双构建报告另外提供差值及以下保守结论。

- 成功耗时至少每侧 30 样本、2 个 App session；不足为 `insufficient-data`。这不是统计显著性保证。
- 环境/规模无匹配为 `unmatched-workload-or-environment`；未测规模显式 `workload-unmeasured`。
- 未正常关闭、丢样或损坏尾行时为 `incomplete-recording`，不输出成功改善。
- 同一 operation/provider/environment 的非 completed 比例上升超过 2 个百分点时，优先报告 `completion-rate-regressed`，包括错误发生在规模计数前的情况。
- p75 变化超过 10%（毫秒指标另设 2 ms 底噪）才报告方向性改善/退化。无变化不是等价性证明。不同屏幕刷新率、后台负载、缓存和外部服务条件仍可能影响结果。
- 没有足够数据时不编造结论。发布前 fixed benchmark 通过，不代表发布后的真实用户收益。

## 固定基准、主分支对照和 PR 反馈

```bash
npm run performance:bench -- /tmp/scry-candidate.json
npm run performance:compare -- /tmp/scry-baseline.json /tmp/scry-candidate.json scripts/performance-budgets.json /tmp/scry-performance.md
# macOS：真实隐藏 Electron + 离线 Provider 夹具；不使用付费 Provider/手机
npm run build
node scripts/performance-native.mjs bench /tmp/scry-native-candidate.json
node scripts/performance-native.mjs compare /tmp/scry-native-baseline.json /tmp/scry-native-candidate.json /tmp/scry-native-report.md
```

`performance-baseline.test.ts` 直接调用生产实现，固定场景与路径组一一对应：

| 路径组 | 场景 | 实际测量 |
|---|---|---|
| startup | `startup.recovery` | 临时 userData 恢复清理与 usage 读取 |
| providers | `providers.catalog` | 真实 skills/MCP 配置扫描 |
| navigation | `navigation.catalog` | 500 条临时 app session catalog 读回 |
| history | `history.page` | 4,000 轮中读取 40 轮 |
| compose | `compose.drafts` | draft 校验、更新、序列化和恢复 |
| send | `send.codex-fixture` | 受控本机 Codex app-server 的 thread/turn 请求与完整输出 |
| stream | `trace.delivery`、`renderer.batch` | 1,000 个 trace delta 的原始交付与 renderer 批投影 |
| controls | `controls.stop-lifecycle` | 受控本机 turn 上真实 interrupt/settle 生命周期 |
| persistence | `persistence.archive` | 临时 archive 的真实写入与 40 轮分页读取 |
| evidence | `evidence.projection` | 工具文件足迹与受限 evidence preview |
| analytics | `analytics.stats` | 240 条结果的 30/90 日 analytics 聚合 |
| workspace | `workspace.files` | 真实临时目录列表、文件读取、分页和写回 |
| source-control | `source-control.diff` | 真实临时 Git worktree diff |
| terminal | `terminal.delivery` | 1,000 块 Unicode 输出经过 TerminalOutputBridge |
| remote | `remote.loopback` | 真实 loopback relay auth、64 KiB leg payload 与会话交付 |
| resources-shell | `resources-shell.process` | 受控本机子进程 stdout、退出码和 resourceUsage 就绪 |

这是本地计算、文件和本机进程基准，不是 HTTP/WebSocket 压缩后字节、真实 Provider、浏览器 paint 或真机结果。测试只创建临时文件/Git/archive，不写用户会话或用户 DB，不运行真实 Provider Agent。生产路径正确性断言必须先通过，删除内容带来的变快不能通过。

每个场景有显式 `lane`、`workload`、warmup、sample 和迭代数。原有 `trace.delivery`、`renderer.batch`、`history.page`、`terminal.delivery` 均保持 3 批预热、15 批采样、每批 20 次；磁盘/进程场景只运行 2 或 5 次并使用 1 批预热、7 批采样，不盲目重复大型 I/O。计时含固定正确性检查。这是批均值的 p95，不是单次用户请求 p95。门禁同时检查：

- 两侧 fixture/config 指纹与运行环境一致，全部场景/指标存在且有效；缺指标失败，不能补 0。
- 绝对预算防止逐次累积退化；相对基线序列化 bytes 最多 +5%，消息数不能增长；事件、turn、输出正文大小等工作量计数必须相等，减少内容也失败。
- Relay 响应读取到 EOF，并用 `Buffer.equals` 校验完整字节与长度。避免把通用断言框架遍历 64 KiB Buffer 的 CPU 开销算作传输耗时；重复响应的负向实验必须失败，不能只校验预期前缀。
- 原有四项批均值 p95 的绝对 20 ms 预算不变。新增磁盘/进程场景使用 `performance-budgets.json` 中显式上限。所有场景仍受基线加上 max(2 ms, 基线的 50%) 的相对门禁约束，不承诺拦住亚毫秒抖动。
- 回退退出码为 1，写 Markdown/JSON 报告。真实重复发布和截断 renderer 输出有负对照测试。

`.github/workflows/performance.yml` 的 Node job 对 base SHA 与候选 merge checkout 分别安装对应 lockfile 的依赖，将**同一份候选 harness、bench runner 和 Vitest 配置**放入两侧，串行测量，保留原始样本/清单/预算/报告 30 天。独立的 macOS native job 同样冻结夹具、构建 base/candidate，并在同一 runner 串行运行四种固定历史负载。比较 12 个原生点击到两帧就绪样本、单次启动/原生输入观测，以及每负载三次完成、三次中断的真实 main/preload/archive 生命周期。发送回执、首输出接收、终态通知、停止回执、停止终态及可读归档分别计时，并在 App 退出后独立读取 canonical turn 文件核对输出；这些 IPC 阶段继续独立列出，不冒充按钮时间。启动含驱动等待开销，不是 OS 冷启动。

`measurementVersion: 5` 另增每负载三组、每组四次真实按钮验收：Provider 已进入夹具但尚无 native turn ID 时停止、正常完成、正文可见后停止、再次在 native turn ID 前停止。使用 Chromium 原生输入和可信 Send/Stop 点击；不调用 `window.scry.start/stop` 替代按钮。停止夹具等待实际 interrupt，不靠延时自然结束。早停先等待夹具的 pending 通知，避免把 Provider 启动前的前门取消混作 Provider 中断。

- 正文必须属于当前 run，DOM 包含完整预期文本，且其文本矩形在视口中可命中、CSS 可见，并跨两帧保持可见。分别报告按钮到 Provider 输出接收、首次可见和两帧就绪；这不是物理显示器扫描输出时间。
- 停止必须得到正确 run 的终态、退出 activeRuns，且停止按钮消失、输入框恢复可编辑并跨两帧。终态回执与界面恢复分别计时。
- 十二次按钮与六次 IPC run 均在退出后独立核对归档；原生 turn ID 阶段及完整正文不能丢失。SQLite 必须 ready 且有十八条 result。旧四负载、12 次历史点击和六次 IPC 样本不变。
- 两侧按 `nativeHarnessFiles` 冻结同一脚本、隐藏窗口防护和 offline smoke Provider，再各自构建；不是对真实 Provider 性能的比较。禁止显示/聚焦窗口的防护在生产 main 创建窗口前安装。
- 按钮每场景固定三或六次观测，保留全部样本并取 max，不宣称日常 p95，不按失败重试或丢弃首轮。新增绝对上限 1000 ms，加既有相对回归判定；它是初始验收护栏，不是用户 SLO。原有预算不变。
- 停止场景的 Send→终态总耗时含驱动发起 Stop 的间隔，另记录 `driverStopDispatchMs`，不称作纯 App 阶段。原生观察器完成两帧后直接唤醒驱动，不再叠加历史加载 helper 的额外两帧等待。

首版按钮比较（version 4）正确性全部通过，但单次总耗时有两项超限；这不能被称为性能通过。version 5 固定增加采样并去掉重复驱动等待，不调整预算、不删除旧历史/IPC 样本。旧结果保留供复盘，只有新版本双侧实测能证明新门禁状态。version 5 首次 Actions（38772624533）仍有 1/132 项失败：paged 正常完成的 Send→空闲界面最大值为 181.2 ms，上限 181.0 ms；其他两次候选值为 81.3/83.2 ms。该次失败不能被后续绿灯抹去，耗时波动的来源尚未确定，也不以四舍五入或提高上限放行。

负向验证：阻断 Send 的 click 传播会缺少 pending 通知；阻断 Stop 会缺少终态/界面恢复；将正文设为不可见，即使终态已到也不能通过可见帧检查。三种破坏均须失败，恢复后再运行正常验收。

Native 测量前先用 `electron-builder install-app-deps` 准备 Electron ABI 的原生依赖，并解析 Electron 可执行文件，避免首次下载混入 JSON 输出。失败日志保留启动部分，不能只保留尾部而丢掉原生模块加载错误。

Native 比较器同时检查身份、环境、工作量、完整样本、真实输入和终态/归档证据，缺失 lane 或任一失败不能通过。初始绝对上限为历史两帧 500 ms、handler 延迟 100 ms、脚本 300 ms、输入两帧 250 ms、驱动启动 10 s、SQLite 统计查询 500 ms、各生命周期阶段 2 s，并保留相对上限；这是保守回退护栏，不是体验承诺。历史/输入底噪 50 ms，启动 500 ms，生命周期 100 ms。单次及三次最大值明确标注，不伪装成日常 p95。原始 JSON、失败日志、构建日志和双侧比较分别归档，不混入 Node 微基准。候选 fixture 或预算变更必须人工审查；不能靠缩小 workload 或提高预算消除失败。一次失败不能用无解释重跑抹掉。

依赖安装沿用各自 lockfile 的版本和 integrity。项目 `.npmrc` 只将历史 `registry.anpm.alibaba-inc.com` 镜像 URL 映射到 npm 官方 registry，避免外部 runner 依赖企业网络；不会升级版本或跳过完整性校验。固定 baseline checkout 同样复制这份配置。安装输出和失败时的 npm 调试日志也归档，不能因为测量尚未启动就丢掉失败证据。

同仓 PR 的独立 job 更新评论；写 token 的 job 不检出或执行 PR 代码。fork PR 只提供只读 Actions summary/artifact。评论同时汇总 Node/native 两个 job 的实际状态及报告；测量失败或缺失时明确没有有效比较。让它成为必需合并检查还需要仓库 branch protection 配置；提交本地文件不会自动改变远端设置。

本地比较也必须隔离两个源码目录、使用同一 harness/config/Node 和各自 lockfile；不能拿历史文档中的其他硬件或不同 fixture 数字当 baseline。可以用临时 detached worktree，但不要在同机并发跑耗时基准。

## 工作量计数与只降不升门限

毫秒耗时受 runner 负载影响，多次出现无法解释的偶发超限。工作量计数测量一次固定操作做了多少工作，例如 IPC 消息数和字节数、文件读取、子进程、SQLite 查询、React 提交、样式重算/布局次数和 CPU 指令数。计数用于 CI 门禁；“操作到内容可见”的毫秒耗时仍是最终用户验收。

- 事实源：`scripts/performance-ratchet.json`（ledger）。键为 `scenario/metric`，记录层（`main`/`ipc`/`io`/`ui`/`memory`）、单位、固定 workload、测量来源、状态、门限和允许误差。
- 观测格式：`{ schema: 1, revision, observations: [...] }`。每项为 `measured` 加同一版本重复测量的整数 `runs`，或 `unavailable` 加原因。测不到不能写成 0。
- 采集：每个 collector 是 `scripts/performance-counters/*.counters.test.ts`，驱动生产实现、断言功能结果、重复同一操作（默认 5 次），并用 `writeCollector` 输出。`node scripts/performance-counters.mjs collect <out.json>` 串行运行全部 collector 并合并结果；CI 在计时测量结束后再采集。非采集运行时它们就是普通正确性测试。
- 当前采集面（全部为 candidate）：
  - **main/ipc**：trace、历史页、归档页、终端、远程预览的 IPC 消息数/字节数，以及 JSON parse/stringify 次数。
  - **io**：固定文件操作的 open/read/stat/readdir/write/rename 次数和读取字节（同版本有 4 字节波动，已记为 tolerance）、Git 子进程数、SQLite prepare/query/exec 次数。
  - **SQLite**：better-sqlite3 按 Electron ABI 构建，`*.electron.counters.test.ts` 在已安装 Electron 时用 `ELECTRON_RUN_AS_NODE=1` 运行。Node CI job 使用 `--ignore-scripts`，没有 Electron 二进制，因此报告 unavailable。
  - **CPU 指令**：`scripts/performance-instructions.mjs` 用 esbuild 打包生产 `src/` 模块，在固定最小环境和 `--jitless` 固定种子下计算“初始化+操作”减“仅初始化”的指令数。只支持 Linux `perf`/valgrind；macOS 报告 unavailable。hosted runner 是否允许 perf 尚未验证。
  - **ui**（native job）：历史打开、按按钮模式拆分的 Send→稳定、Stop→稳定的 CDP `LayoutCount`/`RecalcStyleCount` 增量和 DOM mutation 记录数，写入 native 结果旁的 `.counters.json`。只用单调递增计数；`Nodes`/`JSEventListeners`/`Documents` 是随 GC 变化的当前值，放在 soak 中强制 GC 后测量。2026-10-16 本机四负载实测：历史打开基本稳定（short-heavy 12 次相同，其余在两个值之间交替）；Send/Stop 波动大（如 DOM mutation 35..198），因流式输出被渲染的批次取决于时序，不能做门禁，尚未进入 ledger。
  - **memory**（`performance-soak.mjs`，`SCRY_SOAK_CYCLES`）：强制 GC 后从第 k 轮到第 N 轮的 JS heap、DOM documents/nodes/listeners 和 main active runs 增长。`runs` 表示各起点到终点的剩余增长，不是独立重复；稳态循环的 nodes/listeners 应为 0。`SCRY_SOAK_LEAK_FIXTURE=1` 是敏感性对照。8 轮实测：正常运行 nodes/listeners/documents 增长全为 0，泄漏对照下 nodes 11、listeners 7；JS heap 正常与泄漏分别增长 672 KB/794 KB，区分不了小泄漏，只作参考。
- 开发者入口：`npm run performance:measure -- [--scenario <id>|--layer <layer>] [--compare <ref>] [--repeats N] [--profile] [--out <dir>]`。`--compare` 在临时 detached worktree 中用候选版本的 collector 测量对照版本，完成后删除 worktree。`npm run performance:propose -- <observations.json> [--write]` 输出收紧建议。`.github/workflows/performance-ratchet.yml` 每周只在默认分支运行，发现可收紧的 gating 门限时创建 PR；尚未在 GitHub 实际运行。
- 相关性证据（`SCRY_PERFORMANCE_CORRELATION_OUT=<file> npx vitest run scripts/performance-correlation.test.ts`，按需运行）：测量操作总耗时中花在被计数工作上的比例（git 子进程存活区间的并集、同步 JSON.parse 时间）。比例高说明减少一个单位就能减少相应的用户耗时；不使用“把整个操作做两遍”这种循环论证。2026-10-16 本机两轮 × 15 次：git 子进程占 recorder diff 98.8%/98.9%、source-control status+diff 98.7%/98.2%；归档页 JSON.parse 只占 1.1%/1.2%。
- 当前 gating：`source-control.diff/subprocess.git`（8）与 `source-control.service.status-diff/subprocess.git`（11）。负向对照：在 `readWorkspaceGitDiff` 中多调用一次 git，计数 8→9，`check` 判 `regressed` 并失败。其余均为 candidate：IPC 字节/消息的真实开销发生在 Electron structured clone，需在 native 路径证明相关性；文件计数尚未测相关性；SQLite 在 Node CI 不可用；CPU 指令数未在 Linux 实测。门限值来自 macOS，Linux CI 值未观测；若首次 Linux 运行不同，按放宽流程处理，不能直接改数。
- 状态：`candidate` 只报告；`gating` 必须写明三项证据：**稳定**（同版本重复结果一致或误差已知）、**敏感**（注入多余工作后指标变差）、**相关**（指标下降时用户耗时也下降）。
- 判定（`performance-ratchet.mjs check`）：每项单独判定，不能互相抵消。gating 项超过门限加误差、重复测量差异超过误差、缺失或 unavailable 都失败；低于门限报告 `tightenable`。
- 收紧（`propose`）：只把 gating 门限降到新观测值，不提升、不升级 candidate、不删除。CI 不用 PR 代码回写仓库；更新由人工审查或受信任任务提交。
- 放宽（`guard`）：提高门限、扩大误差、降级或删除 gating 项，必须写 `raise: { from, to, reason }`，并由维护者给 PR 加 `performance-raise-approved` 标签后重新运行。改变 workload、单位或层就是新指标，必须使用新键。

## 并行优化任务合同

每项任务必须写清：路径 ID、允许改动模块、当前慢点证据、优化假设、固定 workload、预算、功能/权限/证据护栏、修改前后结果、发布版本和真实使用待验证指标。

- 各责任组在独立工作区修改路径代码；共用计时合同、report/comparator、预算和 `index.ts` 由一个集成人串行合入。
- baseline/CI 只能通过增加有效场景演进，不删保护、不静默放宽上限、不标空数据为健康。
- 优化后的合入版本统一跑门禁，避免单独通过但一起争用资源。耗时测量串行执行。
- 首屏/DOM/输入问题沿用隐藏 Electron native-input fixture；手机必须 iCTRL 真机，不用模拟器替代。没有授权的 Provider/网络/发布操作不因新增基准自动获得授权。
- 当工作量指标不再解释真实耗时时，升级为对应 native 用户路径基准；当分桶过粗造成混杂时，在相同隐私合同下增加具体 workload 维度，而不是扩大判断置信度。

此框架不自动安装、发布或上传本机历史数据，也不宣称所有路径已优化。PR/远端 CI 和必需检查的实际启用须另行授权与核验。闭环能提供可执行的反馈和明确的覆盖缺口；真实版本收益仍需后续发布与使用样本。

初期四基准的检查、首轮失败和限制见 [初期验收记录](performance-loop-verification.md)。本轮扩展门禁以对应 commit 的 Node/native Actions 结果及保留的原始 artifacts 为准，不能把初期结果当作扩展验收。
