# P6 恢复时的迁移点

P6 已暂停（维护者 2026-11-23）。现在先做 V2 对齐，见 [V2-alignment](../../V2-alignment.md) 和任务单 W20，做完再恢复 P6。

本分支（`feat/p6-multi-agent-orchestration`）的代码已经完成到 P6-6，各段的结果见 [P6.md](P6.md)。下面列出 P6 依赖、而 W20 会改掉的三个前提，以及恢复时要改哪里。

## 恢复步骤

1. 把 main 合进本分支，此时 main 已包含 W20。
2. 逐条处理下面三节。
3. 把 V2-alignment §E 列的规则补进 P6 设计：提问只唤醒父会话一次、同级子任务的结果批量送达、DispatchModeLimit。
4. 每一段重新做独立评审，重跑 P6-V 的 L3 验证。
5. 处理 PR #178 的去留：可以把它改回可评审状态，也可以关掉后重新开一个。

## 前提一：每一轮新起一个 Provider 进程（W20 C1 会改）

P6 的做法：
- **子任务的运行**：每个委派任务都通过 `deps.pipeline.startAppRun` 起一个独立的运行（`src/daemon/delegation-host-wiring.ts:85-110`），默认每个运行一个 Provider 进程或一个 query。
- **凭据**：每个运行一份，在运行结束、停止或退出时立即吊销（`src/host-runtime/orchestration/delegation-credentials.ts:30-33,75`）。签发和吊销都在 `src/main/bootstrap/run-provider.ts` 的运行生命周期里（P6-3 B7）。
- **注入**：每个运行注入一次。
  - Claude 和 Qoder：每个 query 带进程内 SDK MCP（`src/main/providers/orchestrator-mcp-sdk.ts`，`agent-runner.ts`、`qoder-run.ts`）。
  - Codex：线程级 `config.mcp_servers` 和 `http_headers` 在每次 `thread/start` 或 `thread/resume` 时传入（`codex.ts`）。这部分刻意不进 `getClient` 的缓存 key。

W20 C1 之后，一个运行变成常驻会话上的一轮，所以要改：
- **凭据仍按轮次绑定**：每一轮签发、每一轮吊销，不能跟着会话常驻。
- **常驻会话怎么换掉上一轮的凭据**：
  - Claude 和 Qoder 的 SDK MCP server 如果随会话常驻，要能按轮次换 token，或者每一轮重建 MCP server。
  - Codex 的线程级请求头要在每轮的 `turn/start` 上更新，或者走 C1 的「重建并续接」。
- **子任务运行的会话**：子会话的 ProviderSession 与父会话相互独立；子会话结束（任务进入终态）时立即释放，不享受空闲保留。
- **工作树隔离**：P6-4 的 worktree 子运行的会话 key 必须包含 worktree 路径（C1 的 key 本来就含 cwd），这一点要确认。

## 前提二：提示词队列只在前端（W20 D1、C3 会改）

P6 的做法：
- **父会话拿子任务结果的方式**：只能在自己的运行里调用 `scry_task_status`，用 `mode: 'wait'` 做边沿触发的等待，上限 20 秒（`delegation-service.ts:249-265,358`）。
- **父运行结束后**：
  - 还在等确认的任务会被作废（L4，`orchestrator-task-lifecycle.ts:397`）；
  - 子任务完成后，没有任何机制把结果送回父会话。
- 没有队列，也没有 `origin = 'agent'` 的唤醒。

W20 D1 和 C3 之后可以改为：
- **子任务进入终态时自动唤醒父会话**：送一个 `origin = 'agent'` 的运行进 D1 的持久队列。
- **规则**（参考 t3 的 DelegatedCompletionDelivery 和 DelegatedTaskQuestionReactor）：
  - 同级子任务的结果批量送达；
  - 子任务的提问只唤醒父会话一次。
- **L4 要重新评估**：父运行结束时，作废「等待确认」的任务是否仍然必要。可以改成挂进队列，等父会话下一轮再处理。这需要维护者决定。
- **`scry_task_status` 的等待保留**，用于父运行内的同步协作，但它不再是取回结果的唯一途径。

## 前提三：谱系以会话文件为准（W20 D3、D4 会改）

P6 的做法：
- 委派子会话的谱系已经写进数据库：任务事件在 `orch_p_session` 里带 `parentSessionKey` 和 `lineage`（`orchestrator-task-handlers.ts:104-130`）。
- 订阅时透传 `parentSessionKey` 和 `lineageKind: 'delegated'`（`subscribe-sessions.ts:17-42`）。Desktop 远程和 iPhone 按这两个字段把子会话设为只读（P6-5）。
- 但分叉和侧聊的谱系仍以会话文件为准，侧栏分组（`src/shared/delegation.ts`）把委派和分叉当成两套来源。

W20 D3 和 D4 之后要改：
- **谱系**：分叉、侧聊、委派统一由 `session.fork`、`session.create` 或任务事件写入同一组列，`lineage.kind` 取值包括 fork、side_chat、delegated。侧栏和远程端只读这一个来源。
- **元数据**：子会话的改名、置顶、归档走 D4 的事件路径，操作者按 P6 的 principal 和 actor 规则记录。
- **只读拦截**：子会话的只读判断继续以 `lineage.kind === 'delegated'` 为准，并补一个测试，确认 D3 迁移后这个判断不会失效（fail open）。

## 其他需要注意的

- P6-3 让 App 主进程模块数从 192 变成 193（见 P6.md）。恢复时必须压回 192 以内，参照 W20 的做法：把小模块并进已有模块，不能放宽上限。
- PR #178 现在是草稿，在 W20 完成之前不要合并。
- iPhone C 组受阻的原因和解除条件见 P6.md 附录。它和 W19 C 组的真机验收是同一件事，在 TODO 里统一处理。
