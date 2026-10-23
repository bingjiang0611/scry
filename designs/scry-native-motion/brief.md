# Scry 原生动效 · 2026-10

## 任务

用户反馈：Scry 在 macOS 上「不丝滑」，切换页面、展示列表时缺少过渡，看着不舒服。目标是让桌面 App 用起来像原生 macOS 应用一样顺。

本目录是交给执行 Agent 的完整规格。执行 Agent 按 `steps/` 逐步实现，每步结束推送到分支 `design/native-motion` 并在 `progress.md` 登记，由设计方核验后再进入下一步。

设计稿画布（私有，仅供人工对照手感，执行 Agent 不需要也打不开）：https://claude.ai/artifact/5XWQFqz4RkknYSKdheHYUo 。画布顶部可切换「当前 / 新版」「慢放 ×4」「减弱动态效果」「深 / 浅」。本文件是唯一权威规格；画布与本文件冲突时以本文件为准。

## 约束

- **H1 只改表现层。** 不改交互流程、信息结构、文案、快捷键、焦点顺序；不改证据语义（`exact / estimated / inferred / partial / disabled / unavailable / unknown`）。
- **H2 状态先于动画。** 点击后的状态（选中会话、`setView`、开关面板、切标签）在同一帧提交；动画只是装饰，代码里不得 `await` 动画后再改状态，也不得因动画拦截下一次点击。唯一例外是「出场」：弹窗、浮层、折叠收起可以先播完出场（≤160ms）再卸载 DOM，但期间新的交互照常生效。
- **H3 证据不演戏。** 数字不做滚动计数；刻度条、占用条不从 0 长出来；`unknown`、`unavailable`、`—` 不加任何动画；不让缺失看起来像「正在加载」。
- **H4 性能。** 只对 `transform` 和 `opacity` 做动画；高度动画只用于不超过 40 行的局部容器，长转录内不做高度动画、不做逐帧重排。遵守 `CLAUDE.md`「性能是默认要求」与「遵守性能闭环」。
- **H5 不引入依赖。** 不加 framer-motion、react-spring 等动画库；使用 CSS、Web Animations API 与现有代码。不使用原生 View Transitions：其更新回调异步执行，且转场期间被捕获的区域会吞掉首次点击（02 实测，见 `progress.md`）。
- **H6 安全边界不动。** 不为动画放宽 CSP、sandbox、contextIsolation，不新增 IPC。

## 现状（2026-10-22，基于 `531e88c`）

- 时长散落：`transition` 声明约 40 处，时长混用 120 / 130 / 140 / 150 / 160 / 180 / 240ms；曲线只有 `styles.css` 的 `--ease-out`。
- `@keyframes` 共 6 个，其中入场类只有 `surface-menu-in`（150ms）。
- 页面切换：`App.tsx` 的 `changeView()`（约 2038 行）直接 `setView`，条件渲染硬切。
- 会话切换：`ChatView.tsx` 约 616 行在 `sessionLoading` 为真时立即插入「正在加载会话历史」块；读取很快时也会闪一下。
- 弹窗：`components/Modals.tsx` 的 `ModalShell` 被所有弹窗共用；挂载即出现，卸载即消失。
- 面板与侧栏：`App.tsx` 约 2598 行通过 `has-right-panel / right-panel-hidden / right-panel-maximized / sidebar-collapsed` 类切换 `.app` 栅格列，瞬间变化。
- 列表：只有 `components/SidebarActivity.tsx`（约 52–80 行）用 FLIP 做了位置过渡（420ms）。
- 悬停抬升：约 10 处 `translateY(-1px / -2px)`，集中在 `codex-alignment.css`（1187、2091、2127、2206、2322、2360、2376 等行）。
- 减弱动态效果：`styles.css` 约 8076 行的全局规则把所有 `transition` 设为 `none`、动画时长设为 0.01ms，开启后回到硬切。

行号会漂移，以选择器和函数名为准。

## 动效 token

新增 `src/renderer/motion.css`，在 `main.tsx` 中于 `styles.css` 之后、其他皮肤之前导入。保留现有 `--ease-out` 的值不变。

```css
:root {
  --dur-micro: 100ms;   /* 悬停底色、按下、焦点环；线性 */
  --dur-fast: 160ms;    /* 菜单与浮层出现、tab 内容淡入；所有出场 ≤ 此档 */
  --dur-base: 220ms;    /* 页面内容切换、列表行进入、折叠展开 */
  --dur-slow: 300ms;    /* 侧栏 / 面板宽度、弹窗入场、列表重排位移 */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);     /* 入场 */
  --ease-struct: cubic-bezier(0.32, 0.72, 0, 1);  /* 尺寸与位置变化 */
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);        /* 出场 */
}
```

JS 侧（WAAPI、View Transitions）读同一套值：新增 `src/renderer/motion.ts` 导出同名常量，并提供 `prefersReducedMotion()`（基于 `matchMedia`，可订阅变化）。CSS 与 TS 的值由一个单测互相核对，避免漂移。

幅度：位移 ≤ 8px（页面 6px、行 4px）；缩放 ≥ 0.97，仅用于弹窗与浮层；错开 16ms，最多 10 项，第 11 项起不错开。不使用回弹。

## 原则

1. **点击立刻生效**：选中、勾选、标签文字没有过渡（`--dur-0`）。
2. **只交代空间变化**：出现、消失、换位、改尺寸时才动；悬停不位移，只换底色或描边。
3. **出场比入场快**：约为入场的 2/3，只淡出，不远移。
4. **可打断**：过渡中再次触发，直接跳到新状态（`skipTransition()` / 取消 WAAPI 动画后从当前位置继续）。
5. **快于 150ms 不显示加载态**：旧内容留在原地；超过 150ms 才淡入顶部 2px 加载条。
6. **刷新不重播**：列表入场只在首次挂载时播放；轮询、增量刷新、排序变化走 FLIP，不重播入场。
7. **减弱动态效果 = 淡化，不是关闭**：位移、缩放、宽度动画、错开全部去掉，统一换成 120ms 线性淡入淡出；颜色过渡与加载指示保留；FLIP 直接跳到终点。

## 逐场景规格

| # | 场景 | 新版 | 实现 | 步骤 |
| --- | --- | --- | --- | --- |
| 1 | 页面切换（会话 / 对话 / 分析 / Meta Prompts / 远程） | 侧栏、顶栏不动；新页 240ms 淡入并上移 6px（out）；旧页即时移除 | 实时 DOM：`structural-motion.ts` 先 `flushSync` 提交，再对 `.main-content` 播 WAAPI 入场（2026-10-23 用户批准，取代 View Transitions） | 02 |
| 2 | 切换会话 | 选中行立刻高亮；读取 ≤150ms：旧转录留到新转录就绪，180ms 交叉淡入（不上移），全程不出现加载 UI。读取 >150ms：旧转录 120ms 淡出（不能让上一个会话的内容长时间顶着新会话的标题），顶部 2px 加载条与原加载说明淡入 | 换会话时的那次转录替换播 180ms 透明度入场（实时 DOM；同一会话的刷新不播）（02）；`useDelayedFlag(sessionLoading, 150)`（05） | 02、05 |
| 3 | 右侧面板开关 / 最大化 | 面板 300ms（struct）滑入 / 滑出并淡入淡出；正文一次改宽，不逐帧重排 | 方案 F：`pane-motion.ts`，布局只提交一次，只动面板 `transform / opacity`（V 方案实测掉帧，未采用） | 02 |
| 4 | 侧栏折叠 | 同面板；`sidebar-collapsed` 下交通灯旁顶栏留白同步过渡 | 同上 | 02 |
| 5 | 主题切换 | 即时切换（2026-10-23 用户批准，取消整窗交叉淡化） | — | 02 |
| 6 | 弹窗 | 遮罩 180ms 淡入；面板 `scale(0.97) translateY(6px)` → 原位 260ms（struct）；关闭 150ms 淡出到 0.98（exit）后再卸载 | `ModalShell` 加 presence：关闭先播出场再调用 `onClose`；焦点陷阱、焦点归还不变 | 03 |
| 7 | 菜单、浮层、悬停卡 | 160ms 从触发点方向展开（`transform-origin` 对准锚点）；出场 100ms 淡出 | CSS + 共用 `usePresence` | 03 |
| 8 | 折叠展开（项目分组、工具详情、思考块、技能详情） | 展开 240ms（struct）、收起 180ms（exit）；箭头同步旋转；展开后新行错开淡入 | `grid-template-rows: 0fr → 1fr`（`inventory-evidence.css` 约 1321 行已有先例） | 04 |
| 9 | 列表首屏（分析表、技能 / MCP 列表、Meta Prompts、LLM 性能） | 前 10 行错开 16ms，淡入并上移 4px | 行上写 `--i`，CSS 计算 `animation-delay`；只在首次挂载时加入场类 | 04 |
| 10 | 列表增删与重排（侧栏会话、提示队列、后台任务） | 新行从上方 4px 淡入；其余行 300ms 平移让位；删除的行直接移除，其余行平移收拢（为淡出保留已删除行的 DOM 不值得这份复杂度） | 从 `SidebarActivity.tsx` 抽出 `hooks/useFlipList.ts`（先读全部位置再统一写；支持打断；遵守减弱动效） | 04 |
| 11 | 流式输出 | 运行中新出现的工具卡、Hook 行、轮次指标 180ms 淡入并上移 4px；打开历史会话时不播；正文逐字不加动画；贴底跟随保持即时，只有「回到底部」这类一次性跳转用平滑滚动 | 只对轮次运行中首次出现的 key 播入场；不改按帧合并路径 | 04 |
| 12 | 标签页（侧栏 项目 / 动态、右侧 surface 标签） | 文字立刻变色；下划线 220ms（`--dur-base`）滑动（struct）；内容 160ms 淡入 | 指示条用 `transform`，不动 `left / width` | 01（CSS 部分）、04 |
| 13 | 悬停与按下 | 只换底色或描边，`--dur-micro` 线性；按下不缩放 | 删除抬升，统一 token | 01 |
| 14 | 窗口材质（可选） | 侧栏使用 macOS vibrancy | `BrowserWindow` `vibrancy: 'sidebar'`，侧栏透明底；重新核对对比度 | 06 |

## 验收（整体）

- 每步满足 `steps/NN-*.md` 的验收清单，并按 `CLAUDE.md` 的「UI 修复」「普通代码」要求验证。
- 涉及交互路径的步骤跑 `npm run performance:measure`（场景名以 `scripts/performance-paths.json` 为准，至少 `navigation`、`history`；动到流式时加 `stream`），报告每个 `worse` 的原因。
- 系统开启「减弱动态效果」时，没有任何带 `transform` 的动画在运行。
- 深色、浅色主题各在真实 App 看过一遍；截图不入库（可能含私人会话），在 `progress.md` 写明看了什么。

## 交付协议

见 `steps/README.md`。
