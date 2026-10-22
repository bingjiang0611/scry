# 批次 D：renderer transcript 与 App 重渲染（#8）

分支：`perf/d-renderer-transcript`（从 `perf/handoff` 的交接提交切出，只改本批范围）。先读 [README.md](README.md) 与 [review.md](review.md) #8，以及 `docs/performance-experiments/20261021-desktop-ui-fluidity.md`。

本条置信度最低：**先测，没有明显成本就放弃**，放弃是合格结果。

## 先测（单独提交）

1. **输入延迟**：在 200 / 1000 轮的已加载会话中，向输入框连续输入，记录每次按键触发的 `selectionchange` 回调次数与 handler 总耗时（L1 计数 + L2 毫秒）。可扩展 `src/renderer/performance.bench.tsx` 或现有 `scripts/session-performance-ui-smoke.mjs` 的隔离 Electron fixture。注意 CLAUDE.md：DOM/事件问题必须用隔离 Electron fixture，SSR 或程序化事件不能单独证明。
2. **流式期间 App 渲染**：流式输出时每秒 `App` 组件 render 次数与单次耗时（React Profiler 或计数器）。

## 改法方向

### D1 transcript 观察者合并

`src/renderer/components/ChatView.tsx:213-258` 每个 `TranscriptTurn` 各自注册 IntersectionObserver、MutationObserver、`focusout`、document 级 `selectionchange`。

- 改为 `ChatTranscriptTurns` 层共享一个 IntersectionObserver 与一个 `selectionchange` 监听，按元素分发；`selectionchange` 只重查“当前已挂载且不在视口”的轮次（通常是少数），而不是全部。
- 保留现有行为：聚焦、选区、展开（`aria-expanded`/`details[open]`）的轮次不得被卸载；高度测量与滚动锚定逻辑（`:198-212`）不变。

### D2（可选，视测量结果）App 流式重渲染

`useAgentSession` 在 `src/renderer/App.tsx:897`。若测量显示 App body 在流式期间成本显著，可把 `turns` 的订阅下沉到需要它的子树（例如以 external store + selector 方式），使 App 本身不随每帧 trace 重渲染。改动面大，**只在 D1 之后且数据支持时做**，并先在报告中说明方案再实施。

## 红线

- 证据展示语义不变：运行中、未完成、待回答问题的轮次始终挂载（`pinned` 逻辑）。
- 卸载时清理全部 observer/listener（CLAUDE.md renderer 护栏）。
- 不交替读写布局；不引入新的强制同步 layout。
- 不改 trace 合批（`applyTraceBatch`、`TraceOutputBridge`）——它们已经是增量的。

## 测试

`src/renderer/components/ChatTranscriptTurns.test.tsx`、`src/renderer/markdown-incremental.test.ts`、`npm run bench:renderer`、`node scripts/session-performance-ui-smoke.mjs`、`node scripts/chat-preview-ui-smoke.mjs`；提交前完整 `npm run test:renderer:ui`。真实 App 交互（选中文本、Tab 聚焦离屏轮次、展开工具详情后滚出视口）在 test 实例中重放并记录结果，不能验证的写“未验证”。

## 完成后

写 `reports/D.md`，push `perf/d-renderer-transcript`。不改 STATUS.md（由审查方维护）。
