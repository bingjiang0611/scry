# 05 · 加载防闪

快于 150ms 的读取不显示任何加载 UI；超过 150ms 才出现，且以淡入的顶部细条为主。目的是去掉「闪一下」，而不是隐藏真实的等待。

## 要做

1. **`src/renderer/hooks/useDelayedFlag.ts`**：`useDelayedFlag(flag: boolean, delayMs = 150): boolean`。`flag` 持续为真满 `delayMs` 后才返回真；`flag` 变假时立即返回假；卸载时清理计时器。
2. **会话加载**（`ChatView.tsx` 约 616 行的 `chat-session-evidence-gap` 加载块，`data-status="loading"`）：
   - 用 `useDelayedFlag(sessionLoading, 150)` 控制是否显示。
   - 显示时：顶部 2px 不定进度条（`role="status"`、保留原有文案作为可读说明，可视上以细条 + 一行小字呈现）160ms 淡入；同时上一个会话的转录 120ms 淡出隐藏（见 `../brief.md` 场景 2：不能让旧内容长时间顶着新会话的标题）。
   - `aria-busy`、「核对完成前不能发送或分叉」的禁用逻辑**不受延迟影响**，从 `sessionLoading` 为真的第一帧就生效。
   - `sessionCacheVisible`（先展示上次读取的缓存页）的路径与文案保持不变。
   - 读取 ≤ 150ms 的情况下，转录替换走 02 的 `session` 过渡。
   - 减弱动效：01 的全局规则会把无限动画压成一次 120ms，不定进度条会闪一下就停。所以在 `@media (prefers-reduced-motion: reduce)` 里显式给出替代：静态细条（不移动）加原加载文案，用透明度淡入，不依赖循环动画表达「仍在加载」。
3. **其他加载态**：分析页、远程目录（`RemoteLocation` 相关）、MCP / 技能列表中，如果存在「请求开始即显示加载块」的写法，同样用 `useDelayedFlag` 处理。逐个列在 `progress.md`。证据语义不变：加载中不能显示 `0`、空列表或「无」。

## 不要做

- 不改加载的触发条件、请求本身、缓存策略与超时。
- 不把失败或 `unavailable` 当作加载中处理。

## 验收

- [ ] `useDelayedFlag` 单测：短于延迟不变真、超过延迟变真、变假立即生效、卸载清理。
- [ ] 隔离 Electron fixture 新增 `--loading-only`，用可控延迟的 `loadSession` 桩：① 延迟 60ms 时，`MutationObserver` 全程未见加载元素；② 延迟 400ms 时，加载元素约在 150ms 出现（容差 ±40ms，注明机器负载），文案与 `role="status"` 存在；③ 两种情况下 composer 的发送与分叉在加载期间都处于禁用；④ 加载失败时显示原有失败说明，不出现残留加载条；⑤ 减弱动效下延迟 400ms 时，细条与文案在整个加载期间保持可见且没有 `transform` 动画。
- [ ] 受影响单测、`npm run typecheck:web`、`npm run build`、`npm run test:renderer:ui` 通过。
- [ ] `npm run performance:measure -- --scenario history`；每个 `worse` 写明原因。
- [ ] test 实例检查：打开小会话（无加载 UI）、打开大会话（细条出现）、远程目录切换。
- [ ] 通过后 `npm run install:mac:dev`。
