# P3f daemon → App 事件流：E0、E1、E1b、E2

设计见 [P3f](../P3f-app-event-stream.md)。上级状态见 [b4-l4](b4-l4.md)。

## E0：并发 run 互相阻塞（已复现，E2 修复）

`daemon-run-concurrency.test.ts` 用生产的 lane 规则（每条 lane 同一时刻一个请求，按 `laneForRequest` 选 lane）驱动两个 run：

- run A 在思考，它的 watch 按 pump 给的 15 s 等待；
- 随后启动 run B。

结果是 B 的 `start` 超过 1 s 还没返回，它自己的 300 ms 绑定预算也没有生效。原因是预算只在两次 watch 之间检查，而 B 的 watch 排在 A 的长轮询后面。

问题比设计时预计的更重：不只是 B 的文本被推迟，`agent:start` 本身也会被别的 run 的长轮询拖住，最长 15 s。这条测试以 `it.fails` 提交；E2 修复后已改为普通测试（见下）。

## E1：数据通知

| 层 | 改动 |
|---|---|
| daemon | `AppEventFeed`：内存中的有界缓冲（512 项或 256 KB）。带进程 `epoch` 与递增游标；同一会话、目录恢复的通知只保留最新一项；缓冲溢出或 daemon 重启时回答 `reset`。daemon 的运行管线不再把窗口通知丢进空实现，`agent:dataUpdated` 写入事件流；会话账本与目录恢复的 `publishDataUpdated` 也写入事件流。daemon 关闭时先释放挂起的长轮询 |
| 协议 | `appEvents { epoch?, cursor, waitMs }`，只在本机端点提供；网络端点回答 `unsupported_op`；参数逐项校验 |
| lane | 新增 `events` lane，长轮询不与 run watch、`liveRuns`、bulk、control 排队 |
| App | `DaemonEventPump`：每个 daemon 连接一个长轮询，通知原样转为窗口的 `agent:dataUpdated`；`reset` 或一次失败的轮询之后发 `resynchronize`；失败按 1 s 起、倍增、30 s 封顶重试；daemon 没有这个 op 时停止，不反复轮询 |
| renderer | 新通知 `{ kind: 'resynchronize' }`：列表重读，打开着的会话视图也重读 |
| 删除 | App 替 daemon 发 `conversation_changed` 的绕行（`announceDaemonConversationWrites` 及其测试）。daemon 自己的处理函数现在通过事件流通知 |

顺带：`host-process.ts` 的本机端点装配（本机 op、run controls、事件流）按职责拆到 `src/daemon/local-endpoint.ts`，文件从 19.3 KB 降到约 16 KB。

## 测试（均先失败或先不存在）

| 测试 | 断言 |
|---|---|
| `app-event-feed.test.ts` | 新客户端从现在开始；有事件立即回答；等待时被下一个事件唤醒，空闲时按等待时间结束；同一会话只保留最新一项；daemon 重启、范围丢失、未来游标都回答 `reset`；按字节限额；关闭时释放等待 |
| `host-local-ops.test.ts` | 只在本机端点提供；逐项拒绝无效参数 |
| `desktop-lane.test.ts` | `appEvents` 走 `events` lane |
| `daemon-run-transport.test.ts` | 解析回答；跳过不认识的通知种类；格式错误时拒绝 |
| `daemon-event-pump.test.ts` | 按序转发并跟随游标；`reset` 发 `resynchronize`；失败按 100→150 ms（封顶）暂停，恢复后发一次 `resynchronize`；没有这个 op 时停止；关闭后不再发送 |
| `host-process.test.ts`（真实 daemon、本机 socket） | 握手不补发历史；创建会话后收到 `conversation_changed`；改名由 daemon 自己通知；一轮 run 记录后收到运行管线的 `turn_recorded`（以前被丢弃） |
| `app-model-data-update.test.ts` | `resynchronize` 让项目列表重读，`turn_recorded` 不让 |

控制实验：

- 去掉丢失范围的判断 → 两条 feed 测试失败；
- daemon 的窗口通知恢复为空实现 → 真实 daemon 测试在 `turn_recorded` 处失败；
- pump 不把失败的轮询当作可能丢失 → 重试测试失败；
- 恢复后全部通过。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过。
- `npx vitest run src/main src/daemon src/host-runtime src/renderer src/preload src/shared scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts`：4506 passed / 4 failed / 3 skipped，四条失败都是 root 环境原因：
  - 两条「不可读目录」的既有失败；
  - 两条 Electron fixture：root 下拒绝在不加 `--no-sandbox` 的情况下运行，按约定不加。
- 改动的文件都不在 `performance-paths.json` 的 `sources` 里，没有跑 `performance:measure`。

## E2：run 由通知唤醒

| 层 | 改动 |
|---|---|
| daemon | 台账事件（意图、派发、进度、问题、终态）和输出追加都按 run 发通知，交给 `onRunActivity`；daemon 在事件流里写入 `{ kind: 'run', runId }`，同一个 run 只保留最新一项，持续流式输出的 run 不会把别的通知挤出缓冲。只用于观测，抛错不影响 run |
| App | `DaemonEventPump` 把 `run` 交给运行时，第一次回答后报告「事件流可用」，轮询失败时报告「不可用」，丢失通知时唤醒所有 run。`DaemonRunRuntime` 在事件流可用时，读取不在 daemon 等待（`waitMs: 0`），读完没有变化就等本 run 的唤醒，最多等 15 s；绑定等待同样如此，最多 250 ms。事件流不可用时恢复原来的长轮询 |
| 唤醒记账 | `RunWakes`：读取期间到达的唤醒会保留下来，下一次等待立即返回；每次等待都有上限；退出可用状态时唤醒所有等待中的 run，让它们回到长轮询 |

效果：run 不再在共用的 `watch` lane 上各占一个长轮询，一个安静的 run 不会再拖住另一个 run 的启动和文本。

测试：

- `daemon-run-concurrency.test.ts`（E0）改为普通测试。夹具同时提供 `appEvents`，并接上真实的 `DaemonEventPump`：第二个 run 在绑定预算内绑定，文本在第一个 run 的长轮询结束前到达；
- `daemon-run-wakes.test.ts`：只唤醒被点名的 run；读取期间的唤醒不丢；等待有上限；全部唤醒；退出可用状态时释放等待；
- `daemon-event-pump.test.ts`：`run` 唤醒对应的 run；可用状态依次为可用、失败时不可用、恢复后可用；恢复后唤醒全部 run；
- `daemon-run-transport.test.ts`：解析 `run` 通知，拒绝非法 run id；
- `app-event-feed.test.ts`：同一 run 只保留一项；
- `scope-policy.test.ts`：意图、派发和输出都点名这个 run，而且只点名它；
- 真实 daemon：会话发送之后，事件流里有该台账 run 的通知。

控制实验：

- 只加唤醒方法、不改 pump → E0 仍失败（第二个 run 1 s 后仍在等待）；
- 去掉 daemon 的 `onRunActivity` 接线 → 真实 daemon 测试失败；
- 恢复后全部通过。

门禁（Linux 容器，root）：

- `npm run typecheck` 通过；
- 同上范围的 vitest：4515 passed / 4 failed / 3 skipped，四条失败与 E1 相同，都是 root 环境原因；
- `npm run build` 通过；
- `daemon-mode-smoke.mjs` 在 root 下无法启动 Electron（同样的 sandbox 原因），未运行；
- 改动的文件都不在性能路径的 `sources` 里。

E2 改变了流式文本到达 App 的方式，所以 macOS 上需要按 S1 的方法复测首 token 与流式间隔，确认不比原来差。在复测结果出来之前，不对 E2 做性能结论。

## E1b：未读角标

设计见 [P3f §E1b](../P3f-app-event-stream.md)。daemon 保存未读集合，App 决定什么算「已查看」。

| 层 | 改动 |
|---|---|
| daemon | 会话状态的未读发布写入事件流 `{ kind: 'attention', snapshot }`，只保留最新一份；握手回答和 `reset` 回答都附带当前快照。本机端点新增 `attentionViewed(sessionKey)`，幂等，参数逐项校验，网络端点回答 `unsupported_op`。App 报告已查看后，daemon 从未读集合中移除该会话 |
| lane | `attentionViewed` 走 control lane，可以重放 |
| App 角标 | `DockBadgeState` 镜像 daemon 的集合，作为第三个集合计数，并提供给 renderer。App 本会清除的会话如果在 daemon 集合里，就报告给 daemon。快照中正被获得焦点的窗口查看的会话直接按已查看处理，不会闪一下。daemon 连接释放时忘记这个集合（变回未知，不是空） |
| 查看 run | 进程内，聚焦或领养一个 run 会把它的会话标为已查看；daemon 模式下这两个处理函数原来直接返回，现在也会标记 |
| `agent:unreadSessions` | 闸门改为放行，由镜像回答；收到第一份快照之前以命名缺席拒绝 |

测试（均先失败）：

- `dock-badge.test.ts`：计数与快照包含 daemon 集合；新快照替换旧集合；获得焦点的窗口查看时报告给 daemon；正在看的会话不闪；daemon 离开后变回未知；`agent:unreadSessions` 在未知时拒绝，进程内照常回答；
- `app-event-feed.test.ts`：握手与 `reset` 回答带当前状态，同类状态只保留最新一份；
- `host-local-ops.test.ts`：`attentionViewed` 只在本机端点提供，参数校验；
- `desktop-lane.test.ts`、`daemon-run-transport.test.ts`、`daemon-event-pump.test.ts`：lane、解析与转交；
- `agent-runtime-ipc-daemon-view.test.ts`：daemon 模式下聚焦或领养 run，获得焦点时清除 daemon 的未读，未获焦点时保留；
- 真实 daemon：会话发送结束后，握手快照里的未读正好是这一轮的原生会话；逐个报告已查看后，事件流里的快照变为空；
- `daemon-channel-gate.test.ts`：路由为 main 的通道全部放行，不再有例外。

控制实验：

- 角标清除时不报告给 daemon → 「获得焦点时报告」失败；
- daemon 本机端点不提供 `attention` → 真实 daemon 测试失败；
- daemon 模式下聚焦 run 时不标记 → 聚焦测试失败；
- 恢复后全部通过。

门禁（Linux 容器，root）：

- `npm run typecheck` 通过；
- 同上范围的 vitest：4527 passed / 4 failed / 3 skipped，四条失败与之前相同，都是 root 环境原因；
- `index.ts` 在性能路径里，跑了 `npm run performance:measure`：Ratchet 通过，没有 `worse`。

## 未做

- E3 run 集合。
- 未在 macOS 与真实 App 中验证；E2 的毫秒影响未测。
