# 02 · 结构过渡：View Transitions

让页面、会话、主题、面板与侧栏的切换有过渡。核心是一个小封装：状态仍然同步提交，浏览器负责截取前后快照并合成过渡，不让 React 逐帧重排。

## 要做

### A. 封装 `src/renderer/view-transition.ts`

```ts
export type TransitionKind = 'page' | 'session' | 'theme' | 'pane'
export function runViewTransition(kind: TransitionKind, commit: () => void): void
```

- `document.startViewTransition` 不存在、`document.hidden`、或调用方在测试环境 → 直接 `commit()`，不报错。
- 系统开启减弱动态效果（`prefersReducedMotion()`，来自 01 的 `motion.ts`）→ `kind` 一律按 `'fade'` 处理。
- 已有过渡在进行 → 先 `skipTransition()`，再开始新的（可打断，原则 4）。
- 回调里用 `flushSync(commit)` 同步提交；在 `documentElement.dataset.vt` 写入 kind，`finished` 后清除（只清自己写入的那次）。
- `commit` 抛错时必须让错误照常冒泡到调用方（不能被过渡吞掉），并清除 `dataset.vt`。
- 单测覆盖：无 API 直接提交、减弱动效映射为 fade、连续两次调用会 skip 前一次、commit 抛错会冒泡。

### B. 过渡样式（写在 `motion.css`）

```css
::view-transition-old(root), ::view-transition-new(root) { animation: none; }
::view-transition-group(page) { animation-duration: 0s; }
html[data-vt="page"]::view-transition-old(page)    { animation: vt-out 110ms var(--ease-exit) both; }
html[data-vt="page"]::view-transition-new(page)    { animation: vt-rise 240ms var(--ease-out) both; }
html[data-vt="session"]::view-transition-old(page) { animation: vt-out 110ms var(--ease-exit) both; }
html[data-vt="session"]::view-transition-new(page) { animation: vt-in 180ms var(--ease-out) both; }
html[data-vt="theme"]::view-transition-new(root)   { animation: vt-in 260ms ease both; }
html[data-vt="fade"]::view-transition-old(*)       { animation: vt-out 120ms linear both; }
html[data-vt="fade"]::view-transition-new(*)       { animation: vt-in 120ms linear both; }
@keyframes vt-out  { to   { opacity: 0 } }
@keyframes vt-in   { from { opacity: 0 } }
@keyframes vt-rise { from { opacity: 0; transform: translateY(6px) } }
```

`view-transition-name: page` 只给**主内容区**（顶栏之下、包含转录 / 分析 / Meta Prompts / 远程内容与 composer 的那一块）；侧栏、顶栏、右侧面板不命名。名字必须全文档唯一，同一时刻只有一个元素持有。

### C. 接入点

| 场景 | 位置 | kind |
| --- | --- | --- |
| 页面切换 | `App.tsx` `changeView()`：在未保存确认通过**之后**，把 `setView(next)` 包进 `runViewTransition('page', …)` | page |
| 会话转录替换 | 打开历史会话时，`session.replaceWithParsedSession`（及等价的转录替换）那一次提交。**不要**包选中会话的那次点击——侧栏高亮必须立刻生效 | session |
| 新建会话 | `newConversation()` 里已有的 `flushSync(() => { … session.clearTurns(); setView('chat') })` | session |
| 主题 | `theme.ts` `applyTheme()` 的调用方（用户在设置中切换主题时；启动时首次应用主题不做过渡） | theme |
| 面板 / 侧栏 | `toggleOverviewPanel()`、右侧面板最大化、`sidebarPane` 的折叠与展开 | pane（见 D） |

### D. 面板与侧栏：先做实验，再接入

宽度变化会让转录重新排版，最可能出现掉帧。先做实验，结论写进 `progress.md`，再决定方案：

1. **方案 V（首选）**：给侧栏、主内容区、右侧面板各自命名（`sidebar`、`page`、`surface`），过渡只发生在快照上：
   ```css
   html[data-vt="pane"]::view-transition-group(*) { animation-duration: 300ms; animation-timing-function: var(--ease-struct); }
   html[data-vt="pane"]::view-transition-old(*) { display: none; }
   html[data-vt="pane"]::view-transition-new(*) { animation: none; height: 100%; width: auto; object-fit: none; object-position: left top; }
   html[data-vt="pane"]::view-transition-new(surface):only-child { animation: vt-slide-in 300ms var(--ease-struct) both; }
   ```
   （`vt-slide-in`：从 `translateX(100%)` 到 0；侧栏出现对称处理。实验中按实际效果调整，但时长与曲线不变。）
2. **方案 F（退路）**：面板本身 `transform: translateX()` 滑入 / 滑出 300ms，正文在过渡开始时一次改宽，不逐帧变化。
3. 实验方法：用现有隔离 Electron fixture 载入一个长转录（≥ 300 轮，或仓库现有最大的 fixture），在 1280×800 窗口里开关右侧面板 10 次，每次记录过渡期间每帧间隔（`requestAnimationFrame` 时间差，或 `PerformanceObserver` 的 `long-animation-frame`）。达标线：过渡期间超过 25ms 的帧 ≤ 1 个 / 次（60Hz）。两个方案都测，选达标且观感更接近规格的那个。毫秒测量按 `CLAUDE.md`「测速纪律」串行执行并注明机器负载。实验脚本作为测量代码单独提交。

## 不要做

- 不改 `changeView()` 的确认逻辑与返回值；不改会话选择的序号 / `isCurrent` 竞争保护。
- 不在流式更新路径里调用 `runViewTransition`。
- 不给列表行、消息、工具卡命名 `view-transition-name`。

## 验收

- [ ] `view-transition.test.ts` 通过；`npm run typecheck:web`、`npm run build` 通过。
- [ ] 隔离 Electron fixture 新增 `--structure-only`：① 切到「分析」时，`document.getAnimations()` 中存在作用于 `::view-transition-new(page)`、时长 240ms 的动画；② 过渡进行中点击侧栏另一项，最终状态是后点击的那个，无报错；③ 过渡期间点击侧栏会话行，点击确实生效（证明过渡没有吞掉输入）；④ 开启减弱动效后，相同操作只有 120ms 的透明度动画；⑤ 选中会话后侧栏高亮在同一帧出现（不等待历史加载）。
- [ ] 面板实验数据与方案选择写进 `progress.md`。
- [ ] `npm run performance:measure -- --scenario navigation` 与 `--scenario history`（场景名以 `scripts/performance-paths.json` 为准）；每个 `worse` 写明原因。
- [ ] `npm run test:renderer:ui` 通过。
- [ ] test 实例深浅主题各检查：切分析 / Meta Prompts / 远程、切会话、新建会话、切主题、开关面板、最大化面板、折叠侧栏；未保存远程文件时切页的确认框仍先出现，取消后不发生过渡。
- [ ] 通过后 `npm run install:mac:dev`。
