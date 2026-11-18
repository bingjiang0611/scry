# B3-F1 核验修复（F1-1、F1-2、F1-3）

返回[批量状态](../STATUS-BATCH3.md)。来源：[REVIEW-BATCH3-M1](../REVIEW-BATCH3-M1.md)。

## F1-1 跟随的 run 前 15 s 没有内容读取

**原因**：`scheduler.setLive(followed ? live.scryRunId : undefined)` 里的 `followed` 是本轮请求**之前**的 `foreignRunRef.current`。第一次发现别处发起的 run 时它还是空的，于是这一轮不布 live 读取；下一轮 `liveRun` 已经在宿主上停住，最长 15 s 之后才轮到。

**修法**：新增 `followedLiveRunId(live)`（`RemoteChatShared.ts`）：只要屏幕上有一个 live 的外部 run 就返回它的 id，与「上一轮是否已跟随」无关。组件改为 `scheduler.setLive(followedLiveRunId(live))`。

**失败证据**（函数不存在，能力缺失）：

```
× followed run selection > follows a live external run even before it was followed previously
  → (0 , followedLiveRunId) is not a function
```

修复后 2 passed。「首次出现即读一次、之后按窗口」由调度器测试的 `reads == [0, 1000, 2000, 3000]` 覆盖。

## F1-2 读取没有单飞

**原因**：tail/live 读取在 poll 之外直接调 `followTrace`，节流只按开始时间算。一次读取超过一个窗口时，下一次 tick 会在上一次还没返回时发出，两次都以同一个旧 `traceViewRef` 合并。

**修法**：`createTraceReadScheduler` 增加 `inFlight`：`read` 返回 Promise 时置位，settle 后再处理 pending。有读取在途时：
- `perform` 不发起第二次读，把 run 记为 pending；
- `armTail`/`armLive` 不再布 timer，避免 0 ms 自旋；
- settle 或 `markRead()` 之后按节流补一次。
组件侧的 `readNow` 用 `try/finally` 调 `markRead`，读取失败也释放占用（否则 tail/live 会被永久挡住）。

**失败证据**：

```
× single flight > does not start a second read while the first is still in flight
  → expected 5 to be 1
```

（`read` 返回挂起的 Promise 3 s，期间调度器发起了 5 次读。）修复后 7 passed。

## F1-3 换 run 不再立即读取

**原因**：S1 的 `needsTraceRead` 保留了「不是屏幕上那个 run 就立即读」，`decide()` 换成纯时间判定后丢了这条：同一会话里 run A 结束、run B 开始，B 的首次内容会等到 A 的窗口过期。

**修法**：调度器记住 `lastRunId`，`decide(runId)` 在 runId 与上次不同时直接返回 `read-now`；`markRead()` 记录本次的 runId。

**失败证据**：

```
× run identity changes read at once > reads a different run immediately, even inside the floor
  → expected 'coalesced' to be 'read-now'
```

## 验证

| 命令 | 结果 |
|---|---|
| `npx vitest run src/renderer/components/trace-read-scheduler.test.ts` | 7 passed |
| `npx vitest run src/renderer/components/RemoteChatShared.test.ts` | 8 passed |
| `npx vitest run src/renderer/components` | 495 passed |
| `tsc -p tsconfig.web.json --noEmit` | 通过 |
| `node scripts/desktop-remote-ui-smoke.mjs` | exit 0 |
| `node scripts/electron-security-smoke.mjs --dev` | exit 0 |

读取次数上界不变（同一 run 每窗口最多一次）；`inFlight` 只会减少并发读，不会增加次数。
