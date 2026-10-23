# 批次 D · renderer transcript

状态：**待核验**。D1 已优化；D2 经测量放弃拆 App。完整 renderer UI 因改动前已复现的 workspace dirty 断言未全绿，不能标已核验。

## 改动与提交

| 项目 | 结果 | 证据 |
|---|---|---|
| D1 观察者/选择事件扇出 | 已优化；每条时间线 1 个 IO、1 个选择监听，只有挂载正文保留 disclosure 观察 | `src/renderer/components/ChatView.tsx`；优化 `3256e68` |
| D2 App 重渲染 | 放弃架构改动；输入不逐字重跑 App，流式 App body 的实测成本不足以支持拆 store | 200/1000 轮 App commit 与返回 JSX 前 body 计时，见实验 |
| 测量 | 新增独立 component / 全 App renderer 离线 profile，未缩小已有 fixture | `46d01e6`、`5e0a232`、`8bda3ff` |

生产基线 `bf92d04`；旧 ChatView 测量使用 `46d01e6` 的同一生产源码，其他生产文件未变。先提交测量，再提交优化；没有改台账、门限、sandbox、权限、Provider 或 recorder 语义。

完整实验、取舍、失败日志索引与交付身份：[20261023-renderer-transcript-observers.md](../../../performance-experiments/20261023-renderer-transcript-observers.md)。

## 前后数据

macOS 26.3.2 / Apple M1 / arm64 / 8 核，Node 24.18.0、Electron 42.10.1；隐藏独立窗口，临时 HOME/userData/sessionData，离线 bridge，不访问真实 Provider/用户会话。

| L1 指标 | 200 轮旧 → 新 | 1000 轮旧 → 新 |
|---|---:|---:|
| shell / 挂载正文 | 200/4 → 200/4 | 1000/4 → 1000/4 |
| component 全页最终 DOM | 417 → 417 | 1217 → 1217 |
| IntersectionObserver 实例 | 200 → 1 | 1000 → 1 |
| 轮次选择监听（不含 React） | 200 → 1 | 1000 → 1 |
| 轮次 MutationObserver | 200 → 4 | 1000 → 4 |
| 输入 30 字的 release 检查 | 6000 → 120 | 30000 → 120 |
| 10 次 Selection API 变化的 release 检查 | 2000 → 40 | 10000 → 40 |
| 输入导致历史 Assistant / Markdown commit | 0/0 → 0/0 | 0/0 → 0/0 |
| 30 流批次的 TranscriptTurn / Assistant commit | 30/30 → 30/30 | 30/30 → 30/30 |

卸载后 IO/MO/RO 均为 0，轮次选择监听为 0。没有删 shell，没有把检查移出计数窗口；空壳的无效检查不再执行，必要的观察者共用。

**L2 局部结果**：串行 App renderer profile 的负载 baseline 3.40→3.10、candidate 5.13→4.96，均 `highLoad=false`。1000 轮选择事件分发 p50/p95 **1.1/1.1 → 0/0.1ms**（0 是计时分辨率）。不能推出整体输入/流输出更快。

1000 轮 native driver 输入 round-trip p50/p95 **33.1/42.1 → 33.1/35.9ms**；流批次 **66.3/84.8 → 66.6/88.8ms**，流 p95 没改善。这些包含 IPC/rAF/两帧等待，不是 INP 或 App self-time；单次差异不作为收益或门禁。

D2 补测返回 JSX 前的 App body：1000 轮流阶段 p50/p95 **0.2/0.4 → 0.2/0.3ms**；负载 7.96→7.66 / 6.67→6.33，均未越过 8 核阈值。30 次输入期间 App commit **1→1**，Sidebar **0→0**；30 流批次期间 App **31→31**，Sidebar **1→1**。未证明架构拆分有足够收益，因此不做。

最早 component 测量负载超过 8 核阈值，其毫秒值不可信，只取 L1。L3 未验证：本批不安装，没有发布后日常样本。

### 重现命令

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs D-component -- node scripts/renderer-transcript-profile.mjs --controls
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs D-app -- node scripts/renderer-transcript-profile.mjs --controls --app
npm run performance:measure -- --compare bf92d04 --out /tmp/scry-D-measure-all
```

旧实现运行 profile 时不带 `--controls`。带 controls 的旧实现负对照已因选择扇出失败，候选在 200/1000 轮通过。新 profile 是独立测量/回归入口，没有冒充已有 work-counter 或升为 ratchet 门禁。

## 验证

| 命令/检查 | 结果 |
|---|---|
| focused `npm run test:unit --`（ChatTranscriptTurns、MarkdownImpl/Layout、turn-stream-projection、composer-drafts） | 5 files / 54 tests pass；含真实 Chromium Markdown/文件链接回归 |
| `npm run typecheck` | node/web 通过，交付前再次通过 |
| `npm run test:unit` | 298 files / 3699 tests pass；4 个既有 opt-in skipped；309.47s |
| `node scripts/session-performance-ui-smoke.mjs` | 原 277 会话、120 轮/3 页、20 流批次通过；滚动锚点、焦点、证据跳转、选区、展开工具、portaled 图片保持 |
| `npm run build` | 通过，App 0.2.219 测试构建 |
| `node scripts/electron-security-smoke.mjs --dev-pi-history-only` | 当前完整构建、独立 test 实例、真实 IPC 的 43 轮历史/旧页证据通过；无 Provider 执行 |
| `npm run performance:measure -- --compare bf92d04 ...` | 43 observations，ratchet passed，无 worse；42 项相同，1 项 read bytes 的小幅下降在原有重复波动内，不作为收益 |
| `npm run test:renderer:ui` | 未全绿，详见下文 |
| `git diff --check` | 通过 |

### 首次失败与后续处理

- full unit 第一次被外层工具 240s 截止打断，仍在推进、无失败摘要。确认进程已退出后，以足够外层预算执行完整套件，309.47s 通过。没有扩大任何用例期限。
- full renderer UI 首次因本地 SQLite 的 Node/Electron ABI 不一致在 Credits 失败。仅重建本 worktree node_modules 原生模块；再次运行时 Credits 通过。
- full renderer UI 随后在 chat-preview 的 workspace 编辑断言失败（预览更新，但 dirty=false）。候选源码和恢复旧 ChatView 的独立 chat-preview 均同样失败；未顺带修复无关 workspace fixture，也未删断言或跳过它。该入口后续脚本未执行，不能称全套通过。
- 独立测量开发中修正了 draft envelope、视口约束、Electron memory API、最后窗口销毁、App 场景 localStorage 隔离与额外 chat-scroll 观察者的合同。原始失败日志保留；最终负载和断言未缩减。
- 一次 timing lock 退出 75，未绕过。最初指定 `renderer.batch`/`compose.drafts` 的 measure 发现无 collector 而失败，改为全量已有 collector 后通过，没有补假数据。

主要日志：`/tmp/scry-D-unit-full-complete.log`、`/tmp/scry-D-renderer-full-rebuilt.log`、`/tmp/scry-D-chat-ui-baseline.log`、`/tmp/scry-D-session-ui-final.log`、`/tmp/scry-D-current-app.log`、`/tmp/scry-D-app-{baseline-frozen,candidate-fixed,body-baseline,body-candidate}.log`。计数结果在 `/tmp/scry-D-measure-all/`。

## 限制与交接

- 不宣称解决所有 App 大历史性能。1000 轮全 App renderer 仍约 40,438 DOM，出现过约 81–85ms 长任务；本批只收敛 transcript 观察者，未把全页成本无证据地归因给 App body。
- 未验证真实 Provider、前台 OS 焦点、日常输入、超过 1000 轮或 L3。没有修改这些合同。
- 未安装、未替换日常实例，未合入 main、不开 PR。遵守本批分支不安装的约定。
- 按用户本次明确要求，执行分支仅将 STATUS 的 D 行改为“待核验”，不代替审查方标“已核验”。
- 审查方：下一步核验 `3256e68` 及两种规模 profile；workspace dirty 失败由原测试 owner 单独跟进。若要集成，集成 owner 在 main 合入后再构建/安装并采集 L3，无需本批扩大改动。

## 核验意见（审查方，2026-10-22）

结论：**D1 已核验；D2 放弃有证据支持，接受**。审查方未能在本会话重跑测试（网络策略拒绝 npm registry），依据是逐行读 `3256e68` 的 diff 与本报告的命令记录。

- 共享 IntersectionObserver 按元素分发，批内只取每个元素的最后状态，与原 `entries[entries.length - 1]` 语义一致；最后一个元素注销时断开。
- `selectionchange` 只在列表层注册一次，只对已挂载正文执行检查；空壳不能持有选区或展开状态，跳过它们不改变行为。
- 两个 effect 的声明顺序保证 `releaseOffscreen.current` 在选择 effect 读取前已赋值；`windowed` 变化时两者按序重跑。
- `pinned`（聚焦、选中、未完成、待回答）与高度测量、滚动锚定逻辑未改；卸载后 IO/MO/RO 与监听均为 0。
- D2：输入期间 App commit 1→1，流式 App body p50 0.2 ms。拆 store 的改动面大、收益未被证明，放弃是正确结论。
- 收益口径如实：L1 扇出大幅下降；L2 只在选择事件分发上可见，输入/流式 round-trip 没有改善，报告没有夸大。

无阻塞问题。
