# 01 · 基础：token 与清理

只动 CSS 与少量 TS 常量。目标是让全应用的时长和曲线统一，去掉网页感最强的悬停抬升，并让「减弱动态效果」不再退回硬切。本步不新增任何入场或出场动画。

## 要做

1. **新增 `src/renderer/motion.css`**，内容为 `../brief.md`「动效 token」中的变量。在 `src/renderer/main.tsx` 中于 `import './styles.css'` 之后立即导入（早于 analytics-evidence / inventory-evidence / session-evidence / codex-alignment）。`styles.css` 中原有的 `--ease-out` 删除，改由 motion.css 定义（值不变）。
2. **新增 `src/renderer/motion.ts`**：导出 `MOTION = { durMicro: 100, durFast: 160, durBase: 220, durSlow: 300, easeOut, easeStruct, easeExit }` 与 `prefersReducedMotion(): boolean`、`subscribeReducedMotion(cb): () => void`。新增 `motion.test.ts`：读取 `motion.css` 源文本，断言每个 CSS 变量与 `MOTION` 中的值一致。
3. **替换散落的时长与曲线**：`src/renderer/**/*.css` 中的 `transition` / `animation` 声明，按用途改用 token：
   - 只变颜色、底色、描边、透明度的悬停与按下 → `var(--dur-micro) linear`
   - 浮层、菜单出现 → `var(--dur-fast) var(--ease-out)`
   - 宽度、`grid-template-rows`、位置 → 对应档位 + `var(--ease-struct)`
   - 旋转加载、扫光等循环动画保持原样（它们不是过渡）
   - `SidebarActivity.tsx` 中硬编码的 `420` 与曲线改用 `MOTION.durSlow` / `MOTION.easeStruct`
4. **删除悬停 / 聚焦抬升**：所有 `transform: translateY(-1px)` / `translateY(-2px)` 用于 `:hover`、`:focus-within`、`.on` 等状态的规则（`codex-alignment.css` 约 1187、2091、2127、2206、2322、2360、2376 行，以及 `styles.css`、`inventory-evidence.css`、`session-evidence.css` 中同类规则）。只删位移；底色、描边、阴影变化保留。相应 `transition` 中去掉 `transform`。不要动用于定位的 `translateY(-50%)`。
5. **重写减弱动态效果**：替换 `styles.css` 约 8076 行的全局 `@media (prefers-reduced-motion: reduce)` 规则为：
   - 所有元素 `animation-duration` 与 `transition-duration` 不再一刀切为 0；改为：`transform`、`translate`、`scale`、`width`、`height`、`grid-template-rows` 不过渡；`opacity`、`color`、`background-color`、`border-color` 允许 120ms 线性过渡。
   - 循环装饰动画（`sb-running-spin`、`sb-activity-sweep`、`skeleton-shimmer`、`welcome-rescan-spin`、`usage-spin`）按原规则停止或降级，保持现有行为。
   - 其余文件中零散的 reduced-motion 规则（`codex-alignment.css` 两处、`inventory-evidence.css`、`session-evidence.css`、`analytics-evidence.css`、`sidebar-activity.css`）检查后与新规则一致，删除重复。
6. **标签指示条**：侧栏「项目 / 动态」(`.sb-view-tabs`) 与右侧 surface 标签若当前用边框或伪元素随选中项跳变，改为一个独立指示条，用 `transform: translateX()` + `var(--dur-base) var(--ease-struct)` 过渡；标签文字颜色无过渡（选中立刻生效）。若现有结构无法不改 DOM 实现，只做 CSS 能做的部分，并在 `progress.md` 说明，留到 04。

## 不要做

- 不新增入场、出场、页面切换动画（02–04 的事）。
- 不破坏 `performance-style.test.ts` 已有的合同：常驻指示器不用无限动画、骨架扫光只动 `transform`、页面隐藏时暂停装饰动画（`animation-play-state: paused !important`）。
- 不改颜色、字号、间距、圆角、阴影的取值。

## 验收

- [ ] `rg -n "transition:[^;]*\b(1[0-9]{2}|2[0-9]{2})ms" src/renderer --glob '*.css'` 只剩有注释说明理由的条目（在 `progress.md` 列出）。
- [ ] `rg -n "translateY\(-[12]px\)" src/renderer --glob '*.css'` 无结果。
- [ ] `npm run test:unit -- src/renderer/motion.test.ts src/renderer/performance-style.test.ts src/renderer/sidebar-activity.test.ts` 通过；`npm run typecheck:web`、`npm run build` 通过。
- [ ] 隔离 Electron fixture（复用 `scripts/session-capability-ui-smoke.mjs` 的机制，新增 `--motion-tokens-only`）：在真实 CSS 下断言 ① `getComputedStyle(document.documentElement).getPropertyValue('--dur-slow')` 为 `300ms`；② 悬停工具卡与发送按钮后 `transform` 为 `none`；③ 用 Electron 的 `emulateMedia` 或等效方式开启 `prefers-reduced-motion: reduce` 后，侧栏「动态」重排不产生 `transform` 动画，而颜色过渡仍为 120ms。把本步 CSS 改回旧值重跑，该检查须失败一次（作为对照，写进 `progress.md`）。
- [ ] `npm run test:renderer:ui` 通过。
- [ ] test 实例中深色、浅色各检查：侧栏、工具卡、composer、分析页悬停无位移；标签切换指示条滑动。
- [ ] 本步只改 CSS 与常量，不涉及 IPC 与数据路径，不需要 `performance:measure`；若改动触及 `performance-paths.json` 中 `sources` 列出的文件，则照常测量。
