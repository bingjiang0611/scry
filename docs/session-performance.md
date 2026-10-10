# 多会话性能边界

本次优化不改变 Provider 权限、工具证据、归档事实源或 renderer 隔离。

## 实现

- 侧栏使用 memo；事件回调保持身份稳定，并在触发时读取最近一次提交的状态。项目筛选和置顶排序仅在项目数据或搜索词变化时执行。
- Trace 索引按 immutable 数组身份复用，使用 WeakMap，不延长旧历史的生命周期。纯 text/thinking 增量不重新建立全部索引；新增身份、删除和权威正文替换仍维护去重与顺序。React snapshot 的数组复制仍然存在，不宣称整个更新变成 O(1)。
- Pi 历史采用 archive 源级分页，每页仍执行 Provider 的 turn-local model-context enrichment；读取旧页后重验会话 revision。Claude transcript 和 Qoder 全历史 reconciliation 保持原路径。缺失/损坏的 archive index 首次仍需要扫描重建；热索引只读取请求页的 turn 文件。
- 已加载轮次超过 80 时，保留轻量跳转 shell，仅挂载视口上下 1200px 内的正文。初始预挂载最新 40 轮；每个 shell 首次测量前使用 240px 估计高度。测量、卸载和再次挂载保持滚动锚点。选中、定位、运行、待回答、有焦点、原生文本选择或展开工具/图片预览的轮次不卸载。键盘聚焦 shell 会恢复完整内容；释放焦点或选择后可再次卸载。
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
