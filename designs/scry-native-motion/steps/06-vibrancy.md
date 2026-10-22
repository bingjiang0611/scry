# 06 · 可选：侧栏材质（vibrancy）

**需要用户在 `progress.md` 或对话中明确同意后才开始。** 这一步会改变侧栏底色，可能影响 `DESIGN.md` 中已核对过的对比度与视觉证据。

## 要做

1. `src/main/window-chrome.ts`：macOS 下为主窗口加 `vibrancy: 'sidebar'`、`visualEffectState: 'followWindow'`；非 macOS 不变。启动背景色（`windowBackgroundColor`）的防闪逻辑保留。
2. 侧栏改为透明或半透明底（例如深色 `rgba(21,21,21,0.72)`、浅色 `rgba(247,247,245,0.72)` 起步，以对比度测量为准）；主内容区与右侧面板保持不透明。
3. 系统开启「降低透明度」时（`prefers-reduced-transparency: reduce`），侧栏退回现有不透明底。
4. 窗口失焦时侧栏材质随系统变灰，文字对比度仍需达标。

## 验收

- [ ] 深、浅主题各在三种桌面背景（纯黑、纯白、高饱和彩色照片）下测侧栏正文与次要文字对比度：正文 ≥ 4.5:1，`--dim2` 级标签不低于现状。不达标就提高侧栏底色不透明度，直到达标为止。
- [ ] 「降低透明度」开启后侧栏为不透明底。
- [ ] `npm run typecheck`、`npm run build`、`npm run test:renderer:ui` 通过；Electron 冒烟启动无白屏 / 闪烁。
- [ ] 更新 `DESIGN.md`「Elevation & Depth」中关于桌面材质的描述（这是设计记录的一部分）。
- [ ] 通过后 `npm run install:mac:dev`。
