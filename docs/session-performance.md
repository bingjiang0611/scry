# 多会话性能边界

本次优化不改变 Provider 权限、工具证据、归档事实源或 renderer 隔离。

## 实现

- 侧栏使用 memo；事件回调保持身份稳定，并在触发时读取最近一次提交的状态。项目筛选和置顶排序仅在项目数据或搜索词变化时执行。
- Trace 索引按 immutable 数组身份复用，使用 WeakMap，不延长旧历史的生命周期。纯 text/thinking 增量不重新建立全部索引；新增身份、删除和权威正文替换仍维护去重与顺序。React snapshot 的数组复制仍然存在，不宣称整个更新变成 O(1)。
- Pi 历史采用 archive 源级分页，每页仍执行 Provider 的 turn-local model-context enrichment；读取旧页后重验会话 revision。Claude transcript 和 Qoder 全历史 reconciliation 保持原路径。缺失/损坏的 archive index 首次仍需要扫描重建；热索引只读取请求页的 turn 文件。
- 已加载轮次超过 20 时，保留轻量跳转 shell，仅挂载视口上下 1200px 内的正文。初始预挂载最新 4 轮，让默认的 40 轮首个历史页也进入窗口化；每个 shell 首次测量前使用 240px 估计高度。测量、卸载和再次挂载保持滚动锚点。选中、定位、运行、待回答、有焦点、原生文本选择或展开工具/图片预览的轮次不卸载。键盘聚焦 shell 会恢复完整内容；释放焦点或选择后可再次卸载。
- 后台会话的运行标记和可访问名称保持可见，仅暂停动画。选中会话的动画保持旋转，改为每 1.5 秒 12 步；已有 hidden-page 和 reduced-motion 规则继续生效。

DOM 窗口不是数据丢弃：已加载的 Turn 数组仍保留，所有旧轮次可继续分页加载。主动展开/选择大量轮次也可能保留大量 DOM。若后续 profiling 显示已加载数据或大量 shell 本身成为主要内存来源，应将 renderer 的历史数据也按页缓存，并先补跨页证据跳转、选择和滚动恢复检查；不要直接截断历史或丢弃证据。

## 验证

```bash
npm run test:unit -- src/renderer/format.test.ts src/renderer/hooks/useAgentSession.test.ts src/renderer/performance-style.test.ts src/renderer/components/render.test.tsx src/main/session-history.test.ts src/main/transcript-archive.test.ts src/main/providers/pi.test.ts --exclude '**/.local/**' --maxWorkers=1 --no-file-parallelism
npm run typecheck
npm run build
npm run test:renderer:ui
node scripts/performance-animation.mjs
```

`session-performance-ui-smoke.mjs` 已接入 renderer UI gate。它使用临时 HOME/userData、生产 React/CSS 和可获得真实焦点的隔离 Electron 窗口；不读取真实会话，不启动 Provider。检查 277 个历史会话下 20 次流式提交不执行 Sidebar、回调读取最新状态、120 轮长历史的挂载窗口、可变高度锚定、证据跳转、展开状态、图片预览、原生选择、聚焦及释放后的卸载。

动画测量使用 GPU-enabled 可见隔离窗口，按 ABBA 顺序比较旧的 8 个连续动画与新的 1 个分步动画。每段 3 秒；本机 Electron 42.10.1 的一次测量 GPU 单核 CPU 均值约 5.7% → 2.3%，renderer 约 3.4% → 1.5%。这些是小场景测量，不代表完整 Scry 的 CPU 降幅，也不证明无内存泄漏。

新增索引回归在旧实现上因重复扫描失败；新增动画回归在旧 CSS 上因 8 个后台动画仍运行失败。UI 开发检查还发现并修复了可变高度锚点和 focusability 的回归。早期组合 focused 检查曾超时，未得到完整结果；随后使用保存完整日志的单 worker 分组验证。隔离 fixture 必须实际获得焦点，隐藏窗口不能单独证明原生 blur/焦点路径。
安装门禁另捕获 focus/blur 在 DOM commit 前到达的竞态；回归在旧实现上失败，修复后通过。释放空 shell 时仍取消排队的 materialization，不因尚未更新的 DOM 标记漏掉 blur，也不额外扫描空 shell 正文。

旧 renderer gate 的模型 fixture 曾依赖直接共享并原地修改 catalog，且 start 不发布生产已有的 provisional session 事件；memo 后暴露了这个问题。fixture 现在使用平台 `structuredClone` 模拟 IPC snapshot，并发布真实 start 的 session lifecycle；原有模型/会话断言和超时均保留。分页提示断言改为“时间线已加载”范围，同时保留总数、未丢弃声明与旧页入口，避免把数据范围误称为动态 DOM 挂载量。

不自动安装或重启正在承载真实会话的 `/Applications/Scry.app`。完整 App 在真实多 Provider 会话中的总 CPU、内存和交互延迟仍需安装同一已验证产物后复测。

## 第一轮：打开已有会话的本地闭环

复现入口（先构建，Node 22+）：

```bash
npm run build
node scripts/session-open-bench.mjs
npm run test:unit -- src/renderer/components/ChatTranscriptTurns.test.tsx
node scripts/session-performance-ui-smoke.mjs
```

基准启动当前生产构建的完整 main/preload/renderer，使用临时 HOME、workspace 和 userData，禁用所有 Provider 和 remote host。两个 Codex 归档会话各有 40 个已完成轮次，每条回答包含 32 段 Markdown。通过 Chromium 原生鼠标输入切换会话；终点是最新回答可见、历史加载结束且 composer 可编辑，再等待两帧。每次执行排除 2 次预热，保留 12 次交替打开的原始样本。输出包括产物 SHA-256、主进程分阶段 trace、renderer 脚本耗时和 DOM 数量。它不发送消息，也不读取真实会话。

2026-10-14，macOS arm64、Node 24.18.0、Electron 42.10.1、App 0.2.186：冻结源码包含当时已有 WIP，仅替换窗口化参数，按原实现 → 修复 → 原实现 → 修复执行。

| 指标（每次执行的中位数） | 原实现，两次 | 修复，两次 |
| --- | --- | --- |
| 点击到最新回答可见且可输入 | 304.5 / 282.4 ms | 133.9 / 119.2 ms |
| renderer 脚本时间 | 218.1 / 207.9 ms | 34.4 / 32.9 ms |
| 主进程历史读取 | 54.0 / 46.0 ms | 57.0 / 54.7 ms |
| 测量终点的 transcript DOM 节点 | 12,240 | 345 |

这证明本场景的收益主要来自避免首个历史页一次渲染全部正文，而不是加快归档读取。所有 40 个轮次跳转目标和数据仍保留。基准另验证原生输入、向上恢复旧正文、回到最新正文及草稿保留。短历史不超过 20 轮时保持完整 DOM；运行中、选中、定位和待回答轮次仍固定挂载。

第二组对照的完整 `out/` 产物摘要：原实现 `073a0b4eae71157b74fde8f7d1e41afc221599d6e0054df969d577ac98ffebd7`；修复 `a51c50545fde769ced6f6ad0da9cea953ab90be22b19060c4e214cb194a30289`。并行改动后的工作区另外构建并检查构建期间源码未变化，完整 App 基准通过，打开中位数 112.8 ms，产物摘要为 `ded7ddedb768a07fc407aaff3e4fd7c3bc5fcbdd73464211600ab0136ca40e82`。最后一次在其他任务更新后的产物上重放，中位数 153.9 ms，摘要 `25a61926c2577152284a499dcc13f662a32f03f269b9d9c3f75bd0dd6d3204d3`；基准现在重验测量前后产物摘要一致，变化时拒绝报告成功。这两次是集成验证，不用于优化归因。

防退化使用稳定的初始挂载数量，不对有噪声的耗时设硬门槛。新增 3 个 unit 场景覆盖短历史、首个历史页和固定挂载；旧实现有 2 个失败。现有 Electron gate 新增首个 40 轮页面至少窗口化 21 轮的检查，在旧实现上失败。修复后 focused unit 237 项、typecheck、build、完整 renderer UI gate（含 Credits）通过；滚动锚点、键盘聚焦/释放、原生文本选择、展开工具和图片预览断言均保留。

开发失败记录不被最终通过抹掉：初始基准 fixture 使用旧 archive version 和错误的事件 kind，按生产合同修正后才建立基线；早期完整 UI gate 在 session-capability fixture 失败，包含缺失 remote handler 及 LLM 图表 tooltip 超时。冻结控制也出现 tooltip 超时，另一轮通过，原因未完全确定，本任务未改该 fixture。当前 App 一次重放还遇到并行流式投影改动的 `firstChanged` 渲染错误；确认旧构建与修正后的源码不同后重新构建，最终重放通过。日志保留在 `/tmp/scry-session-round1-*.log` 和 `/tmp/scry-session-round1-*.json`，源码快照位置记录在 `/tmp/scry-perf-round1-source-path.txt`。

限制：这是离线合成历史的本地窗口化验收，不是线上 p75、真实 Provider 或已安装 App 的性能承诺。20 轮阈值、4 轮预挂载和 1200px overscan 是当前有界策略，不声称全局最优。若真实使用显示短而重的历史仍卡顿，或窗口化出现空白/锚点问题，先扩展相应数据集与原生交互回归，再调整挂载策略；若 shell/历史数据本身成为瓶颈，按上文升级页缓存，不能直接截断证据。

## 第二轮：历史装载阶段拆分与幂等最近目录更新

扩展入口，默认仍运行第一轮的 `markdown` 场景：

```bash
npm run build
for scenario in short markdown short-heavy paged; do
  node scripts/session-open-bench.mjs "$scenario"
done
```

场景分别为 20 轮轻量 Markdown、40 轮重 Markdown、20 轮重 Markdown、120 轮分页历史。每条回答分别有 1、32、32、2 段 Markdown；仍使用生产支持的聚合 archive 文件，分页场景会原生点击“加载更早轮次”直至恢复全部 120 轮，不把完整读取的聚合文件误称为源级分页。每次重启隔离 App，保留两个会话的首次打开样本 `firstOpens`，随后统计 12 次交替打开；首次打开不代表 OS 文件缓存冷态。新增快速 A→B 选择隔离、实际历史总数/分页状态及跨选择草稿保留检查。禁用 Provider，真实运行中 Provider 切换仍未验收；现有 background/renderer fixture 的运行中相邻路径另通过 UI gate 验证。

本轮冻结包含已有 renderer 会话缓存及其他 WIP 的源码，不新增第二套缓存。分阶段计时发现此前 `merge` 把项目记录更新也计算在内：典型归档读取约 5.6 ms、纯合并约 0.1 ms，`rememberProject` 则约 43–60 ms。新增 `native_history`、`selection`、`project_remember`、`merge_turns` 检查点，旧 `merge` 现在只覆盖 Provider enrichment 和 notice 处理。

最小修复位于 `createRecentFoldersStore.push`：最近目录列表未变时，不再替换 primary；备份若不是当前 primary 的有效副本，仍先走原有原子写入/fsync 刷新备份。主文件恢复路径、实际顺序改变、去重和 8 项上限保持原行为。项目 `lastOpenedAt` 仍按每次打开持久化；不靠降低 durability 或删除 recency 语义换取收益。

macOS arm64 / Node 24.18.0 / Electron 42.10.1 / App 0.2.186，以原实现 → 修复 → 修复 → 原实现（ABBA）运行四个场景；固定源码只替换这一处 recent-folder 实现。表内数字为两次执行各自的 warm-path 中位数：

| 场景 | 打开耗时：原实现 → 修复（ms） | `project_remember`：原实现 → 修复（ms） |
| --- | --- | --- |
| short | 100.2 / 105.6 → 67.0 / 69.4 | 43.0 / 44.2 → 20.4 / 21.8 |
| markdown | 140.2 / 153.6 → 141.8 / 112.5 | 60.5 / 45.5 → 27.6 / 25.6 |
| short-heavy | 309.7 / 304.9 → 305.7 / 267.7 | 45.2 / 39.8 → 30.1 / 23.7 |
| paged | 97.3 / 97.6 → 73.7 / 65.5 | 45.4 / 48.0 → 22.1 / 21.9 |

最近目录的持久化阶段稳定减少；短历史和分页打开也改善。重 Markdown 的总耗时仍受 renderer 和调度波动影响，第一组 markdown 对照甚至略慢，不能声称所有场景统一加速。20 轮重 Markdown 仍有约 207–228 ms renderer 脚本耗时：它未超过当前窗口化阈值，是下一轮候选问题，本轮不混入另一处优化。

验证：新增 3 个持久化场景，证明重复选择不替换文件、备份先刷新且可修复、坏 primary 可从 backup 恢复、双坏仍显式失败，以及同首目录的过长/重复列表仍规范化。关键回归在旧实现上因 primary inode 被替换而失败。最终 focused unit 5 文件 / 88 项、typecheck、build 和完整 renderer UI gate（含 Credits）通过。当前工作区构建期间源码摘要未变化，四个场景重放均通过；打开中位数分别为 74.2、112.2、286.6、65.3 ms，属于集成验证而不是冻结对照归因。

原始样本、trace、失败对照和检查日志在 `/tmp/scry-round2-*.json`、`/tmp/scry-round2-*.log`；冻结源码位置在 `/tmp/scry-perf-round2-source-path.txt`。每次基准重验完整构建产物摘要，并确认测试 App 及已登记子进程退出后删除临时 HOME/workspace/userData。未安装、未发送真实 Provider 请求。
