# 2026-10-22–23 · transcript 观察者收敛（批次 D）

## 结论与交付身份

- D1 **已优化**：选择事件不再遍历空壳；每条时间线共用一个 IntersectionObserver 和一个选择监听，仅挂载正文保留 MutationObserver。
- D2 **放弃拆分 App**：测到了重复执行，但没有测到足够的 App body 成本来支持架构重写。保留现有草稿订阅与逐轮 memo 边界。
- L1：1000 轮、30 次原生输入的轮次 release 检查 **30,000 → 120**。10 次原生 Selection API 变化 **10,000 → 40**。
- L2：离线 renderer 中，1000 轮选择事件分发 p50/p95 约 **1.1/1.1 → 0/0.1 ms**。0 是计时器分辨率下的观测，不代表没有工作。**不宣称整体输入或流式输出更快**。
- L3：未部署，无发布后日常样本。
- 原始生产基线：`bf92d04`（交接提交，生产源码基于 `531e88c`）。测量提交：`46d01e6`、`5e0a232`、`8bda3ff`；优化：`3256e68`。
- 合入：未合入 main。App 构建：`npm run build` 通过，0.2.219，仅测试用途；完整 build ID / 二进制 SHA 未登记，不能当作发布身份。构建时生产文件与 `3256e68` 相同（测试后恢复的候选文件逐字节比较通过）。
- 安装/生效：未安装，未替换 `/Applications/Scry.app`，未重启用户实例。baseline/candidate packaged build 与日常比较均 unavailable（未部署）。

## 选择方案

假设：空壳没有可保留的文本或展开内容。去掉它们的全局选择检查和 disclosure 观察，可使每次选择事件的工作量与挂载内容数相关，而不是历史总轮数。焦点进入、IO 可见性、已选择证据、未结束轮次和待回答问题仍独立保留正文。

| 视角 | 取舍 |
|---|---|
| 不做 | 不为空壳注册 selection/disclosure 工作，采用 |
| 只做一次 | 每条时间线共用 IO 与 document 监听，采用 |
| 提前做 | 不预挂载全部历史；会重新引入 Markdown 成本，否决 |
| 推迟做 | 正文挂载时才注册 disclosure/selection 检查，采用 |
| 换地方做 | DOM 依赖浏览器，移到 worker 不合适 |
| 更便宜 | 可见性按 Element 分派，采用 |
| 少做几次 | 一次 IO 回调只取每个 shell 的最后状态，采用 |
| 先显示 | 保持现有 shell/正文窗口，不改显示合同 |
| 数据结构 | Map 分派可见性，Set 只存挂载正文的选择检查，采用 |
| 换架构 | 外部会话 store / 拆 App：先测 body，自身成本不足，放弃 |

未探索：真实 Provider 高频批次、用户日常前台输入、超过 1000 轮、右侧证据面板的独立 DOM/长任务归因。没有新增缓存、worker、依赖或协议。

## 固定负载与方法

macOS 26.3.2 / Apple M1 / arm64 / 8 核，Node v24.18.0，Electron 42.10.1。1100×850 隐藏原生窗口；临时 HOME/userData/sessionData，sandbox/contextIsolation 开启、nodeIntegration 关闭，网络拒绝，窗口不激活。

新增 `scripts/renderer-transcript-profile.mjs` 与 `scripts/fixtures/renderer-transcript-profile.tsx`。两个独立场景：

1. 生产 SessionChatView，200/1000 轮，变高 Markdown，每轮一个回答，末轮运行中；生产 `applyTraceBatch` 合并流事件。
2. `--app`：生产 App + 最小离线 renderer bridge；原生坐标点击历史会话，真实草稿订阅、Sidebar、证据面板和 trace rAF 路径。**不等于真实 main/Provider 或日常 App 验收**。

每种规模固定执行：30 次 Chromium `insertText`、30 个流批次、10 次浏览器 Selection API 变化、React unmount。Vite 插件在生产组件内注入 layout-effect 计数（commit），并在原有 release 函数入口计数；不改生产代码来计数。App 另测函数入口到返回 JSX 之前的 body 工作，不包含 JSX 创建、子组件或 commit/layout。

选择事件用最前/最后两个测试监听包住生产 document listeners，避免逐回调计时本身制造 N 次开销。两个计时监听不计入监听数。所有资源数是活跃实例/监听数，不是构造调用次数。选择监听总数含 React 自己的 1 个。

延迟是 native dispatch 到值/commit 可见后再等两帧的 **driver round-trip**，含 IPC、rAF 和调度；不是纯输入事件时长、INP 或 Provider 首字。长任务是 Chromium 累积条目，异步投递不作因果归因。内存为 Electron renderer working set，单位 KiB，单次描述不作收益保证。

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs D-transcript -- node scripts/renderer-transcript-profile.mjs --controls
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs D-app -- node scripts/renderer-transcript-profile.mjs --controls --app
```

旧实现基线去掉 `--controls`。App baseline 测量期间只将 ChatView 恢复到 `46d01e6`；trap 恢复候选，之后 `cmp` 确认逐字节相同。其余生产代码未变。

## L1 前后对照

| 指标（component 场景） | 200 轮 baseline → candidate | 1000 轮 baseline → candidate |
|---|---:|---:|
| shell | 200 → 200 | 1000 → 1000 |
| 最终挂载正文 | 4 → 4 | 4 → 4 |
| 最终 DOM 节点 | 417 → 417 | 1217 → 1217 |
| IntersectionObserver 活跃实例 | 200 → 1 | 1000 → 1 |
| document selection listeners（含 React） | 201 → 2 | 1001 → 2 |
| MutationObserver 活跃实例 | 200 → 4 | 1000 → 4 |
| 30 次输入 release 检查 | 6000 → 120 | 30000 → 120 |
| 10 次 selection 变化 release 检查 | 2000 → 40 | 10000 → 40 |
| 输入触发 transcript/Assistant/Markdown commit | 0/0/0 → 0/0/0 | 0/0/0 → 0/0/0 |
| 30 个流批次的 TranscriptTurn / Assistant commit | 30/30 → 30/30 | 30/30 → 30/30 |

App 场景同样挂载 4 轮。另有 chat-scroll 的 1 个 MutationObserver 和 ResizeObserver，故 MutationObserver 总数为 **201/1001 → 5/5**。所有场景 unmount 后 IO/MO/RO 均为 0；只留下 React 的 document selection listener，后续窗口整体销毁。

减少的工作真的不再执行：空壳不订阅 selection/disclosure；IO 实例合并。不是搬到后台、另一个计数域或延迟到测量之后。必要的所有 shell、键盘焦点和原生选区均保留。

## L2 与 D2 决策

最早 component 基线/候选负载分别 22.78→21.34、17.39→16.80（8 核），`highLoad=true`。它们的毫秒值不可信，只用于 L1。

随后串行 App baseline/candidate：负载 **3.40→3.10 / 5.13→4.96**，均 `highLoad=false`：

| App 指标，毫秒 p50/p95 | 200 轮 baseline → candidate | 1000 轮 baseline → candidate |
|---|---|---|
| 10 次 selection 分发 | 0.2/0.3 → 0/0.1 | 1.1/1.1 → 0/0.1 |
| 30 次输入 driver round-trip | 32.9/34.6 → 33.1/34.7 | 33.1/42.1 → 33.1/35.9 |
| 30 次流批次 driver round-trip | 66.5/69.8 → 66.5/73.3 | 66.3/84.8 → 66.6/88.8 |
| renderer working set（KiB，非 p50/p95） | 316992 → 315088 | 457680 → 448592 |

流批次 p95 没有改善；本次没有减少流路径的 commit/工作量，不把较小的单次差异当作速度结论，也不以选择事件收益抵消它。此 round-trip 包含 rAF/驱动；没有足够稳定、独立证据把差异归因到改动。保留未验证状态，不升门禁、不宣称整体提速。

两种规模的 App commit：30 次输入期间 **1→1**（并非每字重跑 App）；Sidebar **0→0**；30 个流批次期间 App **31→31**、Sidebar **1→1**，包括后台刷新；历史正文仍未重渲染。Markdown 流 commit 约 53–55，受其原有采样定时影响，不作为精确门禁。

单独的 App body 计时补测（`8bda3ff`）：baseline 负载 7.96→7.66，candidate 6.67→6.33，均未越过 8 核阈值。流阶段 body p50/p95：200 轮 **0.2/0.3 → 0.2/0.3 ms**；1000 轮 **0.2/0.4 → 0.2/0.3 ms**。这只覆盖返回 JSX 前的逻辑，不是整棵树渲染。**不拆 App**：当前证据不足以让较大架构改动值回风险。

App 的 1000 轮场景仍有约 40,438 个全页 DOM 节点（transcript 仍只挂 4 轮），出现过约 81–85ms 长任务；不宣称解决了全 App 大历史规模。保留测量入口供审查方另立证据面板/打开历史实验，不能由“App 很大”直接归因或直接拆 store。

## 验证与失败记录

| 检查 | 结果 |
|---|---|
| focused 5 个测试文件 | 54 tests pass（ChatTranscriptTurns、MarkdownImpl/Layout、stream projection、composer drafts） |
| `npm run typecheck` | node/web 均通过，交付前再次通过 |
| `npm run test:unit` | 完整 298 files pass / 4 files skipped；3699 tests pass / 4 既有 opt-in skipped；309.47s |
| `node scripts/session-performance-ui-smoke.mjs` | 通过；277 会话、120 轮、3 页历史、20 流批次；滚动锚点、选区、键盘焦点、选证据、展开工具、portaled 图片、焦点释放均保留 |
| `npm run build` | 通过；只构建测试产物，不安装 |
| `node scripts/electron-security-smoke.mjs --dev-pi-history-only` | 当前构建、独立 test 实例通过；真实 IPC 的 43 轮交错历史、旧页 canonical tools/usage/attachments 与 native prefix；没有执行 Provider |
| profiler `--controls` | 200/1000 轮通过资源上限、无历史重渲染、卸载清理；旧实现负对照因 selection fanout 失败 |
| `npm run test:renderer:ui` | 未全绿，见下文；未删除断言/skip/修改测试期限 |
| `npm run performance:measure -- --compare bf92d04 --out /tmp/scry-D-measure-all` | 43 observations、默认重复次数、ratchet passed，无 worse；未修改台账/门限 |
| `git diff --check` | 通过 |

首次 full unit 外层工具 240s 截止时仍在正常推进，没有测试失败摘要；进程已退出。之后扩大的是外层命令运行预算而非任何测试期限，完整运行 309.47s 通过，保留第一次不完整日志。

full renderer UI 首先在 Credits 遇到本地 SQLite ABI 137/146 不一致。仅对本 worktree 的 node_modules 执行现有 electron-rebuild；Credits 随后通过。第二次 full UI 在 chat-preview 的既有 workspace 编辑 dirty 断言失败；独立 chat-preview 在候选和恢复旧 ChatView 时均报 **相同 dirty=false、预览已更新** 的失败。它位于本次未改的 workspace fixture，未顺带修改。full UI 在这里停止，后续整串脚本未由该入口执行，不能称全套通过。

开发测量脚本自身的失败也保留：draft 更新错用 envelope、fixture 未约束视口、误用 Electron memory API、销毁最后窗口后 app 提前退出；均在测量提交内修正。App 模式补测另修正了独立场景的 localStorage 草稿隔离，并按生产 chat-scroll 的额外观察者修正全 App 资源合同。一次 timing lock 被其他 agent 占用时退出 75，没有绕过锁；之后取得锁才补测。

最初按 `renderer.batch` / `compose.drafts` 运行 performance:measure 时发现它们没有 work-counter collector，命令明确失败；随后运行全量已有 collector 成功。43 项计数中 42 项相同，files.fixed-operations/io.read.bytes 最大值降 17 字节；其重复样本本身已有重叠波动（baseline 1227159–1227222，candidate 1227154–1227205），不归因于本次优化。新 browser profile 未注册为 ratchet 门禁，也未用别的 workload 替换旧指标；当前上限在可运行 `--controls` 回归中验证，升门禁须另做稳定性与相关性证据并获维护者批准。

## 证据与下一步

本机 `/tmp/scry-D-*.log` 保留首轮失败和成功日志；主要证据：`baseline-frozen`、`candidate`、`app-baseline-frozen`、`app-candidate-fixed`、`app-body-baseline`、`app-body-candidate`、`negative-control`、`unit-full-complete`、`session-ui-final`、`typecheck-final`、`renderer-full-rebuilt`、`chat-ui-baseline`、`current-app`；全量计数 JSON/比较在 `/tmp/scry-D-measure-all/`。fixture 自动回收临时目录/窗口，无遗留测试 App，未读取日常会话数据。

审查方下一步：核验 `3256e68` 的观察者生命周期及两种规模回归，再决定合入。workspace dirty 的既有失败交还原测试 owner 独立处理；本批不修改它。main 集成 owner 合入后按正式流程构建/安装，再收集 L3（≥30 样本、≥2 会话）。本批没有安装、发布或合入授权要求。
