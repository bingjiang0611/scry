# 04 · 列表：首屏、增删、折叠、流式

## 要做

### A. `src/renderer/hooks/useFlipList.ts`

从 `components/SidebarActivity.tsx`（约 52–80 行的 `useLayoutEffect`）抽出位置过渡逻辑，保持原有语义：

- 按 `data-motion-key` 找到行；**先读取全部位置**，再统一写动画（不交替读写布局）。
- 被打断时从当前位移继续（沿用现有用 `getComputedStyle(...).transform` 读取当前位移的做法）。
- 新出现的行：`translateY(-4px)` + 透明度淡入，220ms `--ease-out`；位置变化的行：300ms `--ease-struct` 平移。
- 减弱动效：不播任何位移，直接到终点；媒体查询变化时取消进行中的动画。
- 只作用于有上限的列表（≤ 40 个可见节点）；虚拟化列表只对可见行生效。
- `SidebarActivity` 改为使用这个 hook，原有的「指针按住不漂移」逻辑留在组件里。现有 `sidebar-activity.test.ts` 与 `--sidebar-activity-only` smoke 必须继续通过。

接入：侧栏项目视图的会话列表（`Sidebar.tsx`）、提示队列、后台任务（`BackgroundWorkPanel.tsx`）。删除的行直接移除，其余行平移收拢。

### B. 列表首屏错开

- 通用类 `.motion-stagger`：子项 `animation: row-in var(--dur-base) var(--ease-out) backwards; animation-delay: calc(min(var(--i), 10) * 16ms)`；`row-in` 为透明度 + `translateY(4px)`。组件给前 10 项写 `style={{ '--i': index }}`。
- 只在列表**首次挂载**时加这个类；入场结束后（`durBase + 10 × 16ms` 后）移除，之后新增的项交给 A 处理，刷新、轮询、排序不重播。
- 接入：`AnalyticsView.tsx` 的主要表格、`Modals.tsx` 中技能 / MCP / LLM 性能的列表、`MetaPromptsView.tsx` 的卡片。
- 减弱动效：整个列表一次 120ms 淡入，不错开。

### C. 折叠展开

- 项目分组（`Sidebar.tsx`）、技能详情（`ChatTurn.tsx` 的 `si-head` / `expanded`）、工具详情：用 `grid-template-rows: 0fr → 1fr`，展开 240ms `--ease-struct`，收起 180ms `--ease-exit`；箭头图标同步旋转，替换「换图标」的做法。
- 内容不常驻 DOM：展开时挂载；收起时保持挂载到收起动画结束再卸载（可复用 03 的 `usePresence`）。收起后的区域对读屏与 Tab 不可见。
- `<details class="thinking">`：用 `::details-content` + `interpolate-size: allow-keywords`（Chromium 已支持）做高度过渡，不改成自制折叠。
- 长内容（例如超过 40 行的工具输出）不做高度动画，只做 160ms 淡入。

### D. 流式新块

- 运行中的轮次里**首次出现**的工具卡、Hook 行、轮次指标：180ms 淡入 + `translateY(4px)`。
- 打开历史会话、从缓存恢复、切换会话时一律不播（需要一个「本轮是否在运行中且该项是在挂载后才加入」的判断，不能只看是否首次渲染）。
- 正文逐字输出不加动画。贴底跟随保持即时；`chat-scroll.ts` 中只有用户触发的一次性跳转（例如「回到底部」）用 `behavior: 'smooth'`。

## 不要做

- 不改列表的数据、排序规则、分页与上限。
- 不给长转录做任何高度或位置动画。

## 验收

- [ ] `useFlipList` 单测（可用 jsdom 模拟 `getBoundingClientRect` 与 `animate`）：先读后写、打断续接、减弱动效无动画。
- [ ] `sidebar-activity.test.ts`、`render.test.tsx`、`background-work.test.tsx`、`MetaPromptsView.test.tsx` 等受影响单测通过；`npm run typecheck:web`、`npm run build` 通过。
- [ ] 隔离 Electron fixture 新增 `--lists-only`：① 打开分析页，前 10 行动画 delay 依次相差 16ms，第 11 行无 delay；② 触发一次数据刷新，没有任何行重播入场；③ 侧栏新增会话时，其余行有 300ms `transform` 动画；④ 打开含 50 个工具卡的历史会话，`document.getAnimations()` 中没有工具卡的入场动画；运行中追加 1 个工具卡，只有它有 180ms 入场；⑤ 折叠项目分组后，组内容在动画结束后从 DOM 移除；⑥ 减弱动效下以上都没有 `transform` 动画。
- [ ] `node scripts/session-capability-ui-smoke.mjs --sidebar-activity-only` 仍通过；`npm run test:renderer:ui`、`npm run test:background-ui` 通过。
- [ ] `npm run performance:measure -- --scenario history` 与 `--scenario stream`（场景名以 `scripts/performance-paths.json` 为准）；每个 `worse` 写明原因。
- [ ] test 实例深浅主题各检查：侧栏展开 / 收起项目、新建会话、分析页首屏、技能 / MCP 弹窗列表、Meta Prompts、一次真实流式输出（用 fixture 或临时工作区，不在开发仓库驱动真实 Agent）。
- [ ] 通过后 `npm run install:mac:dev`。
