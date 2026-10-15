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

目前覆盖所有经过 `registerTrustedIpcHandler` 的受信任请求的 **main handler 开始到 settle**，不覆盖 iframe/错误 sender（这些仍在测量前被拒绝），不检查/记录请求和响应内容。手机直连 host 请求、终端输入到回显、按键到绘制、外部应用打开、真实 Provider 和网络各跳尚不是完整动作链。它们在清单中保留独立验收任务，而不是硬编码为 0。

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

# 用上一步的完整 build ID，比较相同机器上的两个固定构建
npm run performance:report -- '<userData>/performance' '<baseline-build>' '<candidate-build>'
```

输出 JSON 给人和 Agent 使用，包含操作、阶段、Provider、环境、粗粒度 workload 分桶、样本数、session 数、结果分布、p50/p75/p95、差值及结论。

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
```

`performance-baseline.test.ts` 直接调用生产实现，当前 4 个场景：

1. `trace.delivery`：1,000 个固定事件经过真实 TraceOutputBridge；测 JSON envelope bytes、消息数、事件数，验证顺序和全部内容。
2. `history.page`：4,000 轮历史中取 40 轮；验证页内容、total、hasOlder，测页大小。
3. `renderer.batch`：实际 applyTraceBatch 合并 1,000 个 delta；验证全部文本、run identity 和状态，测结果大小/计算耗时。
4. `terminal.delivery`：实际 TerminalOutputBridge 合批 1,000 块 Unicode 输出；验证全部输出，测 JSON payload 和消息数。

这是本地计算和传输表示基准，不是 HTTP/WebSocket 压缩后字节、真实 Provider、浏览器 paint 或真机结果。测试不创建真实会话/DB，不运行真实 Agent。生产路径正确性断言必须先通过，删除内容带来的变快不能通过。

每场景 3 批预热、15 批采样，每批固定执行 20 次，记录每批平均耗时；计时含固定正确性检查的开销。这是批均值的 p95，不是单次用户请求 p95。这样减少亚毫秒微操作被单次调度/GC 尖峰主导的情况，原始批均值仍全部保留。门禁同时检查：

- 两侧 fixture/config 指纹与运行环境一致，全部场景/指标存在且有效；缺指标失败，不能补 0。
- 绝对预算防止逐次累积退化；相对主分支 bytes 最多 +5%，消息/事件/turn 计数不能增长。
- 批均值 p95 不超过绝对 20 ms，且不超过基线加上 max(2 ms, 基线的 50%)。这是粗粒度计算回退门禁，不承诺拦住亚毫秒抖动。
- 回退退出码为 1，写 Markdown/JSON 报告。真实重复发布和截断 renderer 输出有负对照测试。

`.github/workflows/performance.yml` 对 base SHA 与候选 merge checkout 分别安装对应 lockfile 的依赖，将**同一份候选 harness 和 Vitest 配置**放入两侧，串行测量，保留原始样本/清单/预算/报告 30 天。候选 fixture 或预算变更必须人工审查；不能靠缩小 workload 或提高预算消除失败。一次失败不能用无解释重跑抹掉。

同仓 PR 的独立 job 更新评论；写 token 的 job 不检出或执行 PR 代码。fork PR 只提供只读 Actions summary/artifact。测量失败时评论明确没有有效比较。让它成为必需合并检查还需要仓库 branch protection 配置；提交本地文件不会自动改变远端设置。

本地比较也必须隔离两个源码目录、使用同一 harness/config/Node 和各自 lockfile；不能拿历史文档中的其他硬件或不同 fixture 数字当 baseline。可以用临时 detached worktree，但不要在同机并发跑耗时基准。

## 并行优化任务合同

每项任务必须写清：路径 ID、允许改动模块、当前慢点证据、优化假设、固定 workload、预算、功能/权限/证据护栏、修改前后结果、发布版本和真实使用待验证指标。

- 各责任组在独立工作区修改路径代码；共用计时合同、report/comparator、预算和 `index.ts` 由一个集成人串行合入。
- baseline/CI 只能通过增加有效场景演进，不删保护、不静默放宽上限、不标空数据为健康。
- 优化后的合入版本统一跑门禁，避免单独通过但一起争用资源。耗时测量串行执行。
- 首屏/DOM/输入问题沿用隐藏 Electron native-input fixture；手机必须 iCTRL 真机，不用模拟器替代。没有授权的 Provider/网络/发布操作不因新增基准自动获得授权。
- 当工作量指标不再解释真实耗时时，升级为对应 native 用户路径基准；当分桶过粗造成混杂时，在相同隐私合同下增加具体 workload 维度，而不是扩大判断置信度。

本次不安装、不发布、不上传历史数据，也不宣称所有路径已优化。闭环能提供可执行的反馈和明确的覆盖缺口；真实版本收益仍需后续发布与使用样本。
