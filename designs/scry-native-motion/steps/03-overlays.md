# 03 · 弹窗与浮层：入场与出场

所有弹窗共用 `components/Modals.tsx` 的 `ModalShell`，改它就覆盖设置、技能、MCP、LLM 性能等全部弹窗。浮层包括右侧 surface 的添加菜单（`RightSurfacePanel.tsx` 的 `.surface-menu`）、会话悬停卡（`SessionHoverCard.tsx`）以及其他 `role="menu"` 的弹出菜单。

## 要做

1. **`src/renderer/hooks/usePresence.ts`**：给「父组件一旦关闭就卸载」的元素一个短暂的出场窗口。
   - `requestClose(reason)`：把元素标成 `data-state="exit"`，在出场动画结束（`animationend`，并以 `exitMs + 80ms` 的计时器兜底）后再调用真正的 `onClose`。
   - 重复调用只生效一次；组件在出场中被卸载时清理计时器与监听。
   - 减弱动态效果下出场时长 120ms，只有透明度。
2. **`ModalShell`**：
   - 入场：遮罩 `opacity 0→1` 180ms；`.modal` 从 `opacity 0; transform: scale(0.97) translateY(6px)` 到原位，260ms `--ease-struct`。用 CSS `@keyframes` + `data-state="enter"`，挂载时生效。
   - 出场：关闭按钮、Esc、点击遮罩三条路径都改走 `requestClose`；遮罩 160ms 淡出，`.modal` 150ms 淡出到 `scale(0.98)`，`--ease-exit`。出场期间 overlay `pointer-events: none`，下面的界面可以立即接收点击（约束 H2）。
   - 焦点：焦点陷阱与关闭后焦点归还的行为不变。出场开始时就把焦点还给触发元素，不要等卸载。
   - 父组件直接把弹窗状态置空（非用户关闭）时照常立即卸载，不强求出场。
3. **菜单与悬停卡**：入场 160ms `--ease-out`，`transform-origin` 对准触发元素一侧（菜单在按钮下方就 `top right`/`top left`），`scale(0.97)` 起；出场 100ms 只淡出。`surface-menu-in` 改用 token。悬停卡保留现有的显示延迟逻辑，只加入场与出场。

## 不要做

- 不改弹窗内容、尺寸、`ModalCloseButton` 的合同（见 `DESIGN.md`「可复用实现」）。
- 不在出场完成前阻止新的弹窗打开；新弹窗打开时，旧弹窗立即卸载。

## 验收

- [ ] `usePresence` 单测：单次关闭、重复关闭只回调一次、`animationend` 不触发时兜底计时器生效、卸载时无残留计时器。
- [ ] 现有 Modals 相关单测、`render.test.tsx` 全部通过；`npm run typecheck:web`、`npm run build` 通过。
- [ ] 隔离 Electron fixture 新增 `--overlays-only`：① 打开设置弹窗，`.modal` 有 260ms 动画；② 分别用关闭按钮、Esc、点击遮罩关闭，弹窗在 ≤ 250ms 内从 DOM 移除，焦点回到触发按钮；③ 出场期间点击侧栏会话行，点击生效；④ 减弱动效下入场、出场都只有透明度动画；⑤ surface 菜单入场与出场时长分别为 160ms / 100ms。
- [ ] `npm run test:renderer:ui` 通过。
- [ ] test 实例深浅主题各检查：设置、技能、MCP、LLM 性能弹窗；右侧「+」菜单；会话悬停卡。
- [ ] 本步不涉及数据路径，`performance:measure` 可不跑；若改动触及 `performance-paths.json` 的 `sources`，照常测量。
- [ ] 通过后 `npm run install:mac:dev`。
