# 本地实时 Diff 需求与同工作区锁争用（2026-10-30）

## 结论与范围

这是五项计划中第 4、5 项的后续，不替换[上一轮 preview/目录批处理记录](20261030-preview-and-content-batch.md)。用户确认了完整方案：补本地 Legacy 可见需求通知，并为同一绝对锁路径增加进程内 FIFO。动画保持原实现；没有内容缓存、全局写调度或新的远程可见性协议。

- **L1**：离线 Native N=3/5 的 main Git 调用均值 162.5→103、213.5→135；N=1 为 68.5→68。每会话仍是 1,457 次 main sync 尝试，未删持久化屏障。
- **受控 L2**：同进程、同工作区 canonical commit 的 N=5 尾部完成均值 243.65→165.28 ms；真实锁尝试 26.33→5、owner 读取 31.33→10。每个操作仍真正获取文件系统锁。
- **不成立的结论**：Native N=5 总完成均值 27,302.5→27,532 ms；RSS 不改善。不能称 App 整体更快、整体 CPU/内存下降，不能用两个样本/格推断统计显著性或日常 L3。
- 最终源码为 `7e5580f7`，App 0.2.236 / 私有 CLI 0.2.55。用户选择**只保留安装包，不安装、不重启日常实例**。本地开发 ZIP 及当前版本验证见[交付 sidecar](20261030-live-diff-demand-lock-queue.delivery.json)。

## 1. 本地需求与证据所有权

生产实现：`7286555e`，可见消费者边界修正 `7e5580f7`。

- Unified/Side Chat 复用现有 run-scoped stream 订阅表达需求，不增加轮询。Legacy 使用 typed `runTraces:setLegacyDemand`；main 校验 sender、参数和当前焦点。频道计入 `performance-paths.json`。
- 文档隐藏、切换视图、无消费者的最大化或窄布局释放需求。重新可见时立即请求；epoch 丢弃旧在途结果，不把旧 `afterAt` 改成当前时间。既有 8 秒完成后间隔、终轮 sealing、恢复和 canonical 所有权不变。
- **正文隐藏不等于没有消费者**：右侧 Overview、Diff、Agents 共享主 run projection。它们可见时继续订阅；侧聊由自己的 scope 表达需求。窄布局仅显示 Files 时可停止正文预览；最大化 Overview 时不能停。
- 远程缺少可见性协议，保守维持原先采集，不假装已有手机/远程需求控制。
- `bootstrap/run-diff.ts` 集中初始化需求；`RemoteView.tsx` 按职责从超限的 App shell 抽出，原文案移入 `remote-copy.ts`。没有改动画或 CSS。

### 真实 App 正反对照

测量 helper 单独提交于 `bc4029c1`、`522b1701`；测试是隔离 HOME/userData/workspace 中的 sandboxed Electron、真实 Git 和 native trusted-hit 指针，不是程序化 `.click()`。诊断 `activeRuns()` 读取只用于功能验收，不混入默认性能比较。切会话负对照使用无需求控制的旧 artifact；窄 Files/最大化 Overview 的负对照使用尚未修正消费者边界的236候选，不冒充235基线。最终三场景均基于 `7e5580f7` 代码重新运行。

| 场景 | 旧行为对照 | 最终源码验收 |
|---|---|---|
| 切到另一会话，原 run 继续写到第 14 工具 | 明确失败：隐藏时仍发布新 preview | 首次/隐藏 `afterAt` 相同；返回含激活和实际 DOM 在 2 秒内显示 `14 files`，仍在运行 |
| 受控桌面窄视口只显示 Files | 明确失败：隐藏正文仍发布新 preview | `15:27:38.723Z` 隐藏时不变；返回 `15:27:51.733Z`，DOM `14 files`，仍在运行 |
| 最大化 Overview，正文隐藏 | 明确失败：可见 Overview 丢失实时 preview | `15:28:13.563Z`→`15:28:22.674Z`，10 文件；实际右侧 DOM 出现首次 preview 不含的新文件，仍在运行 |

窄视口通过 Chromium desktop metrics（`mobile:false`）触发真实 CSS/ResizeObserver 分支，不是物理 OS 窗口/最小化验收。最大化使用实际 App 按钮。三场景各完成三轮最终记录。首个窄屏控制错误地使用了仍消费证据的 Overview，其停采断言不是有效合同；原失败保留，改用 Files，并另加 Overview 保持鲜活的反向保护。另有一次 shell 参数拆分错误在 timing-run usage 校验前终止，未启动 Native workload；没有当成有效样本。

## 2. 同进程 FIFO，不替代真实文件系统锁

生产提交 `c90c0152`，实现位于 `src/core/turn-recorder/io.ts`。

- 以绝对锁路径分组；同路径调用按入队顺序进入，不同路径独立。
- 排队和原生锁共用原有总等待预算。等待者超时即移除，不能后来执行；持有者结束/失败后唤醒下一项。
- 每个获准操作仍执行原始 native acquire、owner/token/PID 校验、TTL、心跳、stale recovery、payload 与目录同步。队列不是跨进程公平锁，也不把多次提交合成一次持有。
- 自审发现事件循环延迟可能使过期 timer 尚未派发而等待者已获准。先用阻塞事件循环的负例证明错误，再增加 admission 后 deadline 校验；没有扩大超时。
- 真实跨进程锁、FIFO、不同路径、异常释放、过期等待者及真实 Git 从未预览仍完整最终采集均有回归。

### 同工作区 canonical commit ABBA

mac2：Apple M1，8 核/16 GiB；Node 24.18.0。四次运行顺序 baseline/queued/queued/baseline，每次三轮 N=1/3/5；每个 variant/并发数有六组。108 次真实 canonical commit 核对 owner、序列和恢复。所有计时经 `timing-run.mjs` 串行，`highLoad=false`。详见[全部微场景](20261030-live-diff-demand-lock-queue.queue.json)。

| 并发 | 尾部完成均值 ms | native attempts | owner reads |
|---|---:|---:|---:|
| 1 | 30.93→32.93 | 1→1 | 2→2 |
| 3 | 119.65→90.98 | 9→3 | 12→6 |
| 5 | 243.65→165.28 | 26.33→5 | 31.33→10 |

N=5 的持有时间总和也由 185.26→162.53 ms 变化，不能把全部 78.37 ms 差值归因于 FIFO。`tail - held` 58.39→2.75 ms 还包含锁前/后的工作，不是纯排队耗时。没有删除异常样本；N=1 变慢也保留。

## 3. 为什么没有增加内容缓存

一次带返回结果归因的 N=5 基线记录了 810 次内容路径 read 尝试：605 次 ENOENT、205 次成功；205 个成功路径各读一次，attempt rows 未截断。错误代码和完整报告随原始证据保留。

这不能证明所有读取都无优化空间，但不支持“成功路径被反复读取，应该缓存”的假设。也不能把一次 ENOENT 当作成功读取或少读一次 blob。跨操作缓存会新增失效/腐坏验证合同，本轮不增加。重复的锁 owner 读取已由 FIFO 减少。若后续固定负载证实重复成功读取且耗时占主导，再单独提出读共享方案，不缓存缺失、失败或未经重验的磁盘真实性。

## 4. Native 并发比较与完整内容

冻结 App235 / CLI54 baseline 与 demand+FIFO 变体；每个 N 按 ABBA，两个样本/variant，共 12 个有效低负载案例。每会话 20 工具、20 实际文件、400 有序 assistant delta、42 Hook shell、2 CLI；两个逻辑 stream reader。各 run 使用独立工作区，**不是全 App 同工作区 N=5**；同工作区证据来自上述真实 Core commit 实验。

| 指标均值 N=1 / 3 / 5 | baseline | demand+FIFO |
|---|---|---|
| 完成 ms | 23548.5 / 25249 / 27302.5 | 22723.5 / 25087 / 27532 |
| main Git calls | 68.5 / 162.5 / 213.5 | 68 / 103 / 135 |
| main sync attempts | 1457 / 4371 / 7285 | 1457 / 4371 / 7285 |
| main CPU ms | 1461.35 / 3086.87 / 4481.03 | 1459.48 / 2982.12 / 4458.00 |
| renderer CPU ms | 16419.00 / 16208.19 / 17190.31 | 16434.71 / 16785.10 / 16424.32 |
| GPU CPU ms | 3022.10 / 3721.47 / 4596.94 | 2888.35 / 3733.69 / 4641.79 |
| main peak RSS MiB | 256.13 / 279.89 / 291.38 | 254.15 / 280.34 / 291.62 |
| renderer peak working set MiB | 335.05 / 329.63 / 340.41 | 349.46 / 338.03 / 352.13 |

样本与完整均值：[N1](20261030-live-diff-demand-lock-queue.n1.json)、[N3](20261030-live-diff-demand-lock-queue.n3.json)、[N5](20261030-live-diff-demand-lock-queue.n5.json)。计数是已归因 main 的 API/子进程尝试，不等于全部内核 syscall 或 Git 子进程 CPU。默认比较没有诊断 `activeRuns` 调用。

独立退出后核验 36 archive turns、720 工具/文件/footprints、14,400 有序 delta；2,880 份 workspace/App 双 authority 工具输入输出 blob 完整字节一致；2,160 个归档 patch 引用的完整长度/hash 与 canonical Git patch 相符。不用预览前缀或数量代替内容证明。

冻结变体不冒充最终236的计时。后续总预算 admission 保护、职责拆分、版本与可见消费者修正由最终代码门禁和独立真实 App 场景验证；原始冻结 main/CLI、harness、lockfile 标识保留。没有提升 candidate、改 workload、放宽 ledger/门禁，或把任务挪到计数范围外。

## 5. 视觉、交付与剩余限制

没有改 sweep 的颜色、亮度、速度、范围、文字效果或帧率；没有静态替身。最终包两份 CSS 的字节数/hash 为：

- `index-B_VDw92z.css`：494,139 bytes，`26ab5646a02a74026e8fcd0af2f53614d5b0d3ba3dbf5ba9891324cee7cf8ada`。
- `TerminalSurface-GVL3fBIr.css`：7,112 bytes，`854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6`。

`npm run pack:artifact` 已通过，包 299,282,320 bytes，低于 346,030,080；包含隔离启动、renderer crash/recovery、IPC/导航/文件边界、终端和 remote host 冒烟。ZIP 解压后全部 514 个条目的完整文件字节、权限、符号链接目标一致；源/解压包 strict code signature 均通过。ASAR 与本地 main、完整 CLI dist 对齐；ZIP SHA-256 为 `0d4da49a54d2bb654b90b04be861dbcfa1435d2d2bbe69af416871b6fc55fabe`。这是本机开发构建，不宣称 notarized 或正式发布。

### 当前验证与保留的失败

| 检查 | 结果与范围 |
|---|---|
| `npm run typecheck` + focused demand/surface tests | 最终消费者修正后通过；4 文件/31 测试 |
| `npm run test:unit -- --maxWorkers=1` | 最终源码 Node22.22.1：511 文件通过、4 原有 opt-in 跳过；5,118 测试通过、4 跳过 |
| `npm run test:shell` | 通过；对应 shell/CLI 源码未在最后 UI 修正中变化 |
| `npm run check:cli-release` | CLI55：61 文件/813 测试及 package smoke 通过；最后 UI 修正未改 Core/CLI |
| Node20.20.2 Core/CLI + package smoke | 53 文件/628 测试；Node20、Node24 CLI55 package smoke 通过，不冒充整仓 Node20 |
| `npm run test:renderer:ui` | 最终源码完整原脚本通过；包括真实 App 表面、Credits、终端、session、Side Chat、remote 等既有场景 |
| timing lock 内 `npm run performance:measure` | 135 observations、141 ratchet rows，passed；load 5.15→3.83/8，`highLoad=false` |
| `npm run pack:artifact` + ZIP roundtrip | 本机 App236/CLI55 通过；未安装、未重启、未 push |

最终 ratchet 的四个非 gate `worse` 与上一轮 mainline control 相同：workspace choices Git 10/9、files readdir 20/18、archive IPC bytes 10558/10536、cold content stat 44/36。这四个既有差异未变；本轮不把它们算作收益，也未改 ledger 或阈值。完整行保留于 sidecar，不把 candidate 当 gate。

保留而不抹掉：

1. 默认双 worker 全量首次在未改的 `workspace-choices.test.ts` 一个用例超时。该文件独立 7 测试通过；后续单 worker 全量 5,117 通过，最终增加 disabled-acceptance 保护后全量 5,118 通过。未增超时、未 skip、未删断言。
2. 完整 UI 首次因 session-cache 等旧 fixture 缺新增 bridge 方法失败。`da107796` 补齐七个 fixture；生产 bridge 本来存在，focused 及原完整 UI 随后通过。
3. 最终消费者修正后的完整 UI 首次出现 `Surface menu did not restore its trigger`，active element 为 composer textarea。查看未改的菜单恢复与新会话 focus 路径；当前及修正前 App shell 的临时 focus-call 诊断都未复现。恢复全部原脚本/源码后，完整 UI 通过。**未归因、未宣称修复**，未改焦点逻辑、派发、断言或超时；诊断可能改变时序，不能据此证明与改动无关。后续若维护者要追踪，应另开焦点时序复现任务，不顺手扩大本轮性能改动。
4. 无效 N=2 配置、Runtime.evaluate 顶层 await 写法、错误 Overview 停采断言和 shell 拆分 usage 失败均保留，不纳入 12 个 L2 比较案例。

原始 archive SHA-256：`d0f34db2b80f7c2a30844739839a332f9fbb66c103f77aa0a9fd3ba59b4b37c6`；mac2/本地一致。归档重新解压后，独立 verifier 再次核对全部 720 文件的已知完整 fixture 字节、20/轮 footprint、工具输入输出、14,400 有序 delta、双 authority blob 和全部 patch 引用。原报告/记录/内容、冻结 main/CLI/CSS、源快照、harness/lockfile、计时/清理回执、失败日志与 verifier 均保留。源/解压 App 两份 CSS 与冻结 baseline/combined 逐字节 hash 相同；不是完整前台帧像素证明。

用户选择只保留开发 ZIP。打包前 `/Applications/Scry.app` 为0.2.227；最后复查变为0.2.235、ASAR `74fcedb9…`，修改时间17:01Z晚于本轮打包结束15:38Z。本轮未调用安装器，未安装自身236产物；不把动态安装目标称为“保持227不变”。变化原因及日常进程实际 loaded version 未调查，不把磁盘版本当 loaded-runtime。纯文档补记不改变 production build ID。

不宣称真实 Provider、物理手机、OS 前台/最小化、日常 loaded-runtime 或 L3 已验证。未重新建立全仓 coverage 通过结论；普通全量 unit 与 coverage 是不同门禁。远程需求协议、跨进程公平性、跨轮内容缓存和整体 UI/内存优化不在本次接受范围内，新增合同仍需单独确认。
