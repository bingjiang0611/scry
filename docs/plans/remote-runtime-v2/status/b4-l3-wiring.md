# B4-L3 接线层：App 的 run 走 daemon

分支 `claude/remote-runtime-v2`。本文件记录 App→daemon 的帧、视图、重连、空 cwd、真实拉起与 L2 计时；语义层见 [b4-l3-scope](b4-l3-scope.md)。

## 第 1 步进展（本轮）

已落地，且不改变任何现有行为：

- `AppRunStartOptions.grantScope`：`'local' | 'remote' | undefined`，只对 `origin: 'remote'`（经台账提交）有意义。
- `runSemantics({origin, grantScope})`（`run-frontdoor.ts`）是唯一的推导处：in-process 恒为 `{isRemoteRun:false, appSemantics:true}`；经台账提交时只有已验证 `grantScope: 'local'` 才 `appSemantics:true`，**缺失按 `false`（fail closed）**。
- `prepareRunFrontdoor` 返回两个标志（`isRemoteRun`、`appSemantics`），下游还没消费。
- 新增 `src/main/bootstrap/run-semantics.test.ts`（3 条），其中一条专门守「缺失 scope 不得当作本机」。

- `grantScope` 已从 `remote-run-binding`（规范路径）透传到 `RemoteStartOptions` 与 `runtime.startAppRun` 的选项，类型上 `RemoteStartOptions.grantScope` 缺失即表示「无法证明」，下游仍按设备语义。

**尚未做**：上游三处按 scope 分开、把「提交者语义」各行切到 `appSemantics`、P1/P2 的对照测试。在这些完成前，本机 grant 的 run 仍走完整条远程分支（只是现在 `grantScope` 已经能到达 frontdoor）。

## 已完成：App→daemon 的 run 帧解析层

`src/main/daemon-run-transport.ts`：只解析与定型手机同款帧（`submit` / `intentStatus` / `watch` / `desktop(kind:trace)` / `output` / `stop` / `questions` / `answerQuestion` / `liveRuns` / `runState`），不持有 socket、凭据或 run 状态，测试用注入的 `request` 驱动。

诚实边界写进类型与测试：host 的 `device_not_authorized` 变成 `daemon_device_not_authorized`；没有 `runId` 的回执、`stop.status=unknown`、`answer=false`、缺 `chunks` 的 output 一律报失败，不补空成功；传输层抛错归为 `daemon_not_running`。

测试：`src/main/daemon-run-transport.test.ts` 11 条。

## 已完成：以 daemon 为源的 run 视图

`src/main/daemon-run-runtime.ts`：一个 watch 窗口 + 一次 trace 读取就是一步（`step`），pump 循环按 run 串行（同一 run 只有一个窗口在飞，否则同一批 items 会被推两次）。要点：

- **不伪造进度**：delta 只在 `index >= 已推送条数` 时当追加；改写了历史项就置 `resyncRequired` 并发 `agent:traceHealth`，让视图回读权威快照，不重放成追加。
- **start 回执用 canonical runId**：daemon 在 `run_progress` 里用 `bound` 标记绑定自己的 `run-…` id；`start()` 等这个标记（默认 3s 预算），拿到就返回它，拿不到就返回 ledger id 并标 `bound: false`，不假装 trace 会对上。
- **生命周期未知不等于结束**：daemon 不再报告该 run 时 pump 停止；`device_not_authorized` 之类只记原因并停泵，不产出任何事件。
- **提问去重**：同一 `questionId` 只发一次 `agent:question`，答完发 `agent:questionClosed`。

测试：`src/main/daemon-run-runtime.test.ts` 7 条。控制实验：把 delta 过滤改成不过滤，2 条测试立刻失败（证明「改写不得当追加」这条规则真的被测住）。

## 已完成：N3 工作区能力进 catalog（UI 隐藏 + 原因）

- `WorkspacePanel` 新增 `ops`：只有宿主**明确**报 `false` 才移除动作；宿主没报能力时保持原行为（老宿主不会因为少了新字段就丢功能）。
- 受限时：`openFile` 不再调用外部打开（改为面板内预览），上下文菜单不再渲染「移入废纸篓」，面板顶部显示原因（`此工作区不支持：…`）。
- `RemoteChatView` 把 `catalog.workbenchOps` 传进去；本机面板不传，行为不变。
- 文案集中在 `resolveWorkspaceOps` 一处，测试：`src/renderer/components/render-tests/workspace-files.tsx` 新增 3 条（含宿主未报能力保持原行为）。

## 已完成：重连与重新订阅

- `activeRuns()` 以 daemon 的 `liveRuns` 为准：本窗口没启动过的 run 会被 `adopt`（一次有界读取），Provider 与目录只从 daemon 的 `bound` 标记拿，不猜。
- `daemon-run-lazy` 在 `daemon_not_running` 上重连一次：先 dispose 旧 mode（关掉死连接），再重建，然后重放同一个调用。只对「连接没了」重连；`daemon_stop_not_confirmed` 这类 run 级回答不重连。重提安全的前提是 intentId 就是 daemon 的幂等键。
- 测试：`daemon-run-runtime.test.ts` 8 条（新增 adopt）、`daemon-run-lazy.test.ts` 4 条（重连、不重连、拒绝原因、开关关闭）。

## 已完成：diff 预览与提问路由按提交者

- `run-diff.ts`：需求通道只在 `appSemantics` 为真时存在（App 本来就是这样），设备提交者仍是 `undefined`。
- `run-provider.ts`：提问交给本机 broker 的条件改成 `appSemantics`；`run-startup` 负责透传。
- 对照测试：`src/main/bootstrap/run-diff-scope.test.ts`（2 条）。
- **诚实标注**：提问路由没有独立单测——要真的驱动一次 Provider 提问才能证明，当前只在类型与装配层保证「不再读 `isRemoteRun`」；从 `submit` 驱动的那份对照测试仍待补（见 P2）。

## 已完成：P2 空 cwd（按方案 (b)）

- `parseRouting(detail, { cwdOptional })`：只有本机 grant 允许不带 cwd；设备提交仍必须给出目录（没有 App 的当前工作区可回落，猜一个等于授予用户没打开过的工作区）。
- `RemoteRunPolicy.authorize`：未命名目录时只有 `grantScope === 'local'` 放行，设备得到 `invalid_target`；**给了名字就仍然走工作区授权**，授权没有消失。
- `remote-run-binding`：`routing.cwd` 为空时不写 `cwd` 字段（写 `''` 会被 App 当成路径），由 App 自己的 `currentCwd` 回落。
- 测试：`scope-policy.test.ts` 新增 2 条（本机未命名提交放行且 `routing.cwd === ''`；设备同样的请求不启动 run；本机提交到未授权目录仍被拒），`remote-run-binding.test.ts` 新增 1 条。**控制实验**：把三处改动 stash 掉后，「本机未命名提交」这条立即失败。

## 开关打开时「进程内不再执行 run」

`createRunPipeline` 新增 `execution: 'in-process' | 'daemon'`。开关打开时 `index.ts` 传 `'daemon'`：登记表、trace 视图、停止请求这些**其它通道仍在读**的部分照旧组装，但 `startAppRun` 直接以 `daemon_mode_owns_runs` 拒绝，and 不落到 `startRun` / `startWorkspaceRun`（workspace 分支也一样，所以两个入口都断言了）。

护栏：`src/host-runtime/run-pipeline-execution.test.ts`（2 条）——登记表与 trace 视图仍可用；`startAppRun` 拒绝且两个执行入口一次都没被调用。**控制实验**：删掉那行守卫后，测试报「期望 daemon_mode_owns_runs，实际 provider must not start」，且执行入口被调用。

**诚实边界**：这是「执行归属」的构造断言，不是把组装整体删掉——登记表对象仍然存在，因为侧栏/历史/用量等通道还在读它。整体删除与 `SCRY_HOST_DAEMON` 开关一起，属于 B4-S。

## run controls（steer / 后台任务停止 / adopt）

这三个通道原来在 daemon 模式下仍读 App 进程内的登记表，而 daemon 的 run 根本不在那里：steer 会得到「运行、Provider、目录或会话身份已变化」这种误导性拒绝，adopt 返回 `null`。现在按 ops 表既有定义实现 `runControl` op：

- daemon：`host-run-control.ts` 按 `method: steer | stopBackgroundTask | adopt` 分派，复用 `run-steering.ts` 与 `background-task-control.ts`（同一套校验，不另写）；`host-process` 用 daemon 自己的 `pipeline.runs` 构造处理器。
- **只在本地端点存在**：`InnerMtlsHost` 的 `runControl` 只在 `createLocalHost` 传入；网络端点没有处理器时该 op 返回 `unsupported_op`，不是从别的进程内存里编答案。旧 daemon 同样返回 `unsupported_op`，App 映射为 `daemon_run_control_unavailable`（命名缺席，不是空成功）。
- App：`DaemonRunTransport.runControl` 发一帧；`DaemonRunSurface` 的 `steer`/`stopBackgroundTask`/`adopt` 解析结果，读不懂就报错；`agent:steer`、`agent:stopBackgroundTask`、`agent:adoptActiveRun` 在开关打开时走 daemon，adopt 成功后把该 run 设为当前聚焦。

测试：`host-run-control.test.ts`（5 条：未知 method、分派、adopt 的 runId 校验、有/无处理器、多余字段被拒）、`daemon-run-transport.test.ts`（+3 条）、`daemon-run-surface.test.ts`（5 条）。

## 编辑最后一条消息（turn 边界）

App 的「编辑并重发」是 `forkLastTurn` / `restartLastTurn`，`workspace` 准备是另一条流程。routing 不吞字段：

- turn 边界：只在 App 提交（`cwdOptional`）时接受，并且**复用** `shared/runtime-provider.normalizeAgentStartRequest` 校验与规范化，不写第二套 schema；结果原样进 `RemoteIntentRouting`，再由 `remote-run-binding` 放进 `AgentStartRequest`。测试：`scope-policy.test.ts`（submit 层）、`remote-run-binding-canonical.test.ts`（绑定层）。
- `workspace` 准备：需要 commandId 与明确的新会话，这一帧带不了，按名字拒绝（`unsupported_local_request:workspace`），不静默降级成普通 turn。

## 真实拉起 + 入网（L3 剩余第 4 条）

`scripts/daemon-launch-enroll.mjs`（独立临时 userData，`/tmp/scry-launch-*`）用 **App 自己的 supervisor 入口与环境** 拉起后台服务，然后做 App 首次接触时做的事：

| 步骤 | 结果 |
|---|---|
| supervisor → daemon 起监听 | `local.sock` 与 `enroll.sock` 都出现 |
| 用一次性 secret 入网 | 成功 |
| 用该证书发 `daemonInfo` | 通过 mTLS 得到 `{op:'daemonInfo', version:'0.0.0-launch-acceptance', protocol:2}` |
| 同一个 secret 再入网一次 | 被拒（一次性是安全声明，不是便利） |
| SIGTERM → 退出 | 进程收敛，临时目录清理 |

**未覆盖**：脚本不经过 App 的 `spawnDaemonSupervisor` 代码（同一入口、同一组环境变量，但调用方是脚本）；App 的凭据加密存储不在这一条里。脚本复用 `scripts/daemon-fixture.mjs`（enroll + mTLS 帧），与 `scripts/daemon-trace-latency.mjs` 共用，协议常量与 `REMOTE_PROTOCOL_VERSION` 一致（2）。

## L2 计时（B4-D 第 4 条 / trace 预算）

命令（串行、加锁）：

```
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs daemon-trace-latency -- \
  node scripts/daemon-trace-latency.mjs
```

结果（本机 8 核，1 分钟负载 3.32，`highLoad: false`，40 个样本，2026-11-07 本轮）：

| 指标 | P50 | P95 |
|---|---|---|
| 一窗 `watch` + 一次 trace 读取（unix socket，真实 daemon） | 3.32 ms | 3.89 ms |
| 同样的两帧在内存里解析 | 0 ms | 0 ms |
| **增加量** | 3.32 ms | **3.89 ms**（预算 10 ms） |

**这不是端到端首字时间**：脚本读的是 daemon 里不存在的 run，所以载荷很小，真实 transcript 多出来的传输时间没有算进去；它测的是「App 的泵每轮多付一次 socket 往返」。脚本用 `out/main/daemon.js`（构建时间 2026-11-07 17:51，晚于本次改动的 daemon 源文件）。协议版本门、enroll、mTLS 都走真实路径。
