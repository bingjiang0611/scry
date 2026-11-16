# 验证清单

按改动范围选择；每一步写明结果，跑不了的写“未验证”和原因。

## 每次都跑

```bash
npm run design:audit
```

```bash
npx vitest run src/renderer/design-system.test.ts src/renderer/radius-system.test.ts src/renderer/motion.test.ts src/renderer/components/primitives
```

```bash
node .agents/skills/scry-design-system/scripts/ui-contract-check.mjs
```

`ui-contract-check.mjs` 默认与 `origin/main` 比较，三节逐条处理：

1. **新选择器**：确认每条都是有意新增；出现不认识的组合（例如两个不相关的类拼在一起）多半是删规则时留下的前缀。
2. **不再渲染但被 smoke 选中的类**：更新 smoke 选择器，或在组件上保留这个类作为测试钩子。
3. **写死数值的 smoke 断言**：本次改动移动了其中任何一个值时，在同一个提交里更新断言并说明新值来自哪个 token。断言只能跟着有意的改动改值，不能放宽成范围或删除。

## 改动了组件或 TSX

```bash
npm run typecheck
```

```bash
npx vitest run src/renderer
```

本地容器以 root 运行时，`MarkdownLayout.test.tsx`、`SessionRename.test.tsx` 等需要真实 Chromium 沙箱的测试会失败；这是环境限制，单列说明，不加 `--no-sandbox`。

## 改动会影响外观

- 用构建后的 CSS 在 Chromium 中比对真实组件的计算样式（组件渲染测试的 `renderToStaticMarkup` 输出放进真实容器，深浅两种主题）。删死代码必须零差异；取整的每一处变化按类别列出并逐条确认。
- 比对属性要覆盖本次可能影响的属性：字号、字重、行高、内外边距、颜色、字距、大小写、换行、`display`、网格列。漏比的属性就是漏掉的回归。
- 涉及有 smoke 契约的区域（总览密度、问答结果对齐、侧栏行高、对比度）时，按 smoke 的断言单独复核。

## 平台与交互

- 只在某个平台生效的规则（`:root[data-platform='macos']`）静态比对覆盖不到，要单独核对。
- 改变键盘或焦点行为时，确认对应 smoke 用原生输入（`sendInputEvent`）驱动的是新的交互模型，并在 PR 中写明这是有意的交互变化。

## CI

UI smoke 在 `packaged-electron` 的三个分片里串行执行，前一个失败会让后面的都不运行。一个失败修好后，下一轮可能暴露后面被遮住的失败；推送前先用 `ui-contract-check.mjs` 第 3 节把所有可能受影响的断言一次处理完。
