# W 段：daemon run 的窗口通知补齐

起因：bfd38da 的 macOS 验证（见 [b4-l4-local-verification](b4-l4-local-verification.md)）。daemon 模式下有三个现象：

- 会话视图没有文字，一直停在「运行中」；
- 输入框停在「记录收口中」，第二条消息一直排队；
- 一轮结束后侧栏不刷新。

父提交上的现象完全相同，所以不是 E1–E3 引入的。上级状态见 [b4-l4](b4-l4.md)。

## 原因

进程内，运行管线会给窗口发十来种通知。daemon 模式下，App 只为 daemon 的 run 补发了四种：文本流、流的健康状态、提问出现与关闭。少了两条渠道：

1. **run 的窗口通知。** daemon 的管线其实会发 `agent:turnDone`、`agent:error`、`agent:session`、`agent:stopState`、`agent:backgroundWork`、`agent:questionAttention`，但 daemon 里接收这些通知的窗口只是个空壳，E1 之后只转发了数据更新通知。其中 `agent:stopState` 和 `agent:backgroundWork` 还会因为 daemon 报告「没有窗口可接收」而直接不发。
   - 后果：renderer 收不到「这一轮结束」，输入框停在「记录收口中」；停止后界面不进入结束状态；renderer 原本靠 `agent:session` 和 `agent:turnDone` 刷新侧栏，也就不刷新了。
2. **按 run 订阅的输出。** 会话视图不读窗口级的文本流，而是按 run 订阅（`runTraces:*`）。这个订阅由 App 的进程内路由回答，路由只查 App 自己的 run 列表，里面没有 daemon 的 run，所以每次都回答 `unavailable`。

## W1：转发管线自己的窗口通知

| 层 | 改动 |
|---|---|
| daemon | 管线的窗口接收端按允许列表（`DAEMON_WINDOW_NOTICES`，就是上面那六种）把通知写入事件流 `{ kind: 'window', channel, payload }`，载荷与进程内相同，按顺序发送、不合并。文本流、流健康状态和提问不在列表里，App 按 run 自己读取，并有背压。「是否有窗口可接收」保持 false，因为它还决定提问走台账、让 daemon 自己的文本流保持空闲。窗口接收端新增 `acceptsNotices`，只让那两条被这个开关挡住的通知通过 |
| App | 只接受允许列表里的频道，载荷必须是对象。事件 pump 按顺序逐条处理。`DaemonRunRuntime.deliverAfterRead` 在转交某个 run 的通知之前，先不等待地读一次这个 run，并把文本全部推给窗口，所以「这一轮结束」不会早于最后的文本（进程内也是先推送文本，再发结束）。`agent:stopState` 同时发给这个 run 的订阅，和进程内一样 |

## W2：按 run 订阅能看到 daemon 的 run

| 层 | 改动 |
|---|---|
| 路由 | `RunTraceRouter.attachRuns(source)`：第二个只读的 run 来源。App 自己的 run 列表优先，没有时才查这个来源；daemon 连接释放时解除 |
| 运行时 | `DaemonRunRuntime` 把送达窗口的每个事件、出现与关闭的提问同步交给订阅；run 结束后，在最后的文本之后发一次结束，用的是视图订阅时的规范 id |
| 接线 | daemon 模式挂上运行时的 run，把路由交给运行时和事件接线；`index.ts` 传入现有的 `runTraces` |

顺带：`daemon-run-runtime.ts` 已接近大小上限，提问的发布和回答按职责拆到 `daemon-run-questions.ts`。

## 测试（均先失败）

- 真实 daemon：会话发送之后，事件流里有这个 run 的 `agent:turnDone` 和 `agent:session`，载荷与进程内相同；
- `daemon-run-concurrency.test.ts`，用与生产相同的接线：
  - W1：daemon 有新文本，随后只发了「结束」通知、中间没有 run 通知，窗口仍然先收到文本、再收到结束；
  - W2：订阅先收到文本，再收到一次结束，且结束是最后一项；
- `run-trace-router.test.ts`：只有第二个来源知道的 run 可以订阅、能收到输出和结束；解除后新订阅得到 `unavailable`；App 自己的 run 列表优先；
- `daemon-run-transport.test.ts`：只放行列表里的频道和对象载荷；
- `daemon-event-pump.test.ts`：窗口通知逐条、按顺序处理；没有处理函数时直接发给窗口。

控制实验：

- 不先读取就转交通知 → W1 测试失败；
- 不把事件交给订阅 → W2 测试失败；
- 不发结束 → W2 测试失败；
- 恢复后全部通过。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过；
- vitest（`src/main src/daemon src/host-runtime src/renderer src/preload src/shared` 与两个脚本测试）：4538 passed / 4 failed / 3 skipped，四条失败与之前相同，都是 root 环境原因；
- `index.ts`、`run-trace-router.ts` 在性能路径里，跑了 `npm run performance:measure`：Ratchet 通过，没有 `worse`。

## 发现但没改

- renderer 监听 `remote:sessionRecorded`，但 main 里没有任何地方发出这个频道，两种模式都一样，是一个早已失效的监听。
- 未在 macOS 与真实 App 中验证。
