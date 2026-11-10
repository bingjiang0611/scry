# B4-L4 · 两份本机验证报告之后的修复

来源：f82f7ec（W 段）与 a525d9b（L4-2）的 macOS 本机验证报告。本文件记录改了什么、为什么，以及报告里尚未处理的项。

## 已修

| 报告现象 | 原因 | 改动 |
|---|---|---|
| 统一会话收到回复后未读角标一直不消（两种模式） | 统一会话的 run 从不是窗口的焦点 run，视图也从不告诉 main 它展示的是哪些原生会话，所以 `markAttention` 永远当作「没在看」 | 新通道 `agent:viewSessions`（留在 main，badge 由 main 渲染）：视图按 binding 计算原生会话的 badge key（与 main 标记时相同的 `sessionAttentionKey`），挂载时告诉 main，卸载时撤回。`DockBadgeState` 按视图记录一组 key：主窗格里的会话替换单个「正在看」的会话，侧边会话与之并存；窗口重新获得焦点时一并清除；daemon 模式下照常回报 daemon 已读 |
| daemon 模式：窗口聚焦、正在看的普通会话被标成未读 | 进程内焦点 run 拿到原生会话时调用 `dockBadge.view`（`run-session.ts`），daemon 模式下 App 不知道焦点 run 的会话 | `agent:session` 窗口通知送达后，如果它属于窗口的焦点 run，App 用同样的 key 调 `dockBadge.view`；之后 daemon 的未读快照里出现这个会话时，窗口回报已读 |
| daemon 模式：侧栏「新会话」报原始 IPC 错误 | `agent:newSession` 被 gate 拒绝 | 拆成两半：daemon 用 `providerContext.newSession` 本地 op 重置它运行的上下文并让 Provider 热状态失效；App 在 daemon 回答之后才把窗口切到「不看任何会话」，daemon 失败则保持原状 |
| 删除统一会话的对话框显示原始错误 | 用了 `String(error)` | 改用 `ipcErrorMessage` |

## 测试（均先失败，再做对照）

- `dock-badge-conversation.test.ts`：会话在屏时其回复不计未读；打开或重新聚焦时清除；主窗格替换单会话、侧边会话并存；关闭后忘掉且不影响之后查看的会话；daemon 模式回报已读。对照：让 `shows()` 只看单会话 → 3 条失败；空列表也清单会话 → 1 条失败。
- `agent-runtime-ipc-daemon-view.test.ts`：`agent:viewSessions` 生效，并拒绝非有界 key 列表（缺字段、空 key、超过 16 个）。
- `conversation-viewed-sessions.test.ts`：key 与 main 的 `sessionAttentionKey` 一致，去重、活跃 binding 优先、上限 16。
- `daemon-run-events-session.test.ts`：焦点 run 的 `agent:session` 让该会话不计未读；不是焦点 run 则保持未读。对照：不调用 → 失败。
- `startup-channels-new-session.test.ts` 与 `host-process.test.ts`：新会话在真实 daemon 上回答 `true`，失败时窗口不切换。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过；
- 全量 vitest：5763 passed / 9 failed / 5 skipped。修复后 `daemon-ipc-matrix` 已通过（通道数 167 → 168，矩阵文档已重新生成）；剩余失败都是已知的 root/Chromium 环境原因（chmod 不生效、无头 Chromium、进程回收）；
- `ConversationView.tsx`、`ConversationDeleteDialog.tsx` 在性能路径 sources 里，跑了 `npm run performance:measure`：Ratchet 通过，没有 `worse`。

## 未处理、待证据

- 会话头部按钮被 `.chat-transcript` 盖住：原因未知，需要 macOS 上 `document.elementsFromPoint` 与祖先的 `z-index`/`position`/`overflow` 计算值；
- 普通会话停止后「本轮已中断」有时不出现（daemon 模式）：需要进程内对照；
- 统一会话运行中「再发」按钮禁用，但提示文案说会排队：可能是两种模式都有的文案不一致，需要进程内对照；
- 真实 Pi 走不通：统一会话要求 `pi:<16 位十六进制>` 的 profile id，内置的 `pi:rotom` 被拒绝，是已有的产品限制；
- L4-2 的验证 agent 用了真实 userData，在真实 `scry.db` 里留下统一会话 9e469a6a（「草稿 L4-2 改名验证」）。关掉 daemon 开关后可在进程内删除。之后的验证提示词强制使用临时 userData。
- 未在 macOS 与真实 App 中验证。
