# 2026-10-25 · CPU 单位修正与渲染/持久化排查

## 结论与交付身份

- 已修正 `app.resources.processes[].cpuPercentOfOneCore`：Electron 的整机占比乘以逻辑 CPU 数，恢复字段承诺的单核占比，不把多核使用量截到 100。CPU 数只在 monitor 启动时读取一次。
- 生产修复提交：`b51b3b82`，基于 `04fcaf68`，分支 `perf/cpu-observation-20261025`。只改变 CPU 单位，不改变采集频率、字段结构、保留策略或历史文件。旧 build 的错误数据不能与修正后的 build 混用。
- 日常实例：0.2.223，build `2d6b6d7e0d9dba6cce72d3fbc23f842c1a99e726ff793e3be6578eddbfe5a56a`；安装包内 build 与同进程性能日志一致。安装日期 unknown；本次确认运行日期为 2026-10-25。
- 本次工作区基线为 0.2.221；已通过开发构建，不代表完整 App 打包产物。尚未合入 main、打包或安装。main 的 0.2.223 工作区有并行修改，不能用旧分支覆盖日常安装版，也不能混入他人改动。另从 main `51b26fcf` 的干净 Git archive 计算 source build ID，得到 `747b6dc33420283e12e1c699da2a26692435b94e1fd0a762ce1cc3e32776c0c9`，与已安装 build 不同；版本号相同不能证明可无损替换，安装源映射仍需维护者确认。
- 只有 CPU 计量修复进入生产代码。下述帧监控/扫光开关只在隔离实验中生效；持久化生产代码未改。没有启动真实 Provider、停止日常任务或修改日常性能记录。

## 1. CPU 单位：错误与负对照

Electron 42.10.1 的 `App::GetAppMetrics` 明确将 `GetPlatformIndependentCPUUsage` 除以 `NumberOfProcessors`：
<https://github.com/electron/electron/blob/v42.10.1/shell/browser/api/electron_api_app.cc#L1425-L1444>

原代码直接将该值写入 `cpuPercentOfOneCore`。本机为 Apple M2 Pro、10 逻辑 CPU。同一约 31 秒窗口的系统 CPU 时间差与日志核对如下（日志取窗口内 6 个采样，窗口边界不同，不能要求严格相等）：

| 进程 | 系统 CPU 时间差 / 实际时间 | 原日志均值 | 原日志 × 10 |
|---|---:|---:|---:|
| Browser | 10.63% | 1.09% | 10.88% |
| Tab | 22.03% | 2.38% | 23.80% |
| GPU | 22.84% | 2.60% | 25.95% |

新增 1 核、10 核及超过 100% 的回归检查。修复前 4 项中 2 项失败；修复后全部通过。调整原测试中 3.5→35 的预期，是修正上述单位合同，不是迁就实现。

## 2. 渲染开关实验：只确认额外工作，不声称 CPU 收益

运行：

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs renderer-idle-controls -- node scripts/performance-renderer-idle.mjs
```

方法：复用真实 `Sidebar` 交互 fixture，两条运行中会话，通过 Chromium 原生鼠标事件进入动态列表。Electron 42.10.1、独立 HOME/userData/sessionData、sandbox/contextIsolation、禁网络和弹窗、隐藏 offscreen GPU 渲染且含回读。四种 monitor/sweep 组合按正序再倒序运行；每组固定 700ms 稳定、3000ms 观察。没有缩小某一组的列表或停掉它的状态旋转环。

**范围限制**：这里只测 frame/observer 循环。每个条件约 3.7 秒，短于默认 5 秒上报周期，且 report callback 是 no-op；不含性能上报 IPC 或 journal I/O。offscreen 回读成本不代表前台 App。独立审查指出这一限制后，已补入脚本和结果的 `scope`，未改动采样数值。

| monitor | sweep | 两轮 frame callbacks / 3 秒 | 两轮样式重算 / 3 秒 |
|---|---|---:|---:|
| 开 | 开 | 352 / 361 | 352 / 361 |
| 关 | 开 | 0 / 0 | 360 / 361 |
| 开 | 暂停 | 361 / 360 | 361 / 360 |
| 关 | 暂停 | 0 / 0 | 28 / 28 |

这说明帧监控会维持逐帧工作；只关监控时，扫光仍维持样式重算。状态旋转环仍运行，所以 offscreen paint 次数仍约 360，不能把暂停扫光解释为停止了所有合成。

负载为 **10.8→16.79 / 10 核，highLoad=true**。毫秒和 CPU 数据保留在 [原始结果](20261025-renderer-idle.json)，但不能用来宣称收益。L1 工作量线索成立；L2 有效低负载收益与前台日常 L3 均未验证。

没有擅自将全时帧监控改成抽样/按需：那会改变采集语义，不能仍把漏掉的慢帧报告为零。也没有取消用户可见的扫光效果。后续须先决定监控策略/动效取舍，再在低负载下验证。

## 3. 持久化：重复存在，但不把异步等待当 CPU

真实调用链：`LiveTraceIngestion` 立即发布 bounded projection，再串行持久化完整 raw，最后发布同 id 的内容引用。完成/归档仍等待持久化收敛。

日常 69 分钟内 2,124 个 `agent.trace_content` 样本：排队 p50=0、p95=364ms；出队后处理 p50=58.7、p95=113.6ms；428 次排队超过 100ms。**这些是 wall time，且事件计数不等于实际 blob 写入次数。**

代码与实验确认：

- managed recorder 开启 full capture 时，App 与 recorder 必须各拥有完整内容。当前两个根分别 `Buffer.from` 与 SHA-256，存在可复用的编码/摘要；不能删除其中一个副本。
- live preview 与 durable capture 分别处理 raw；对象可能重复遍历/序列化，字符串不能一律算成两次 JSON stringify。本次实验只使用字符串，没有测对象路径占比。
- 已有 blob 已经不再重写临时文件或同步全部祖先；但仍验证已有字节并同步发布目录。这是失败恢复合同，不能直接返回成功。
- 已有 `contentRef` 的重放已经跳过正文写入；不能把历史恢复全部算作重复写盘。

运行：

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs trace-content-duplication -- node scripts/performance-trace-content.mjs
```

实验调用真实生产持久化代码，16 KiB / 1 MiB 字符串，单根/双根，新内容/已有内容，每种组合 5 次。每次独立验证 App 全文分页和 recorder 副本；只在写入阶段统计 payload SHA-256，验证阶段不计入。所有数据在临时目录，结束清理。

| 内容状态 | 单根 payload 摘要次数 | 双根 payload 摘要次数 |
|---|---:|---:|
| 新内容 | 1 | 2 |
| 已有内容（包含已有字节完整性验证） | 2 | 4 |

两种大小、每组五轮一致。负载 **44.36→42.01 / 10 核，highLoad=true**，所以 [保留的计时](20261025-trace-content.json) 不支持节省毫秒或 CPU 的结论。当前只确认重复编码/摘要，未证明它主导排队；不新增跨事件缓存或改变同步保证。

若继续该项，优先测单次调用内共享 Buffer/摘要、每个根仍独立校验与原子同步的候选。验收必须包括任一根损坏/写入失败不发布 enrichment、两根独立可读、原始证据仍保留及 FIFO 不变。

## 验证、原始失败与限制

| 检查 | 实际结果 |
|---|---|
| 旧实现负对照 | CPU focused 4 项中 2 失败 |
| 修复 focused | CPU monitor、journal、feedback 共 30 项通过；typecheck 通过 |
| 独立工作区全量 unit | 328 文件通过、4 跳过；3,954 项通过、4 既有 opt-in 跳过；471.15 秒 |
| `npm run typecheck`、`npm run build` | 独立工作区通过；未作为安装或真实 Provider 验收 |
| `npm run performance:measure` | 46 observations，33 unchanged、4 better、4 worse、3 missing、2 gating pass；门禁通过，未改台账 |
| 两个隔离实验 | 执行和内容/状态断言通过；全部 highLoad，CPU/ms 收益 unavailable |
| 脚本语法、diff | `node --check`、`git diff --check` 通过 |

四个 worse 分别是 `files.fixed-operations` 的 read/readdir/read.bytes，以及 `persistence.archive` 的 ipc.bytes。已用 `--compare 04fcaf68 --scenario ...` 对每组作前后对照：read=417、readdir=20、archive bytes=10558 两侧相同；read.bytes 为 1,227,446→1,227,437（相差 9 字节，非本次新增工作）。旧台账已落后于基线分支，不归因于 CPU 换算，也不擅自上调台账。四个 better 也不归功于本次 CPU 修正。

首次在原共享工作区执行全量 unit，300 秒工具超时，已确认没有继续持有日志的进程。部分输出包含 staged-file-size 6 秒超时及并行新增 stale-socket 测试失败；原目录同时有其他写者。保留该次失败记录，没有放宽 Vitest timeout 或改那些测试；随后转移自有两文件到基于初始 `04fcaf68` 的独立工作区，原目录的其他改动完整保留。

本地完整日志和日常记录快照留在 `/tmp/scry-cpu-analysis-gPsxOX/`，未把用户会话内容加入仓库。新计数脚本不参与日常 App 构建，不改变生产采集。

## main 交付续记

维护者随后明确授权“推送到 main 分支，然后安装”。从远端 main `205521e9` 建立独立工作区，移植本次提交为 `e68fcff3`（CPU 修复）与 `bc546a03`（实验）。本地 main 的 12 个未推送提交未夹带，现有并行工作区未修改。远端 main 当时仍为 0.2.221；新的 App 安装版本统一升为 0.2.224，CLI 保持 0.2.51。版本提升不代表包含本地未推送的功能。

当前 main 候选验证：`npm test` 为 3,873 通过、4 既有跳过，shell 通过；`npm run test:renderer:ui` 全链通过（含 Credits、真实隔离 App 的 IPC/归属/三轮对话与重启）；`npm run check:cli-release` 为 627 通过，CLI package smoke 通过。typecheck/build、30 项 focused 回归通过。`performance:measure` 46 项的分类与上文相同，四个 worse 均为已核对的既有台账差异，未改基线；本次不声称 CPU 工作量下降。

## 下一步与责任

1. Agent 按已确认的远端 main 基线推送上述相关提交并运行 `npm run install:mac:dev`；安装结果仍待验证，不将已构建当作已安装。
2. 维护者决定是否将全时帧监控改为明确标注的按需采样，或调整扫光效果；Agent 在该决定和低负载窗口之后继续单变量实验，不将当前高负载结果当作优化验收。
3. 持久化优化由 Agent 在低负载、真实大小分布证据具备后再评估，不先碰 fsync、完整性或证据收敛边界。
