# 固定基准、主分支对照和 PR 反馈

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

version 6 修正历史首屏断言：归档加载的现有权威合同是 `bootstrap/history-archive.ts` 的 10 轮默认首屏，而非更早页的 40 轮。旧 version 5 在 Actions 40995379812 的 baseline/candidate 四个负载均因此失败；保留该失败证据。固定数据集仍为 40×32、20×1、20×32、120×2，完整更早历史恢复、正文、输入、发送/停止与归档验收不变；不修改预算或指标。新旧 harness 不可混合比较，比较必须使用相同版本的双侧测量。

version 7 修正计数器校准边界：Actions 41013450982 的 candidate/short 在两次独立 CDP 窗口中比较空操作与一次 DOM 操作，启动期间的无关更新可使前者计数更高。现保留这两组原始计数，但用同一 renderer task 内的计数器读数证明空操作为 0、插入和移除为 2；仍通过真实 MutationObserver 计数，不填入预期值。丢失任一受控 mutation、校准缺失或旧版本证据均拒绝。四种负载、测量样本、预算及实际工作计数不变；这不是性能改善。

负向验证：阻断 Send 的 click 传播会缺少 pending 通知；阻断 Stop 会缺少终态/界面恢复；将正文设为不可见，即使终态已到也不能通过可见帧检查。三种破坏均须失败，恢复后再运行正常验收。

Native 测量前先用 `electron-builder install-app-deps` 准备 Electron ABI 的原生依赖，并解析 Electron 可执行文件，避免首次下载混入 JSON 输出。失败日志保留启动部分，不能只保留尾部而丢掉原生模块加载错误。

Native 比较器同时检查身份、环境、工作量、完整样本、真实输入和终态/归档证据，缺失 lane 或任一失败不能通过。初始绝对上限为历史两帧 500 ms、handler 延迟 100 ms、脚本 300 ms、输入两帧 250 ms、驱动启动 10 s、SQLite 统计查询 500 ms、各生命周期阶段 2 s，并保留相对上限；这是保守回退护栏，不是体验承诺。历史/输入底噪 50 ms，启动 500 ms，生命周期 100 ms。单次及三次最大值明确标注，不伪装成日常 p95。原始 JSON、失败日志、构建日志和双侧比较分别归档，不混入 Node 微基准。候选 fixture 或预算变更必须人工审查；不能靠缩小 workload 或提高预算消除失败。一次失败不能用无解释重跑抹掉。

依赖安装沿用各自 lockfile 的版本和 integrity。lockfile 的 `resolved` 指向 npm 官方 registry，因此外部 runner 不依赖任何内网镜像，也不需要额外的 host 替换配置；不会升级版本或跳过完整性校验。固定 baseline checkout 同样复制这份配置。安装输出和失败时的 npm 调试日志也归档，不能因为测量尚未启动就丢掉失败证据。

同仓 PR 的独立 job 更新评论；写 token 的 job 不检出或执行 PR 代码。fork PR 只提供只读 Actions summary/artifact。评论同时汇总 Node/native 两个 job 的实际状态及报告；测量失败或缺失时明确没有有效比较。让它成为必需合并检查还需要仓库 branch protection 配置；提交本地文件不会自动改变远端设置。

本地比较也必须隔离两个源码目录、使用同一 harness/config/Node 和各自 lockfile；不能拿历史文档中的其他硬件或不同 fixture 数字当 baseline。可以用临时 detached worktree，但不要在同机并发跑耗时基准。

### 失败归因证据

Native 输出保留 `artifactFiles` 的逐文件 SHA-256；`lifecycleTraces` 保留现有 stdout 中的启动、start/stop IPC 和 Agent trace。`localRecording.diagnostics` 另保留隔离 App journal 中已有的启动、start IPC、主进程/renderer 资源和 health 丢失记录。两路 trace 可能重复，不能相加；journal 的队列可能丢记录，必须结合 health 判断，不能假称完整。

上述记录只在测量完成并退出 App 后导出；不改变日常采集内容、频率、格式、保留策略或预算。空记录或关闭记录表示该证据不可用，不表示耗时或资源占用为零。

CI 的 baseline/candidate 均经同一冻结版本的 `timing-run.mjs` 串行加锁，分别保存负载记录；`highLoad: true` 时不能宣称可信的延迟结论。仅当两次完整测量均成功、原始比较失败时，额外执行一次 candidate 同产物诊断。诊断必须通过 revision、环境、harness、各 lane 产物及 driver 指纹一致性校验，再用原比较器双向比较，保留 `control-forward.md` / `control-reverse.md`。双向检查避免只看到“第二次更快”，遗漏反方向超过既有预算的波动。

这不是把失败样本换掉的重试：原始 `report.md`、全部样本和失败状态保持不变；对照即使通过也不能放行合并。对照失败可证明同产物观测不稳定，但不能单独证明争用、GC 或排除分支回归。fixture 不完整或身份不一致时不产生有效 A/A 结论。

2026-10-30 的 [CI 41045559281](https://github.com/bingjiang0611/scry/actions/runs/41045559281) 有 29 个相关计时行超出比较门槛；其中 paged 首次 complete 的 start receipt 为 428ms、terminal 为 688ms。与上一轮相比，同一 baseline 产物的 short-heavy startup 也从约 1064ms 变为 3843ms。这证明存在明显波动，但没有证明宿主争用、GC 或排除 App 瓶颈；不能把下一次绿灯当作本次问题已修复。新增的是归因证据，不是性能修复，门禁算法与固定负载不变。
