# 侧聊 · 本地验证报告（第三轮）：`--overlays-only` 焦点间歇失败

- 仓库：`bingjiang0611/scry`，PR #56，分支 `claude/gracious-feynman-nlrtdp`
- 本轮 revision：`91af0268`；main 对照 worktree `../scry-main` = `origin/main` `91a85d1b`
- 失败检查：`node scripts/session-capability-ui-smoke.mjs --overlays-only`（CI job `packaged-electron (1)` / `npm run test:renderer:ui:1`）
- 结论：**不是本 PR 引入**。`src/renderer/app-session-actions.ts` 与 main 逐字节相同，main 的同一份代码在本地可以稳定复现同一个失败快照；修的是这条共享的焦点竞态。

## 1. 环境

| 项 | 值 |
|---|---|
| macOS | 27.3（26C5035r），arm64（Apple Silicon） |
| Node / npm | v24.18.0 / 12.2.0 |
| 依赖安装 | `QODER_SKIP_DOWNLOAD=1 npm ci`（exit 0），另跑 `node node_modules/electron/install.js` 补 Electron 二进制 |
| 机器负载 | 1 分钟负载全程 16–60（A/B 阶段 30.9–59.8，修复后 20 次 22.7–37.8，`test:renderer:ui:1` 阶段 20.4–50.8） |
| 日志 | `/tmp/lv3/`（`ab.tsv`、`ab-final.tsv`、每次一份完整 `.log`） |

## 2. A/B 统计（先测未修复状态）

`--overlays-only`，分支与 main 交替、串行，各 20 次：

| 目标 | 运行次数 | 通过 | 失败 | 1 分钟负载 |
|---|---|---|---|---|
| 分支 `91af0268`（未修复） | 20 | 20 | 0 | 30.9–59.8 |
| main `91a85d1b`（未修复） | 20 | 20 | 0 | 34.0–59.0 |

然后按 CI 顺序跑完整链路 `npm run test:renderer:ui:1`（内部依次跑 10 个 smoke，`--overlays-only` 在第 8 位）：

| 目标 | 运行次数 | 通过 | 失败 | 1 分钟负载 |
|---|---|---|---|---|
| 分支（未修复） | 1（本轮修复前未单独跑） | — | — | — |
| main（未修复） | 1 | 1 | 0 | 50.8 |

结论：在本机（未打包 Electron、非 CI 负载形态）单独跑和整链路跑都不复现，与任务书给的先验一致。于是改用插桩定位时序，再做确定性复现（第 3、4 节）。

## 3. 焦点插桩结果

只在本地临时改 `scripts/overlays-ui-checks.mjs`：patch `HTMLElement/Element/SVGElement.prototype.focus` 记录目标与调用栈，监听 `focusin`/`focusout`，并在每个步骤打时间标记；同时包装 `window.scry.newSession` / `focusRun` 记录解析时刻。用完已恢复原文（`git status` 只剩本次修复）。

未修复分支、同一进程内的两次“新建会话 → 打开 `+` 菜单 → Escape”序列（毫秒，相对第一次点击）：

```
invocation 1                              invocation 2（reduced-motion 复跑）
   4 newSession start                       2184 newSession start
   5 newSession resolved                    2185 newSession resolved
   8 mark sb-new-clicked …BUTTON.sb-new     2189 focus BUTTON.menu-item
   8 mark composer-present                  2191 focus BUTTON.icon-button on   ← 菜单 onExitStart 恢复 trigger
  18 focus TEXTAREA.input  ×2               2200 focus TEXTAREA.input  ×2      ← composer 焦点抢回光标
 291 focus BUTTON.menu-item                 （检查已在此前读完 activeElement，所以没触发失败）
 306 focus BUTTON.icon-button on（onExitStart）
```

要点：

1. composer 的焦点请求来自 `newConversation` 的两处 `setTimeout(() => taRef.current?.focus(), 0)`（`focusComposer` 与 `finally`），调用栈落在 `src/renderer/app-session-actions.ts`，与 `RightSurfacePanel.onExitStart` 里的 `addButtonRef.focus()` 完全独立。
2. 谁最后跑谁赢：只要 composer 的定时器晚于菜单的 `onExitStart`（第 2 次序列就是这样），`document.activeElement` 就变成 `TEXTAREA.input`，检查在读完 activeElement 前看到的就是 CI 里那份快照。
3. 菜单打开时第一个菜单项是“侧边会话”，新会话里它是 disabled；`menuItemRefs.current[0]?.focus()` 失败后焦点仍留在 `+` 按钮上——**不影响**结论，`onExitStart` 仍然把焦点给 `+`，失败只来自后面那次 composer 焦点。
4. Escape 走的是 `RightSurfacePanel` 的 `onEscape` → `closeMenu(true)` → `onExitStart` 恢复焦点，`restoreFocus` 为 true（日志里 306/2191 行的 `icon-button` 就是它）。

## 4. 确定性复现（本地，未提交）

把 fixture 里的 `newSession` 桩延迟 380ms（`scripts/fixtures/session-cache-smoke.tsx`，只改本地，已恢复），让 composer 的两个定时器必然晚于菜单关闭：

| 代码 | 延迟 | 结果 |
|---|---|---|
| main（未修复） | 380ms | 3/3 失败，快照 `{"restored":false,"target":{"tag":"BUTTON","class":"icon-button"},"active":{"tag":"TEXTAREA","class":"input"},"focused":false,"inert":null,"surfaces":1}` —— 与 CI 报错逐字段一致 |
| 中间版本（基线在“安排定时器时”取） | 380ms | 3/3 失败（说明基线必须在意图开始时就取） |
| 最终修复 | 380ms | 3/3 通过（完整结果里 `focusRestoredAtExitStart: true`） |

这一步同时证明了两件事：失败机制在 main 的代码里就存在；本 PR 没有改动这条路径。

## 5. 根因

`newConversation`（以及同类的延迟 composer 焦点）把“把光标放回输入框”实现为无条件 `setTimeout(0)`，并在 `await window.scry.newSession(...)` / `refreshProviderCatalogs()` 之后才排定。渲染进程在打包后的 macOS CI 上更慢时，这些定时器会晚于 Surface 菜单 Escape 的焦点恢复执行，于是把光标从 `+` 按钮抢回 composer：菜单已经按需求恢复了焦点，检查读到的却是 textarea。

为什么 main 的 CI 通过而本 PR 有 3/5 失败：代码路径相同，差别只在时序。本机两次序列里 composer 焦点在 10–35ms、Escape 在 288–335ms（分支与 main 同量级，差异在噪声内），说明本机不会命中；打包后的 runner 更慢就会命中。本地没有证据表明本 PR 加剧了它，只能说本 PR 的渲染进程工作量不同会改变时序，不能排除“更容易命中”。

## 6. 修改内容

新增 `src/renderer/composer-focus.ts`：

```ts
export function focusComposerUnlessFocusMoved(target, before: Element | null): void {
  window.setTimeout(() => {
    const active = document.activeElement
    if (active != null && active !== document.body && active !== before) return
    target.current?.focus()
  }, 0)
}
```

`before` 是**意图开始**时（点击“新建会话”、点队列里的编辑、离开 Meta Prompts 等）同步抓到的焦点元素，不是安排定时器时。之后出现的新焦点（菜单恢复的 trigger、用户点击的其它控件）一律优先；只有焦点落在 `body`/`null`（控件已卸载）时才仍然聚焦 composer。

替换的 7 处 `window.setTimeout(() => taRef.current?.focus(), 0)`：

| 文件 | 位置 |
|---|---|
| `src/renderer/app-session-actions.ts` | `newConversation` 的 `focusComposer` 与 `finally`；`unbindProject`（三处同一个基线） |
| `src/renderer/app-queue-actions.ts` | `editQueuedPrompt`、`cancelQueuedPromptEdit`、`addWorkspaceReference` |
| `src/renderer/app-view.tsx` | `returnFromMetaPrompts` |

行为对照：在 fixture 里单独验证“点新建会话后不再操作”的常见路径，修复前后都是 `{"active":"TEXTAREA.input","composer":true}`（分支修复后与 main 各跑 1 次），没有把常见的聚焦需求改掉。

## 7. 回归测试

`src/renderer/composer-focus.test.ts`（4 条，node 环境 + 最小 `document`/`window` 替身 + fake timers）：

1. 没有更新的焦点 → composer 被聚焦；
2. 意图开始后有别的元素拿到焦点（菜单 Escape 的 `+` 按钮）→ 不抢焦点；
3. 焦点落回 `body`（浮层卸载）→ 仍然聚焦 composer；
4. composer 已卸载 → 什么也不做。

失败/通过对照：把 helper 临时改回无条件 `target.current?.focus()` 后，第 2 条失败（`1 failed | 3 passed`）；恢复修复后 `4 passed`。

## 8. 运行过的命令与结果

| 命令 | 结果 |
|---|---|
| `QODER_SKIP_DOWNLOAD=1 npm ci` | exit 0 |
| `node node_modules/electron/install.js` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npx vitest run src/renderer` | exit 0，125 files / 1263 tests 全通过 |
| `npx vitest run src/renderer/composer-focus.test.ts` | 修复后 4 passed；临时回退实现后 1 failed |
| `node scripts/session-capability-ui-smoke.mjs --overlays-only` ×20（修复后） | 20/20 通过（负载 22.7–37.8） |
| `npm run test:renderer:ui:1` ×3（分支，修复后） | 3/3 通过，4m41s / 4m21s / 5m17s，每次结果里都包含 overlays 断言 |
| `npm run test:renderer:ui:1` ×1（main 未修复） | 通过（与 CI 一致） |
| 380ms 延迟复现（本地插桩，未提交） | main 3/3 失败；最终修复 3/3 通过 |

没有修改任何 CI 门限、超时、重试或 sleep；没有删除或跳过测试；插桩与 fixture 延迟改动均已还原。

## 9. 未验证

| 项 | 说明 |
|---|---|
| `packaged-electron (1)` 那个 job 本身 | 只能在 CI 上重跑验证，本地无法复现打包 macOS runner 的负载形态 |
| 真实打包 App 的行为 | 本地用未打包的 dev Electron + 同样的 offscreen fixture，没有安装/运行打包产物 |
| Linux 端 | 修复是平台无关的渲染进程焦点逻辑，但没有在 Linux 上跑（任务书里的云端结论是 Linux 复现不到该失败） |
| “本 PR 是否让这个竞态更容易命中” | 只有量级相同的时序数据，无法证明因果；结论止于“机制在 main 上同样存在，且能在 main 的代码上确定性复现” |

## 10. 建议

建议合并：失败机制在 main 上同样存在，修复只增加一个“更新的焦点优先”的守卫，不改任何时序、门限或测试；常见路径（新建会话后直接输入）仍然聚焦 composer。合并前建议先看本轮推上去之后 `packaged-electron (1)` 的 CI 结果。
