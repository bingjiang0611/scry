# Managed Claude 工具 Hook：去掉重复 CLI 启动

## 结论

在保留 canonical 工具证据、生命周期、恢复和诊断边界的前提下，管理态 Claude 每轮 Hook CLI 启动从 42 次减为 2 次。42 个 shell 仍全部执行并读取输入；不是把工作藏进别的进程。

最新 Side Chat 源码上的离线 ABBA 实验，N=1/3/5 的 Hook 整棵进程树 CPU 保守降幅分别为 **78.39% / 79.44% / 81.87%**。这是 L2 受控 Hook 开销结论，不是整个 App、真实 Provider、内存或 L3 日常提速结论。Renderer CPU 和部分 Git 计数变差，见下文，不用 Hook 收益抵消这些指标。

初始并发基线与恢复验收仍见 [原记录](20261029-concurrent-baseline.md)。本记录收口后续优化、两组独立 A/B 证据和交付状态。

## 实现与边界

生产实现：`src/cli/workspace-hook-sources.ts`，回归：`src/cli/managed-tool-hooks.test.ts`。当前分支优化提交 `8be9afd7`；原始实验提交为 rebase 前的 `f48b7976`。

仅在以下条件同时满足时省去 CLI：

- `SCRY_RECORDER_MANAGED=1`，Provider 为 Claude，managed run ID 和 prompt hash 非空。
- 事件为 `PreToolUse`、`PostToolUse` 或 `PostToolUseFailure`。
- 先通过私有 CLI executable 校验，再成功 drain stdin；读取失败仍记录 `payload_read_failed`。

独立 CLI、其他 Provider、身份不完整、未知事件、开始/Stop/SessionEnd 均保留原路。canonical 工具证据来自 App trace，不依赖这些重复工具 Hook；queued terminal replay、恢复、通知和失败诊断不删。被省去的事件不伪造 activity 时间或计数，也不伪称它们提供了中途 drain/replay 机会。

17 个 focused 回归覆盖上述分界；旧实现负向控制曾按预期失败。未修改 renderer、动画、权限、trust、CSP、sandbox 或 recorder 收敛条件。

## 测量设计与权威性

- mac2，Apple M1，8 核、16 GiB；Node 24.18.0 / Electron 42.10.1。临时 HOME、userData、独立 Git workspace；离线 Provider；隐藏但执行前台 renderer 工作负载；GPU 和 sandbox 保留。
- 每会话固定 20 个实际文件写入、20 个工具调用、400 条流式增量、42 个 shell Hook；不缩减负载，不强制 GC，不调用真实/付费 Provider。
- 两组实验分开保存：旧 0.2.230 来源 `beac4da8`；最新 Side Chat 0.2.231 来源 `d824c609`。后一组 baseline/candidate 的 App 版本与 lockfile 完全相同，只切换 Hook 源码。交付版本才升为 0.2.232，私有 CLI 保留 0.2.53。
- 最新一组每个 N 都按 baseline、candidate、candidate、baseline 顺序运行，共 12 样本、36 会话。两份冻结构建各只有一个 artifact hash；所有样本共用一个 harness hash 和 lockfile hash。
- 每次测量经 `timing-run.mjs` 串行锁。最新控制器 420,103 ms，负载 2.56→7.33 / 8 核，`highLoad=false`；每个样本也均未标高负载。
- `/usr/bin/time -p` 计算 shell、Node 和原生 `cat` 的整树 CPU；Node 自身 CPU 另列，不能与整树重复相加。Darwin 的 user/sys 各自向下截断到 10 ms，因此每树损失严格小于 20 ms，不是 10 ms。保守降幅以 candidate 加满截断上界后计算。
- 精度修正单独提交 `0798c5c4`（原 `656e37ab`）；旧 raw 不变，只重算上界。Apple `time.c` blob：`d636de8fea98549fa2c161390ad4ce8dac256aa6`。错误上界的负向检查失败，修正后六项检查通过。

### 新版实时流验收

新版已由全量 `activeRuns` 轮询改为 run-scoped stream。首次合并实验在旧 collector 的“必须轮询到 N 个运行”断言失败；保存失败日志，不将其算作成功样本，也不补造轮询来维持旧数字。

独立测量提交 `3183bd4d` 改为要求：选中 run 的 scoped snapshot 成功，且生产 router 接受同一 subscription 的 post-commit batch ACK。仍保留所有并发会话的活动标题/动画检查、尾段渲染和完整归档检查。采集最多 10,000 条元数据，超限验收失败；缺少采集返回 unavailable。ACK payload bytes 不是 JSON IPC 或 Electron wire bytes。

新 collector 在未优化 baseline 上先通过，再测 candidate。8 个 focused 检查覆盖缺失、外来、拒绝、零字节和窗口外回执；对 12 份真实 raw 删除 ACK，全部按预期失败。`activeRuns` 在这组窗口内实际调用为 0，这是上游版本的协议变化，不归功于本次 Hook 优化。

## 最新 Side Chat 基线：两个样本的中点

| 指标：baseline → candidate | N=1 | N=3 | N=5 |
|---|---:|---:|---:|
| Hook CLI 启动 | 42→2 | 126→6 | 210→10 |
| Hook 整树 CPU，秒 | 5.090→0.260 | 16.565→0.885 | 33.235→1.825 |
| 每样本最大截断损失，秒 | 0.840 | 2.520 | 4.200 |
| 保守 CPU 降幅 | 78.39% | 79.44% | 81.87% |
| 完成时间，秒 | 22.923→22.833 | 26.180→25.889 | 27.902→28.195 |
| Main CPU，秒 | 1.429→1.526 | 3.656→3.449 | 5.317→5.202 |
| Renderer CPU，秒 | 12.890→16.566 | 13.284→16.239 | 10.552→16.672 |
| GPU CPU，秒 | 1.664→2.541 | 3.716→2.801 | 4.707→4.509 |
| Main 峰值 RSS，MiB | 237.70→253.70 | 272.40→283.09 | 300.59→301.78 |
| Renderer 峰值 working set，MiB | 312.79→332.48 | 321.60→330.40 | 316.38→339.19 |
| Main Git 次数 | 100→100 | 256→252 | 332.5→416 |
| Main fsync 次数 | 1,704→1,704 | 5,112→5,112 | 8,520→8,520 |
| 选中流 accepted ACK 批次 | 304→410 | 267.5→375 | 163.5→358 |

耗时变化很小，N=5 反而约慢 0.29 秒；不宣称完成更快。Main CPU、GPU 和内存没有一致改善。

Renderer CPU 上升约 22%–58%，必须单列。夹具每个工具周期先等待 Pre/Post Hook，再向该周期的固定 50 ms 时点补齐文本增量；Hook 更快时，相同的 400 条增量更少成簇，产生更多真实 UI 提交。ACK 批次数的增加已测得；这解释了新增更新工作，但不是逐项 CPU 因果分解，也不能冒充真实 Provider 结论。不通过减少动画、降低输出完整性或强制隐藏更新来美化这些数字。

### Git 增量：已追到额外快照，不是计数遗漏

独立提交 `407e1446` 增加有界 Git argv/时间记录，不换调用方式；单独重测 N=5 ABBA 四轮，不混入上表。153,138 ms，负载 1.42→3.28 / 8 核，未标高负载，日志未截断。精确时间窗口内 Git 为 baseline 339/319、candidate 411/402，中点 **329→406.5**，增量再次出现。

按真实 argv 定位：live 与 clone diff 的 `write-tree` 合计中点 **27→34.5**，即多出 7.5 组实际快照；对应 `read-tree` +15，`update-index`/`status`/`add`/`write-tree` 各 +7.5，`config` +7.5，`diff` +23.5，`ls-files` +1，`check-attr` +0.5；合计正好 +77.5。没有把额外 Git 漏到其他进程或复用旧报告。原始 argv 在本机诊断包，公共 [诊断摘要](20261029-managed-hook-skip.git.json) 不含临时路径。

`src/main/session-diff.ts:RunDiffPreviewer` 是共用的真实快照路径：每个 turn/session scope 串行刷新、完成后至少等 8 秒，有新写入时 trailing refresh，终态封口取消待执行项。Hook 变快后的输入节奏与快照耗时，允许本固定时长夹具完成更多预览；已证实增量来自这些快照，不能仅凭四轮把每组增加唯一归因到某个 timer 时点。这是更频繁的实际预览工作，仍有 CPU/进程成本；本次不减少预览、改节流、放宽门禁或冒称 Git 更快。真实 Provider 下是否同样增加，留给独立授权探针或 L3，不能从离线固定时长推断。

### 原 0.2.230 对照（独立样本，不混算）

| 指标 | N=1 | N=3 | N=5 |
|---|---:|---:|---:|
| Hook 整树 CPU，秒 | 5.285→0.300 | 17.255→0.905 | 32.895→1.795 |
| 修正后的保守降幅 | 78.43% | 80.15% | 81.78% |
| 完成时间，秒 | 23.391→23.514 | 25.976→25.464 | 29.141→28.616 |

旧样本同样有 Renderer/内存和 N=5 Git/轮询 bytes 不一致改善的限制。旧 10 ms 上界不再使用，中心 CPU/耗时未改。旧优化曾安装为另一个 0.2.231 build，随后被并行 Side Chat 安装替代；不能把旧安装成功当作当前仍生效。

## 完整性与可复查证据

两组各自核对 36 条 canonical records、720 个实际文件、720 个 canonical 文件足迹、720 份完整且 SHA-256 一致的工具输出、14,400 条按序文本增量。最新 raw 额外复制了实际文件到证据包，并在本机独立重新读取全部 12 份 raw、36 条记录和 720 个文件。每轮 activity 真实为 42→2，终事件为 Stop。归档检查、尾段 marker、42 个 shell receipts 与已登记进程清理均通过；不声称瞬时 DOM 同时包含全部虚拟化历史，也不声称拥有逃逸进程的完整审计。

| 项 | 证据 |
|---|---|
| 旧组修正后数据 | [v230 JSON](20261029-managed-hook-skip.v230.json)；内含 rebase 前历史提交标识 |
| 最新 ABBA 数据 | [v231 JSON](20261029-managed-hook-skip.v231.json) |
| 最新 harness SHA-256 | `faf520d01f946b631d665f0ad22012a8350ad08450eba0d97ab5b7b6aae4c62e` |
| 最新 raw 包 SHA-256 | `a7eb578a0205a55c93efd36ada9c79b07dfab44f92aeb5323746997c7bb27daf` |
| Git 诊断包 SHA-256 | `f01ad354fad8270d5b9e7a280e0dcae7604b917ae1c28c5130c07ce89bf1b404` |
| 旧 raw 包 SHA-256 | `b2a4d243a392c6df9c6ff6636351dd4b6f752f4993d32dd5f7fb73fcbb4613a9` |
| 本机新证据目录 | `/tmp/scry-hook-combined-v231.WlkKPe/`；raw 包、解包结果、verify-data 与 gate 日志 |
| 本机旧证据目录 | `/tmp/scry-hook-opt-v230.cDEHyY/`；原 raw、重算与精度负向控制 |

临时证据不等于永久存储；JSON 中保留 raw/artifact/harness/lockfile 的可校验摘要。没有上传会话内容或证据包。

## 合并版本验证与交付

当前集成基线 `d824c609`，优化 `8be9afd7`，版本提交 `f3980670`。当前源码 build ID：`bb020408efd2749cac1514fc717a992323b7187835e10e8ca768918463b77215`。

| 检查 | 当前合并版结果 |
|---|---|
| `npm run typecheck` | Node/Web 通过 |
| `npm run test:unit -- --maxWorkers=1` | 498 文件、5,057 测试通过；4 文件/4 测试按原配置跳过 |
| `npm run test:shell` | 通过 |
| `npm run pack:artifact` | build、CLI build、打包校验、packaged Electron 烟测通过 |
| `npm run check:cli-release` | 58 文件、805 测试及 CLI 0.2.53 package smoke 通过 |
| Node 20.20.2 Core/CLI | 50 文件、621 测试通过 |
| Node 20.20.2 / 24.18.0 package smoke | CLI 0.2.53 两项通过 |
| `npm run test:renderer:ui` | 全入口通过，含 Credits、Side Chat 快照/工作区竞争、真实坐标和生产 IPC |
| `npm run performance:measure` | 135 个观测值，ratchet 通过；未放宽台账或升门禁 |
| Git argv 诊断增强后 focused | 8 项通过，覆盖原生 args/options 重载；未再改生产代码 |
| 包资源/source 对照 | 0.2.232、CLI 0.2.53、源码 build ID 与包一致；6 个 renderer 资源仅版本文本/内容 hash 引用变化 |

首轮 `npm run pack` 保留为失败：并发全量 5,054 通过、1 个既有源码的 workspace-choices 测试超时、4 跳过。相同源码的独立 7 项检查全部通过，分页用例 2.019 秒，Git 批量建 refs 约 0.498 秒；独立测量锁内负载 4.23→5.04 / 10 核。首轮主机曾达约 15 的 load。资源争用是支持的解释，不宣称已唯一证明原因。未改测试源码、断言或超时；完整门禁按等价步骤执行，只将测试文件并发改为 1，之后仍走仓库 pack artifact 与原子安装校验。

已通过仓库原子安装器安装到 `/Applications/Scry.app`。安装前立即重验目标仍为获批 Side Chat 0.2.231（ASAR `5711c059…`），没有覆盖途中被其他任务替换的版本；安装后 Info.plist / ASAR 均为 0.2.232，私有 CLI 为 0.2.53。私有 Hook 编译模块与当前构建逐字节一致；source/build/renderer 资产摘要见 [交付证据](20261029-managed-hook-skip.delivery.json)。旧 Side Chat 包由安装器留在 `/Applications/.Scry.app.backup`。用户日常实例未被本任务停止或重启；安装后仍需用户自行重启才能加载新包。未执行 push、真实 Provider、付费探针或 L3。L3 的下一步由用户正常使用新 build 后提供同场景至少 30 样本、至少 2 会话，再做只读快照分析；不把本次离线实验当成该证据。
