# P3f · daemon → App 事件流

状态：维护者 2026-11-10 批准做推送流（新增流式 op 只在本机端点、`scope: local`，见 [STATUS-BATCH4](STATUS-BATCH4.md)）。按 E0–E3 分段实现，E0、E1 已完成，见 [b4-l4-events](status/b4-l4-events.md)。

## 现在缺什么

开关打开时，daemon 有三类变化到不了 App：

1. **窗口通知全部丢失。** daemon 的运行管线把窗口通知发给一个空实现（`host-process.ts` 的 `renderer: { send: () => undefined }`），会话账本的 `publishDataUpdated` 也是空实现。丢掉的包括：
   - `agent:dataUpdated`：`turn_recorded`、`session_deleted`、`conversation_changed`、`catalog_recovered`；
   - `agent:unreadSessions`：未读角标，因此闸门只能让这个通道保持缺席。

   App 现在靠两种绕行补救：自己发起的会话写入由 App 替 daemon 发 `conversation_changed`（`announceDaemonConversationWrites`）；其余由 renderer 下次读取时刷新。
2. **并发 run 互相阻塞。** App 到 daemon 的每条 lane 同一时刻只有一个请求（`desktop-lane.ts`：「one outstanding request at a time」），而所有 run 的 watch 长轮询都走同一条 `watch` lane。daemon 的 watch 在任何 run 有台账事件时都会返回，但文本输出只唤醒它自己那个 run 的 watch。结果是：run A 在思考、没有新事件时，run B 新写出的文本要排在 A 的长轮询（最长 15 s）后面。单个 run 时看不出来，例如会话发送和普通发送同时进行就会出现。
3. **其他客户端发起的 run 要靠轮询发现。** 手机发起的 run，只有在 renderer 调 `agent:activeRuns` 时才会被领养。

## t3code 的做法

每个客户端对每个 thread 持有一个订阅，带序号游标。断线重连时，缺口小于 128 个事件且小于 1 MB 就补发，否则发一份快照；推送前按 50 ms 合并同一条消息的更新（`ws.ts` 的 `subscribeOrchestrationV2Thread`、`ThreadLiveEventCoalescer.ts`）。

可以照搬的是这三条规则：游标、补发或快照、合并。不照搬的是 WebSocket，Scry 已有带 mTLS 的 lane。

## 设计

### 协议：一个本机长轮询 op

```
请求  { op: 'appEvents', epoch?: string, cursor: number, waitMs: number }
回答  { events: { epoch: string, cursor: number, items: AppEvent[], reset?: true } }
```

- 只在本机端点提供，网络端点回答 `unsupported_op`，与其他本机 op 相同。
- daemon 在内存中保存一个有界环形缓冲（512 项或 256 KB，先到为准）。`epoch` 是 daemon 进程的随机标识。
- 有新事件立即回答，否则等到 `waitMs`（上限 25 s，低于 lane 的 40 s 超时）。
- 请求的 `epoch` 不同（daemon 重启过），或 `cursor` 早于缓冲中最旧的一项，都回答 `reset: true` 加上当前游标。

`reset` 的含义是「你漏了事件，按快照重读」。App 收到后：

- 重新读取正在跟踪的每个 run；
- 发一次 `catalog_recovered`，让列表重读；
- 用回答里附带的最新未读快照替换角标。

App 在自己的新 lane `events` 上始终保持一个这样的请求，与 `watch`、`status`、`bulk`、`control` 互不阻塞。

### 事件

```ts
type AppEvent =
  | { kind: 'data'; event: AgentDataUpdated }               // 原样转给窗口的 agent:dataUpdated
  | { kind: 'attention'; snapshot: SessionAttentionSnapshot } // 取最新值，合并
  | { kind: 'run'; runId: string }                          // 台账 run 有了新事件、输出或问题；合并同一个 run
  | { kind: 'runs' }                                        // live run 集合变了；合并
```

- 合并规则：`attention`、`runs` 以及同一个 `runId` 的 `run`，在缓冲中只保留最新一项，并移到队尾，序号取新的。
- `data` 不合并，但同一个 `conversationId` 连续出现时只保留一项。
- 事件只是通知，不携带正文。App 收到 `run` 后仍按原来已授权的读取路径（watch、trace）去读，所以权限检查和证据来源都不变。

### daemon 侧的来源

| 来源 | 接到哪里 |
|---|---|
| 运行管线的窗口通知 `agent:dataUpdated` | `host-process` 的 renderer 实现，只转发这一个通道；`agent:trace` 等由 run 读取覆盖，不重复 |
| 会话账本、目录恢复的 `publishDataUpdated` | 写入事件流 |
| `publishUnreadSessions` | 写入 `attention` |
| 台账事件、输出追加、问题变化 | 复用 `LiveWatchers.notify()` 的同一信号，按 runId 发 `run` |
| mac run 集合变化 | `runs` |

### App 侧

- 新建 `DaemonEventPump`，每个 daemon 连接一个，断线重连后从原游标继续：
  - `data` → `agent:dataUpdated`；
  - `attention` → `agent:unreadSessions`，同时缓存，用来回答 `agent:unreadSessions` 调用。闸门因此可以改为放行这个通道，角标不再缺席；
  - `run` → 唤醒该 run 的 pump；
  - `runs` → 领养新出现的 run。
- `DaemonRunRuntime` 的 pump 改为等待唤醒，再做一次不等待的读取（`waitMs: 0`），不再每个 run 各持一个长轮询。另保留 15 s 兜底超时：即使事件丢失，最长 15 s 也会读一次，不会无限等待。
- App 替 daemon 发 `conversation_changed` 的绕行，在 E1 之后删除，避免同一变化通知两次。

## 分段

| 段 | 内容 | 完成判据 |
|---|---|---|
| E0 | 先写失败测试，证明并发 run 的文本被阻塞：两个 run，A 一直不产出，B 写出文本，断言 B 的文本在 A 的长轮询结束前到达窗口 | 修改前失败 |
| E1 | 事件缓冲、`appEvents` op、`events` lane、App 侧事件 pump；承载 `data`；删除 App 替 daemon 发 `conversation_changed` 的绕行 | daemon 真实 socket 测试：一个 turn 记录后窗口收到 `turn_recorded`；`reset` 路径测试 |
| E1b | 未读角标：`attention` 事件，加上 App → daemon 的「已查看」op，闸门放行 `agent:unreadSessions` | 角标与进程内一致：daemon 里结束的 run 标为未读，在 App 里查看后清除 |
| E2 | `run` 唤醒；`DaemonRunRuntime` 改为按唤醒读取 | E0 的测试通过；单 run 的流式粒度与 S1 的计时脚本相比不变差（毫秒测量串行持锁，标明负载） |
| E3 | `runs` 事件；`activeRuns` 不再每次都轮询 `liveRuns` | 手机发起的 run 不经过 renderer 调用也会出现在窗口 |

## E1 实现时的修正

- **角标拆成 E1b。** 角标不是单向的：数量由 daemon 侧的未读会话与 App 自己连接其他宿主产生的未读会话相加（`DockBadgeState.count`），而「已查看」发生在 App 窗口里。只把 daemon 的快照推过来，查看后角标不会清除。所以 E1b 需要一个 App → daemon 的「已查看」op，单独做。
- **`reset` 的含义要让 renderer 能执行。** 原有的通知种类不能表达「任何东西都可能变了」：`catalog_recovered` 只让列表重读，打开着的会话视图只认自己 id 的 `conversation_changed`。新增 `{ kind: 'resynchronize' }`，列表与打开着的会话视图都会重读。轮询失败后恢复时也发一次，因为失败的那次回答里可能有通知。
- **新客户端从「现在」开始。** 不带 `epoch` 的第一次读取返回当前游标、不补发历史；App 刚连上时本来就会读取当前状态。

## 不做

- 不把 trace 正文放进事件流。正文仍走已授权的 trace 读取（与 [P3e](P3e-first-token-push-proposal.md) 的结论一致：投递段不是首 token 的瓶颈）。
- 不向远程设备开放 `appEvents`。
- 不持久化事件缓冲。daemon 重启就是 `reset`。
