# Scry 第二阶段性能与稳定性执行记录

日期：2026-09-16

对应方案：[scry-performance-phase2-technical-plan.md](./scry-performance-phase2-technical-plan.md)

## 已实施

### P0：诊断与基线

- 新增诊断模式资源采样：`SCRY_PERF_LOG=1` 时每 2 秒输出 `[scry:resource]`，包含 main heap/RSS、Electron 各进程 CPU/working set、事件循环 p95/max，以及 trace 队列与 active run 数值。关闭诊断时不创建 timer 或 histogram。
- renderer 每 5 秒输出聚合 frame gap 与 Long Task 指标；IPC 只接受严格的数值字段白名单，不记录 prompt、路径、工具输出或凭据。
- 新增 renderer 压力 benchmark 和 archive 索引冷重建 benchmark。
- 新增 production packaged smoke soak runner；使用临时 HOME、userData、workspace 与内置 smoke Provider，不访问真实 Provider、不执行用户仓库。

### P1：无效工作、流式边界与稳定性

- Analytics 改为首次打开后才查询；chat-only 启动不再拉取完整范围分析。`dataUpdated` 100 ms 合并，分析查询串行，通知突发只追加一次最新范围刷新。
- 历史初始读取支持 `AbortSignal`；切换会话、cwd、folder、fork 会取消过期 archive/transcript 读取，旧结果不能写入新身份。
- trace ACK 从“preload 回调返回”后移到 renderer 批量 React commit 后。ACK 带 `generation + batchId + bytes`，重复、迟到和窗口 reset 前的 ACK 不释放新 renderer credit；被明确忽略的非焦点批次直接归还。
- Pi RPC 取消累计会话流量上限，但保留单个 JSONL frame / 未完成 frame 的 64 MiB 驻留边界。合法 17 MiB frame 继续支持，超界 frame 明确失败且不截断成伪证据。
- 测试专用删除确认绕过只在 `SCRY_TEST_APP=1` 生效，用于 soak 清理隔离会话；生产交互仍保留确认。

### P2：由测量触发的优化

- 约 80 KiB 完整 GFM 的 server-render 基线约 820 ms，已明显超过 50 ms 长任务预算；因此超过 48,000 字符且仍在 streaming 时采用保留全部字符、可选择的轻量 `<pre>`。终态按 fence/reference 安全边界拆分，并逐帧恢复完整、安全过滤后的 GFM；初次终态提交降至约 42 ms。
- 10k 结构事件上的 16-event active-turn batch 约 0.64 ms，现有 structural projection 约 0.017 ms；没有触发重写 turn store 或增设第二套事件权威列表。
- 500-turn archive：索引热页约 7.7 ms，索引失效冷重建约 98 ms，全量约 95.6 ms。保留可重建索引与异步有界读取；本轮没有引入 DB Worker、transcript 格式迁移或第二 writer。
- 4,000-turn / 40 visible 历史保持按页附件 hydrate：约 10.2 ms，对比 eager 约 662.7 ms。短时 production soak 的 heap 增量远低于 `max(20 MiB, 5%)` 候选预算，没有触发可变高度虚拟列表或历史对象窗口迁移。

## 本机测量结果

环境：Apple silicon macOS，Node 24.18.0，Electron 42.10.1，Scry 0.2.148。benchmark 为同机信息值，不作为跨机器门槛。

| 场景 | 结果 |
| --- | ---: |
| 4,000 turns eager hydrate | 662.7 ms mean |
| 4,000 turns / 40 visible deferred hydrate | 10.2 ms mean（64.9×） |
| 500 archive full read | 95.6 ms mean |
| 500 archive indexed 40-turn page | 7.7 ms mean（12.4×） |
| commit + invalidated index rebuild + page | 98.4 ms mean |
| 10k-event active turn / 16-event batch | 0.82 ms mean |
| 10k-event structural projection reuse | 0.020 ms mean |
| ~80 KiB Markdown normalize | 1.07 ms mean |
| ~80 KiB streaming lightweight render | 0.056 ms mean |
| ~80 KiB completed GFM initial render | 820.1 → 41.9 ms mean，后续块逐帧完成 |
| Git clean baseline | 151.5 ms p50 |
| Git 300-file baseline | 537.3 ms p50 |
| 30-second production packaged soak（修复夹具后） | 67 cycles；heap tail delta 1.37 MiB / 20 MiB budget；DOM 259 → 368；listeners 164 → 171；trace buffered/in-flight 0；active runs 0 |
| 最新 10-second interaction sample | 新会话视觉反馈 p95 3.2 ms；history load p95 88.8 ms（main）/104.1 ms（IPC round trip）；Long Task 0 |

长稳 runner 支持按环境变量控制时长，并在结尾验证 renderer heap plateau、trace drain、ACK credit 与 run registry 收敛。一次 1 秒 cadence 的极限回放在约 1 小时 27 分、3,883 个完整生命周期后触发 Git diff deadline，首事件延迟升至 21 秒并被 runner 判失败；该结果没有被当作通过。第一次长时 run 又发现 runner 直接删除 main 数据却不刷新 renderer catalog，形成 143k DOM nodes 的夹具假泄漏；产品现已在删除成功后发布 `session_deleted` 更新，App 只对该 kind 刷新 catalog，runner 也显式验证 sidebar row 回到 baseline。修复后的 30 秒高频复验完成 67 轮，DOM 259 → 368、listener 164 → 171，heap tail delta 1.37 MiB，队列与 run 均归零。根据维护者要求，不再执行小时级脚本；本轮稳定性验收以秒/分钟级高频 production packaged 回放、全量测试和故障注入为准。runner 仍保留每 20 轮一次约 90 KiB 流式压力轮和 60 秒单轮故障判定窗口，供后续按需手动使用。

## 已验证

- `npm test`：167 files passed / 3 skipped；2103 tests passed / 3 skipped；shell workspace setup PASS。
- `npm run test:regressions`：339 focused tests + 三组真实 Chromium/Electron UI smoke 通过。
- `npm run typecheck`：通过。
- `npm run pack:artifact`：production build、CLI build、signed development artifact、packaged-app 校验与 Electron security smoke 通过。
- 小时级脚本已按维护者要求停止，相关进程和 PID 文件已清理；没有将未完成的小时级运行写成通过。
- 已生成并验证 `dist/mac-arm64/Scry.app`；未安装、未推送。工作区原有大量未提交改动，为避免混入用户改动，本轮未创建 commit。
- `npm run bench:session-history`、`npm run bench:renderer`、`npm run build:cli && npm run bench:git-diff`：完成，结果见上表。
- Pi：合法 >16 MiB frame、超界未完成 frame、stdin 已关闭、stop/force-kill 和 managed recorder 相邻路径均有回归测试。
- trace：FIFO、high-water、丢 ACK、重复/迟到 ACK、reset generation、degraded/resync 与 terminal flush 有回归测试；packaged soak 证明队列与 credit 在 idle 收敛到 0。

## 验证边界

- 维护者要求不再运行小时级脚本，因此 2h/8h 长期 plateau 没有在修复后的夹具上重新验证；此前长时结果仅作为发现压力故障和夹具问题的诊断证据。
- packaged Electron、Chromium UI 与内置 smoke Provider 已验证；本轮没有对 Claude/Codex/Qoder/OpenCode/Pi 发起真实外部网络调用，其线上服务延迟与配额行为仍为 unknown。

## 未触发的大型改造

以下不是遗漏，而是按方案中的测量门槛暂不实施：

- Claude transcript 格式/字节范围索引迁移；
- SQLite 单 worker 所有权迁移；
- 可变高度虚拟列表；
- 全面 Markdown AST 分块缓存；
- 通用 Worker 池或第二份 canonical event store。

这些改造会扩大身份、恢复、内存复制或 writer 顺序风险；当前证据没有证明收益足以覆盖复杂度。
