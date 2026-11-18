# B4-L4-2c `conversation:send` 经 daemon

方案见 [P3-conversation-send](../P3-conversation-send.md)，维护者 2026-11-10 批准（参照 t3code）。上级状态见 [b4-l4](b4-l4.md)。

## 做了什么

| 层 | 改动 |
|---|---|
| 会话服务 | `ConversationService` 未改。daemon 给它的 `startAppRun` 依赖改为：把 `{ request, managedConversation }` 登记到 `ManagedLaunches`，以调用方的本机 grant 提交台账 intent（`conversation-run:<runId>`），等 run 注册后再 resolve |
| 台账路由 | intent 只带 cwd、provider、profile、显示用 prompt 和 `conversation: { conversationId, runId }`。只有本机 scope 能带这个标记，设备提交带它会被拒 |
| 派发 | `createRemoteRunBinding` 看到标记就取出登记项（只能取一次），规范 run id 用会话 turn 的 `runId`，请求与附件用登记项里的原件；取不到时在启动 Provider 之前失败（`conversation_start_unavailable`），目标不一致时拒绝（`conversation_start_mismatch`） |
| run 管线 | 新增 `onStarted`：台账 run 原本只在结束时 resolve，现在在注册并通过准入时（与进程内 `startAppRun` 返回的同一时刻）通知，`send` 才能在这一刻回答 |
| 派发前被拒 | 新增 `onDispatchRefused`：台账在到达 binding 之前就拒绝的 run（策略、路由、附件），通知 daemon 让对应的 `send` 失败；只认本机 scope 的 intent |
| 本机 op | `handleLocalOp` 把已验证的 peer 放进本次调用的上下文（`AsyncLocalStorage`），台账提交用它 |
| App | 闸门把 `conversation:send` 转给 daemon；结果处理器用回答里的 `ledger: { runId, seq }` 跟上这轮 run（`DaemonRunRuntime.follow`，从 intent 序号开始 watch），再发 `conversation_changed`，交给 renderer 的仍是 `{ runId, disposition }` |
| 绑定标记 | App 原来只接受 `run-…`/`remote-run-…` 形状的规范 id，会话 run 的 id 是 UUID（进程内本来就是），现在也接受 UUID |

顺带：`run-execution.ts` 已到 19,981 字节，把 `RunHost` 依赖类型按职责拆到 `run-host.ts`。

## 测试（均先失败或先不存在）

| 测试 | 断言 |
|---|---|
| `managed-launches.test.ts` | 只提交路由；注册后 resolve；只能取一次；派发前被拒使 `send` reject；未记录时撤回；容量上限；设备 scope 的拒绝不影响 App 的登记项 |
| `scope-policy.test.ts` | App 提交的标记原样到达 run 启动；设备提交和格式错误的标记被拒；派发前被拒会通知，正常启动的不通知 |
| `remote-run-binding-conversation.test.ts` | 用登记项的 run id、请求和 `managedConversation`；取不到时不调用 `startAppRun`；目标不一致时拒绝；未注册就失败才回报，注册后的失败归会话自己结算 |
| `host-local-ops.test.ts` | 并发调用各自拿到自己的 peer，调用之外没有 |
| `host-process.test.ts`（真实 daemon、本机 socket、smoke Provider） | `conversation:send` 回答带 `ledger`；台账 run 结束为 `settled`；`bound` 的 `scryRunId` 等于会话 turn 的 `runId`；会话 turn 的投递状态为 `accepted` |
| `daemon-run-watch-start.test.ts` | `follow` 从 intent 序号开始，两次 watch 内绑定到会话 turn 的 id |
| `daemon-run-evidence.test.ts` | 绑定标记接受 UUID，拒绝其他形状 |
| `conversation-daemon-send.test.ts` | 先跟上 run 再通知窗口；跟随失败仍回答（run 是真的）；结束了的重复命令不跟随；daemon 拒绝时不通知；回答格式错误时拒绝 |

控制实验：binding 不取登记项 → 第三行第一条失败；去掉 `onStarted` → 真实 daemon 测试的 `send` 永远不返回（30 s 超时）；登记项取后不删除 → 「只能取一次」与「派发前被拒」失败；结果处理器不跟随 → 前两条失败；恢复后全部通过。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过。
- `npx vitest run src/main src/daemon src/host-runtime scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts src/renderer/hooks src/preload`：3311 passed / 2 failed / 3 skipped，两条失败是 root 下「不可读目录」的既有环境失败。
- `npm run performance:measure`：Ratchet 通过，没有 `worse`（改动只给运行管线加了一个可选回调；L1，未测毫秒）。

## 过程中发现

- web 的类型检查包含一个引用 `remote-run-binding.ts` 的 renderer 测试。binding 一旦以类型方式引用会话服务，就会把整个会话存储拉进 web 程序，暴露 `jsonl-record-scanner.ts` 在 web 配置下的既有不兼容。现在 binding 只依赖 `{ conversationId, runId }` 两个字段，具体类型由宿主传入。
- `daemon-run-stream.test.ts` 的等待条件是「视图显示 done」，而视图的 done 来自台账生命周期，可能早于最后一次 trace 读取的投递。第一版重构让 `start` 晚两个微任务返回，这个测试就漏了最后一段文本。已改回不移动 `start` 的时序；这个测试对时序的依赖是既有的，记在这里。

## 已知限制

- daemon 在 intent 记录之后、派发之前重启：台账记为带原因的 `run_failed`，Provider 没有被调用，但会话 turn 由已有的启动恢复记为 `unknown`。可以证明它是 not_sent，要做到需要恢复前读取台账，记为后续项。
- 设备（手机、另一台 App）跟随这类 run 时，它们的绑定标记校验同样只接受 `run-…` 形状，暂时读不到 trace；它们看到的是台账 run。
- 未在 macOS 与真实 App 中验证。
