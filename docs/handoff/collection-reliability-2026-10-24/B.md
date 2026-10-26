# 批次 B：恢复路径不丢、不卡（H4、M1）

分支：`reliability/collection`，A 核验后开始。

## B1（H4）inbox 失败隔离，而不是删除

**先证实**：
- 往 `runtime/<provider>/<session>/inbox/` 放一条合法排队事件，让 `applyHookLocked` 抛错（例如通过测试 seam 或让其依赖的文件不可读），调用 `recoverRecorder`：旧实现删除了该文件。
- `readJson` 遇到非 ENOENT 错误（例如权限 000）返回 null，导致排队事件被删。

**改法方向**
- 重放失败的条目移到 `inbox-failed/`（保留原文件名以维持到达顺序），记录失败次数与最后错误；下次 recover 重试，超过上限（例如 5 次）再计入 `droppedEvents` 并保留文件供排查。
- 读不出来的条目区分 ENOENT（已被他人处理，跳过）和其他错误（保留，不删）。`readJson` 本身被很多地方用，建议新增一个区分错误的读取函数，只在 inbox 路径使用，避免影响面扩大。
- 隔离目录要计入 `recorder status` 的 pending 指标，`doctor` 有积压时报 `warn`。

**红线**：重放仍按到达顺序、至少一次；失败条目不能阻塞同一会话后续条目的重放（否则就是新的队头阻塞）。如果顺序与不阻塞冲突，在报告里写明取舍。

## B2（M1）recover 逐会话隔离

**先证实**：两个会话 S1、S2 都处于 `closing`。让 S1 的 `finalizeOpenTurn` 抛错（或让 S1 的 session 锁被长期持有），调用 `recoverRecorder`：旧实现抛出，S2 没有提交，commit hook 也没被调用。

**改法方向**
- `recorder.ts:3204-3292` 的循环逐会话 try/catch，记录错误后继续下一个会话；锁超时计入 `pending`。
- `drainCommitNotifications`（3303 行）放到 finally，确保无论前面是否出错都执行。
- daemon 的 `runRecovery`（`daemon.ts:402-409`）不要只吞掉异常，写一行 `daemon.log`。

## 测试

`npm run test:unit -- src/core/turn-recorder/recorder.test.ts src/core/turn-recorder/daemon.test.ts`，`npm run typecheck`，全量 `npm run test:unit`。
