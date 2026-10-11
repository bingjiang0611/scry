# iOS 持久通道、实时观察与停止 · 2026-10-10

## 问题与证据

- 真机每个请求都新建 event loop、DNS/TCP、外层 TLS、WebSocket 升级、relay 会合与内层 mTLS。实测约 2 s/次。
- 运行观察每轮顺序调用 `runState`、`poll`、`questions`、`output`，再固定 sleep 0.8 s，约 6 s/轮。任一次失败就停止观察，需要手动重试。
- 手机没有停止协议。远程运行不在 Mac `RunRegistry`，但 `ProviderRunHandle.interrupt()` 已存在。
- Mac 只保留 2 个等待 leg。Durable Object 在没有等待 leg 时以 1013 `no_host_leg` 关闭设备连接。长时间空闲的 leg 可能已在中间网络失效。

## 合同

- **持久 lane**：`RelaySession` 为 control / watch / bulk 各保持一条内层 mTLS 隧道。主机仍对每个请求按已验证的对端证书重新授权。只有以 `{"keepAlive":true,` 开头的回复证明主机保持隧道；旧主机的一次性回复会让 lane 关闭，排队请求转到新隧道。
- **重试边界**：打开 lane 时没有发送任何请求字节，可以重试 3 次（证书/anchor 拒绝除外）。请求字节写出前失败可以重发。写出后失败只对读请求重放一次；submit、answer、stop 不自动重放，UI 继续按 intentId / answerId 对账，结果标为未知。
- **watch**：主机长轮询，最多 20 s。有 ledger 事件、输出、reset 或终态时立即返回。问题打开/关闭会写 ledger 生命周期，所以也会唤醒。旧主机返回 `unknown_op` 时回退到旧的四次读取。
- **断线**：传输失败时自动退避重连（0.5 s 起，上限 8 s，最多 20 次），显示"连接中断，正在重连"，不显示终态。主机拒绝（如撤销设备、未知 run）不重试，直接显示观察中断。
- **停止**：`stop` 只返回请求回执（`requested` / `already_requested` / `not_running`），并记录 `stop_requested` 进度事件。生命周期仍以 Provider 实际结果为准。
- **生命周期**：进入后台时关闭隧道；网络接口变化时关闭隧道；回到前台时预热 control lane，并恢复因传输中断而停止的观察（只读，不重发 prompt/answer）。
- **Mac relay pool**：运行通道保持 3 个等待 leg。等待超过 55 s 的空闲 leg 会被回收并补充，正在承载设备会话的 leg 不回收。
- **UI**：工具调用与紧随其后的工具结果合并为一行（显示结果行数，展开可见两者）。没有观察到调用的结果仍单独显示。发送按钮在可停止的运行期间变为停止按钮。

## 检查

- Node remote：27 个文件，223 PASS。新增覆盖：watch 唤醒、撤销设备拒绝、stop 转发到 executor、kept lane 的写请求、回复前缀、`keep_alive_required`、空闲 leg 回收、stopSignal → interrupt。
- Swift package：27 PASS。新增 `LaneHandlerTests`：握手前不发送、单请求串行、一次性回复把排队请求标为 notSent、断线时区分 lost/notSent、陈旧 leg 握手超时、不活动截止时间。
- `smoke:relay-run`：真实 Swift 客户端经生产 relay-server、反向隧道、InnerMtlsHost、HostController，6/6 PASS。新增两项：
  - 一个 `RelaySession` 承载 submit 与全部 watch。三段相隔 300 ms 的输出各唤醒一次 watch（约 300 ms/次），总耗时 949 ms。
  - stop 到达正在运行的 executor 的 abort signal，run 以 executor 的真实结果进入终态。
  - 该 smoke 原脚本因 Node strip-only 不支持 TS parameter property 无法运行，并且使用旧的同步 `createHostController`。已改为 `--experimental-transform-types` 并修正 await/output store。
- Typecheck 通过。全量 unit（排除 `.local/**`）：2523 PASS，1 失败：`scripts/owned-app-processes.test.mjs` 的 `ps lstart` 正则不兼容 `en_NZ` locale（日在月前）。`LC_ALL=C` 下 2/2 PASS。与本改动无关，未修改。
- `npm run pack`（`LC_ALL=C`）仍会收集 `.local/**` 下其他 agent 的备份与 mutation 测试（5 失败），因此单独执行 `test:shell`（PASS）与 `pack:artifact`。
- `pack:artifact` 首轮：构建、签名、`check:packaged-app` 通过；`electron-security-smoke` 在清理阶段失败：一个正在退出的 zsh 从 `/bin/zsh -l` 变为 `(zsh)`，身份校验拒绝发送信号。重跑 `smoke:electron` 通过。首轮失败保留在此。
- Mac：安装 0.2.168，确认没有 Scry 托管的运行后退出并重启。正在运行的进程映射的 `app.asar` 大小与产物一致，并包含 `watchRun` / `keep_alive_required` / `idleLegMs`。
- iOS：Simulator 与签名真机 Debug build 通过。Simulator `-uiPreview` 截图确认工具调用与结果合并为一行。

## 未验证与限制

- watch 的 20 s 上限加上 relay 往返，需要客户端 40 s 响应截止。中间网络静默断开时，最坏要等到截止或接口变化事件才会重连。
- lane 每次只有一个未完成请求。bulk 上的大页会让同一 lane 的后续读取排队；control 与 watch 不受影响。
- Claude Code 真机 E2E 未验证：本机 EDR（`com.alibaba.endpoint.aliedr`）把 Claude Code 2.1.226 识别为 `ai_agent` 并 SIGKILL（`claude --version` 退出 137）。手机正确显示 `run_failed … SIGKILL`。这是环境阻断，不是 Scry 结论。
- 远程运行不在 Mac `RunRegistry`，Mac UI 看不到手机发起的运行。手机自己发起的运行改用本机观察到的生命周期显示，其他设备的运行仍显示"未检测到运行"。
- ScryRemote XCTest UI 套件本轮编译通过；运行时 runner 两次未能启动（"hung before establishing connection" / "Unknown application display identifier …xctrunner"），与 README 记录的 Xcode device-service 问题相同。交互结果以下方真机 WDA 重放为准。

## 真机 E2E · 2026-10-10/11

环境：iPhone 17 Pro（iOS 真机，签名 Debug 0.1.11 (13)），Mac Scry 0.2.168，真实 relay；临时工作区 `scry-remote-e2e-1010`；Provider Pi（默认 profile 与 Pi · Rotom profile）。用 WebDriverAgent 点击/截图，所有结论由手机截图、主机 ledger 和工作区文件共同确认。

| 场景 | 结果 |
|---|---|
| 新任务：创建 `hello.txt` | 派发到 settled 约 6 s，流式输出可见；工作区文件内容为 `hi`。 |
| 续写已有 Pi 会话 | 成功；历史 transcript 重新加载快速完成。 |
| 运行中停止（bash 循环） | ledger `stop_requested` → `settled interrupted` 约 1 s。 |
| 提问：`ask_user_question`（Pi · Rotom） | 手机弹出问题表单，选择 `yes.txt` 后提交；Provider 继续并只创建 `yes.txt`。 |
| 提问后前后台切换 | 回答后立即回到主屏 10 s 再激活。bash 工具调用继续流式显示，run 以 `completed` 结束，用量 689/115 与 ledger `result` 一致。 |
| App 重装后重新打开 | 配对保留，首页与历史正常加载。 |

真机重放中发现并修复的问题：

- 收到 `session` 标记或首个输出后仍显示"主机已派发" → 现在提升为"运行中"。
- 费用显示原始浮点 → 保留 4 位有效数字。
- 停止后显示"已完成" → settled 不再覆盖已观察到的 cancelled。
- 新任务入口沿用上一任务的错误 → 两个入口都先 `resetRun()`。
- 未建立会话的条目显示"准备中" → 改为灰色"未建立会话"。
- 会话页对本设备运行显示"未检测到运行" → 显示本机观察到的生命周期。
- 发送按钮在深色背景上对比度不足 → 实心圆形按钮，禁用时变灰。
- 单选问题用折叠菜单，需要两次点击且看不到选项说明 → 所有选项直接列为可点击行，显示说明，选中状态带描边和 `isSelected` 特征；与问题文本重复的 header 不再重复显示。

## 多任务与 Mac 运行 · 2026-10-11

- 合同：新增只读 op `liveRuns`（`status` 通道，长轮询 ≤20 s）。主机列出本机所有远程运行和 Mac 界面发起的运行，只含已授权 cwd，按 runId 排序，revision 是列表的 sha256。可选 `history` 把一个会话的 historyVersion 合并进同一长轮询，替代 iOS 每 3 s 一次的 `historyVersion` 轮询。
- Mac 运行：runId 形如 `run-<base36>-<seq>`。`stop` 走与 Mac 停止按钮相同的 `requestRunStop`；`answerQuestion` 走同一个 `userQuestionBroker`，并校验 runId/questionId 是否仍待回答，否则返回 `question_not_pending`。未授权 cwd 的运行不可见，也不可控制。限制：ledger 只记录“answered”，不记录由哪台设备回答。
- iOS：聚焦运行保持原有 watch。切换会话或新建任务时，已有主机回执的运行会脱离聚焦，继续在 Mac 上运行，并通过 `liveRuns` 显示状态、停止和问题。只有无回执的提交仍需先核对。脱离的运行不归档为“完成”，内容以 Mac 记录的历史为准。首页支持下拉刷新、“进行中”分组和逐行状态（`Mac ·` 前缀表示 Mac 发起）。
- 修复：原始 TCP 中继腿（`createRelayConnect`，用于 `SCRY_REMOTE_RELAY` 和 smoke）从不发出 `relaySession`。持久通道占住的腿仍被计为空闲，连接池不再补充，导致第 `poolSize+1` 条通道收到 `no_host_leg`。现在包装成 JS Duplex，在收到第一个字节时发出该事件。生产 WSS 腿本来就会发出。
- 检查：`src/main/remote` 28 个文件 230 个测试通过（含新的 `relay-connect.test.ts`，旧实现下 2/2 失败）；`typecheck` 通过；Swift 包 27 个测试通过；`smoke:relay-run` 6/6 通过，真实 Swift 客户端在 `status` 通道解码 `liveRuns`；iOS 真机构建通过。`smoke:relay` / `smoke:relay-pair` 在旧代码上同样以 `relay-e2e.mjs:67 .authority` 失败，属于既有问题。
- 真机（0.1.12，Pi · Rotom，临时工作区）：
  - A（sleep 60）和 B 并行。B 在等待决定时新建了 C，B 被脱离，横幅显示“另一个任务等待你的决定”。点击横幅打开 B 并回答 blue，`b-par.txt`=blue。ledger 显示 B 的等待（11:40:31–11:42:55）与 C 的运行（11:42:14 起）有重叠。
  - 首页逐行显示“运行中 / 等待决定”。运行结束后，历史通过长轮询自动刷新。
  - 真机发现：脱离的远程运行在新会话中显示 `history_unavailable`，原因是远程运行不在 Mac 的活动运行内存中，会话记录要到运行结束才写入。修复：手机通过 `watch` 读取该运行在主机上的真实输出。只有当历史里还没有这一轮时才显示，避免与实时写入的转写重复。复测（任务 D）：运行中显示 prompt 和 `bash`，结束后由历史接管，没有重复。另外，脱离运行的文本增量与聚焦运行一样合并显示。
  - 停止脱离的远程运行（任务 E，`sleep 120`）：重新打开该会话，点"停止"并确认。ledger 依次记录 `stop_requested`、`settled interrupted`、`run_settled`；`e-par.txt` 未生成；历史中显示 Pi 的诚实标记（缺少明确的工具终止证据）。
  - Mac 发起的运行（Mac 界面在会话 B 中追加）：手机横幅显示“另一个任务等待你的决定”，点开后在手机上回答。`m-par.txt`=dog、`m2-par.txt`=moon，Mac 上的问题表单随之关闭，Mac 记录 DONE-M / DONE-M2。停止前弹出确认“停止 Mac 上的这次运行？”。确认后按钮显示“请求中…”，Mac 上 `run-mv3bm9cb-2` 在 38.6 s 结束，bash 标为失败，`s-par.txt` 未生成。
  - 真机发现：横幅在会话页内切换到另一个会话时，骨架屏一直不消失（超过 40 s）。原因是可编辑的 `SessionTranscriptView` 没有按会话设置 `.id`，同一路由内切换会话不会再次触发 `onAppear`，也就不会加载新会话。修复：与只读视图一样按会话设置 `.id`。复测：横幅切到 B 后立即显示 B 的历史和 Mac 正在运行的这一轮，运行结束后更新为 DONE-M2。
  - 骨架屏耗时（DEBUG 计时，已删除）：有缓存窗口的会话 turns 用 0.64 s；未缓存、刚结束的会话 preview 用 2.1 s，turns 用 0.7 s；运行中的脱离会话第一次 preview 用 2.1 s，第二次 0.6 s。差值来自 `bulk` 通道空闲后的重连，不是主机读取。修复：已有脱离运行的实时内容时不再显示骨架屏。
  - 未验证：下拉刷新的转圈动画（WDA 串行执行，手势结束前无法截图；代码确认 `.refreshable` 挂在首页 ScrollView 上）；脱离运行的分段增量合并没有在“历史接管前”截到最终回复。
