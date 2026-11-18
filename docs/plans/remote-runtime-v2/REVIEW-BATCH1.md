# Batch 1 核验结论（核验方，2026-11-03）

核验对象：`claude/remote-runtime-v2` 的 `aada148..a0b2355`（20 个提交，author/committer 均为 noreply 身份）。

**结论：有条件通过。** T0–T6 都按任务书完成，STATUS 诚实（未测项都标了 not-run 或「未宣称」）。下面 4 个必须修的问题都是小改动，修完再进 Batch 2 的 P3 代码；在此之前不要安装到日常使用的 App。

## 核验方复跑

环境：Linux 容器、Node 22.23.4、root 用户、`npm ci --ignore-scripts`（未装 Electron 二进制）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `git diff --check aada148..HEAD` | 通过 |
| `npx vitest run src/main/remote src/main/providers src/renderer/components scripts/performance-counters` | 1762 / 1765 通过。3 个失败都是本容器环境：`MarkdownLayout`、`SessionRename` 需要 Electron（root 下无 sandbox、二进制未装），`desktop-directory-picker` 的 `chmod 0` 拒绝读取在 root 下不生效。均与本批改动无关 |
| `test:desktop-remote`、`performance:measure`、`swift test` | 核验方未运行（无 macOS / Electron / XCTest），采信执行方记录 |

## 必须修（进入 P3 前）

### F1 · 取消排队中的请求会拆掉另一个请求的连接
`src/main/remote/desktop-lane.ts` `request()` 的 `onAbort`：`if (state.busy) this.#dropChannel(state)`。`state.busy` 表示 lane 上**当前**在跑的交换，可能是更早的另一个调用。在 bulk 或 watch lane 上取消一个还在排队的读，会断掉前一个正在等回包的请求，使它被迫重放（或在已重放过一次后失败）。
修法：记录当前交换属于哪个 call（例如 `state.current = call`），只有 `state.current === call` 时才 drop。补测试：A 在途、B 排队，取消 B，A 正常返回且只握手一次。

### F2 · 写操作的 notSent 判定比 iOS 宽
`#exchangeOnLane` 把 `channel.send()` 的任何失败都当作 notSent 并重发，写操作也不例外。`socket.write` 回调报错时字节可能已部分到达宿主，不能证明「未发送」。iOS `Lane.swift` 的 notSent 只来自发送前的状态检查（通道已关闭、不再接收请求）。`sessionFork`、`sessionDelete` 没有幂等 id，重发可能 fork 两次。
修法：只有发送前检查到通道已关闭（`closed` 预检）才算 notSent；`write` 回调报错对不可重放请求按 lost 处理（报 unknown）。补测试：写请求在 write 回调报错时不重发，宿主只收到 0 或 1 次。

### F3 · `LIVE_RUNS_TICK_MS` 1000 → 250 让带 history 的长轮询多做 4 倍工作
`host-controller-watch.ts` 的 `liveRuns` 每个 tick 都调用 `readHistoryVersion`（iOS 会带 history）。tick 缩到 250 ms 后，每个打开会话的手机每秒做 4 次历史版本读取，代价未测。
修法（二选一）：给 Mac run 来源加变更通知（`macRuns` 变化时 `notify()`），tick 恢复 1000 ms；或只对 Mac run 集合用 250 ms，`historyVersion` 仍按 1000 ms 节流。补计数测试：一次 20 s 空等窗口内 `readHistoryVersion` 调用次数有上限。

### F4 · 打开会话对所有 Provider 预热，但只有 Pi 有热池
`remote-provider-prewarm.ts` 对任意 providerId 调用 `listCommands`。按 T1 调研，Claude 的命令/控制读取是每 30 s 窗口一次 SDK 冷启动，没有热池；Codex/OpenCode/Qoder 已有各自常驻池。对 Claude 预热只会在每次打开会话时多付一次冷启动，没有后续收益。
修法：只对声明了热池的 Provider（当前为 Pi）预热；或先用 T0 指标测 Claude 预热的实际代价再决定。补测试：Claude 会话打开不触发预热读。

## 建议（可并入 Batch 2）

- **S1 trace 读取频率。** `POLL_MS` 改为 250 ms 后，活跃 run 每批 ledger 事件都会触发一次 `traceDelta`，峰值可能从约 0.67 次/秒升到约 4 次/秒。请用 T0 指标在一个真实活跃会话上测一次；若明显升高，把 trace 读取合并到 ≥ 500 ms。
- **S2 本机侧预热与活跃 run 续期**（T1 已知限制）。P3 之后 main 变成客户端，预热自然走远程同一路径；续期可以在 `watchLifecycle` 有活跃 run 时 `touch`。
- **S3 iOS 必须和宿主一起升级。** 宿主现在拒绝不带 `protocol` 的请求，已安装的 iPhone App 会全部失败。另外 Swift 断言尚未运行。安装这批宿主代码前，先在有完整 Xcode 的机器上跑 `swift test --package-path experiments/remote-g0/swift --filter 'WireTests|LaneHandlerTests'`，并重新构建手机端。
- **S4 host-controller 大拆分。** `075c57e`、`d151b2c` 为通过 20,000 B 门禁把 `host-controller.ts` 拆成十余个文件，属于纯搬移但 diff 无法逐行核对行为，目前依赖测试覆盖。后续改动这些文件时注意保持每个文件单一职责，不要再回到大文件。

## 对执行方「需要决定」的意见

1. **测量夹具双重 stringify（`trace.r4-cell/other` +20.86 MB）**：同意不改。它是夹具建模成本，比生产更悲观，ratchet 未登记该 cell。
2. **拆分 `scripts/performance-paths.json`**：建议批准。后续 trace 登记（F3 的计数、P3 的 daemon 指标）都需要空间。

## P3 / P4 设计稿

两份设计稿结构完整，逐条对照了 CLAUDE.md 不妥协项，可以作为 Batch 2 的基础。核验方对其中「需要维护者决定」的建议：

| 文档 | 问题 | 建议 |
|---|---|---|
| P3 | 本机通道认证 | ① mTLS over unix socket，与远程同一协议、同一鉴权 |
| P3 | daemon 退出 | 不随 App 空闲退出；菜单提供「退出 Scry 与后台服务」，有运行中 run 时二次确认 |
| P3 | daemon 与 App 版本不一致 | 硬失败，要求一起升级 |
| P3 | Linux 托管 | 只做 `systemd --user`，无 systemd 时明确提示手动启动 |
| P3 | 打包 | electron-builder `extraResources`，同一产物，不另开包 |
| P4 | 事件表与 ledger | 让 `SessionLedger` 演进成唯一写者 |
| P4 | `run.progress` 粒度 | 方案 A：只记生命周期转折；正文留在 trace archive，事件只存指针与质量标记 |
| P4 | projection 存放 | 现有 App SQLite（已定决策） |
| P4 | 客户端本地回执 | 保留加密状态文件作缓存；冲突时以宿主回执为准，不一致显示为 unknown 并按 intent 核对 |
| P4 | `catalogSnapshot` | 保留为冷启动首帧，后续更新交给订阅 |
| P4 | outbox 幂等 | 集中 policy 表，每种副作用必须登记是否可重放 |

## 下一步

Batch 2 = F1–F4 修复 + S1 测量 → P3 daemon 实现。维护者确认上面的决策后，核验方写 `EXECUTION-BATCH2.md`。
