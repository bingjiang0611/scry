# Scry · 等待队列 Bolder + 队列消息编辑 · 设计与落地记录

## 状态

- 设计日期 2026-10-21；同日选定 **B · 阶梯** 并落地到产品代码。
- 决策：编辑队列消息后**跳过后面的先发**——编辑中的行留在原位，其余消息照常按 FIFO 继续；发送后该条移到队尾。
- 设计稿（四稿对照）保留在 `designs/scry-prompt-queue-bolder/index.html`，可直接打开；下面是落地后的真实合同。
- 目标范围只动 `.prompt-queue` 块与它新增的编辑动作；运行状态条、输入区、会话区布局不变。

## 为什么原来是平的

| 原实现 | 观察 |
| --- | --- |
| 每行 44px 等高、`--surface-subtle` 底 + 1px 框 | 三行长得一样，队列里唯一的信息——顺序——只剩一个 22px 圆点数字 |
| 序号 10px、正文 12.5px、按钮 10.5px | 三档字号挤在 2.5px 内，「下一个」和「第 3 条」没有层级差 |
| 容器 12px 圆角 + `--shadow-pop` | 贴着输入框的内联块带 64px 投影，边界比内容更响 |
| 状态靠 `disabled` + `title` | 「提交中 / 结果未知」默认看不见 |
| `.queue-hint` 用 `--dim3` | 对 `--panel` 约 2.95:1，而这句正是「任务结束后依次发送」 |

## 落地的 B 稿

- 容器去 `--shadow-pop`，改内嵌面 + 发丝边框（`codex-alignment.css` 里原来的 `.prompt-queue` 覆盖同步拆开）。
- 序号并进 1px 竖轨（34px 列、右对齐），行间只有发丝线；只有「下一个」抬高（50px、15px 琥珀序号、`--surface-hover` 面、inset 1px 描边）。
- 状态改由竖轨报：琥珀 = 未决（提交中 / 结果未知），红 = 明确拒绝，蓝 = 正在输入框里编辑。
- 次要行正文降到 `--dim` 12px，Steer 边框降到 `--border3`；「下一个」的 Steer 才用 `--accent`。
- 说明文字从 `--dim3` 提到 `--dim2`。
- 设计阶段的 C（状态列）、D（单峰）没有落地，仍留在设计稿里作对照。

## 编辑队列消息

铅笔按钮在 **Steer 与移除之间**（`Icon name="edit"`），点击把该条文本放回输入框。

| 行为 | 决定与理由 |
| --- | --- |
| 原条目留在队列，标 `is-editing` | 立刻移出会让「这条还在吗」变成猜谜；取消编辑也会变成丢消息 |
| 编辑中的行只保留 `取消编辑` | 内容正在输入框里改，行内再给 Steer/移除就是两个真相 |
| 输入区提示条 | `编辑队列第 N 条 · 发送后移到队尾 · 自动发送会先跳过这条`——两个后果都写在用的地方 |
| 发送 | 原位置移除，作为**新意图**追加到队尾；行内短暂标 `编辑后已移到队尾`（2.5s） |
| 编辑中的行不进自动出队 | 其余消息照常 FIFO 先发；只剩它一条时宁可不出队，也不提前发未完成的编辑 |
| 换新的 messageId | 旧 id 上可能挂着 rejected/unknown 的 Steer 证据，复用会把旧回执审到新消息上 |
| 附件 | **不回到输入框**（原 DraftAttachment 的预览已释放），仍随该条消息走到队尾；编辑期间新加的附件合并进去 |
| `提交中` / `结果未知` 不可编辑 | 文本已在 Provider 那一侧，改了收不回 |
| 输入框有内容时铅笔禁用并给原因 | 不静默覆盖用户正在打的字 |
| `Esc` 取消 | 行与原文本原样保留 |
| 「下一个」高亮跟着真实发送顺序 | 编辑第 1 条时，高亮落到第 2 条；界面不能骗人 |

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/renderer/components/ChatView.tsx` | 队列 JSX 重写为竖轨结构、铅笔与取消编辑、编辑提示条、`Esc` 取消；`nextQueuedMessageId` / `editingQueuedIndex` 参与「下一个」判定 |
| `src/renderer/App.tsx` | `editedPromptToTail`（换 id 重新入队）、`nextDrainableQueuedPrompt`（跳过编辑中）；`editingQueuedPromptId` / `movedQueuedPromptId` 状态、`editQueuedPrompt` / `cancelQueuedPromptEdit`、`send()` 的编辑分支、自动出队改用跳过选择 |
| `src/renderer/constants/copy.ts` | 新增 `QUEUE_COPY`，队列块与编辑文案集中一处 |
| `src/renderer/styles.css` | `.prompt-queue` 段按 B 重写；新增 `.queue-edit` / `.queue-edit-cancel` / `.queue-moved` / `.is-next` / `.is-editing` / `.is-steer-rejected` / `.composer-edit-hint` |
| `src/renderer/codex-alignment.css` | `.prompt-queue` 从浮层组拆出，改内嵌面、去掉 `--shadow-pop` |
| `scripts/steer-ui-smoke.mjs` + `fixtures/steer.tsx` | 原生坐标点铅笔 → 行变编辑中、文本进输入框、高亮跳到下一条、点 `取消编辑` 复原 |
| `steer.test.ts` / `render.test.tsx` | 队列项换 id 移到队尾、附件随行、旧 Steer 状态不跟随、跳过语义、编辑态渲染与「有内容时禁用」 |

## 验证记录

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck:web` | 通过 |
| `npm run test:unit -- src/renderer/components/render.test.tsx src/renderer/steer.test.ts src/renderer/remote-prompt-queue.test.ts` | 267 通过（render 245 / steer 12 / remote 10） |
| `node scripts/steer-ui-smoke.mjs` | 通过，含新增 `queueEditing`：pending 行铅笔禁用、点第 1 条铅笔后 `is-editing`、正文进真实 textarea、`is-next` 落到第 2 条、提示条写明「会先跳过这条」、取消后复原 |
| `SCRY_STEER_UI_SCREENSHOT` 导出 | 深/浅两版用生产 `styles.css` + `codex-alignment.css` 渲染的队列实图，竖轨、发丝线、抬高行、铅笔、能力说明都正常 |
| `npm run install:mac:dev` | 打包、`check-packaged-app`、`smoke:electron`（含 steer/session-capability/remote 等）通过，已装到 `/Applications/Scry.app`，备份在 `/Applications/.Scry.app.backup` |

控制实验：编辑按钮的「输入框有内容时禁用」断言第一次是**失败**的——`editDisabled` 漏了 `editDraftBlocked`，单测立刻抓到，补上后才通过。说明这条断言能区分真假实现。

## 未验证 / 限制

- 真实 App + 真实 Provider 的端到端「排队 → 编辑 → 发送到队尾 → 自动出队跳过」没有跑：需要授权账号与费用，且必须在独立 test 实例里做。
- `App.tsx` 的编辑分支（`send()` 里的 `editedPromptToTail` 调用、暂停标记清理）只有 helper 级单测覆盖，没有集成测试。
- 键盘 Tab 顺序、`aria-live` 朗读、`Esc` 后的焦点归位没有在 fixture 里断言。
- 队列超过约 5 条时 `max-height: 214px` 的滚动、竖轨在滚动容器内的连续性没有截图确认。
- `RemoteChat.tsx` 有另一套队列实现，本次没动，远端会话看不到铅笔按钮。
- 编辑期间新加附件只做了合并逻辑，没有真实图片落盘验证。
