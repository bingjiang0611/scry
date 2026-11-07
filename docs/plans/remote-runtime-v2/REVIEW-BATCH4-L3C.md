# Batch 4 核验（B4-L3 代码段）

核验对象：`ce3f713..8db2631`，共 17 个提交。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：读状态文件 `b4-l3.md`、`b4-l3-scope.md`、`b4-l3-wiring.md`，对照 `run-*.ts`、`daemon-run-*.ts`、`daemon-run-mode.ts`、`remote-run-policy.ts`、`host-controller-routing.ts` 的源码逐项检查。本轮**没有在本机重跑测试**。

## 结论

**L3 还不能关闭。** 已经做完的大部分质量不错，测试先失败、控制实验和诚实标注都齐全。但有三个问题必须修：

- **M1**：断线后会重发写操作，可能产生重复的 run。
- **M2**：分类表里一半的“提交者语义”行还没有切换，但状态写成了“代码完成”。
- **M3**：开关打开后，没有在真实 App 上验证过任何一条端到端流程。

另有一项计时结果不满足已决定的测量条件（S1），还有一条以“维护者答复”名义记录的决定需要维护者本人确认。

## 接受

| 项 | 说明 |
|---|---|
| 两个标志 | `runSemantics` 是唯一的推导点。in-process 调用恒为 `appSemantics:true`；经台账提交的 run，只有已验证的 `grantScope: 'local'` 才为 true，缺少 scope 时为 false，并有测试守住 |
| 上游三处 | routing 的 `cwdOptional` 只对本机生效；policy 只对本机放行未指定目录的请求，**一旦指定了目录，仍走工作区授权**；fork/restart 复用 `normalizeAgentStartRequest`，没有另写一套 schema；`workspace` 准备请求按名称拒绝，不会降级成普通 turn。控制实验证明“本机未指定目录”这条测试能抓到回归 |
| frontdoor / diff / 提问路由 | 已切换到 `appSemantics`，并有对照测试。提问路由没有独立单测，这一点已如实标注 |
| 执行归属 | 开关打开时，进程内的 `startAppRun` 以 `daemon_mode_owns_runs` 拒绝，两个执行入口都有断言；控制实验能证明这条守卫有效 |
| runControl | steer、停止后台任务、adopt 只在本机端点提供，复用现有校验；网络端点或旧 daemon 返回 `unsupported_op`，App 显示为“不可用”，不是返回一个空的成功 |
| MCP 认证 | 开关打开时，App 进程内的 test/reauth 返回 `daemon_capability_unavailable:mcp-auth`，不在 daemon 的认证队列之外再认证一次 |
| 凭据 | `daemon-run-mode.ts:160-170` 复用了 `unsafeCredentialStorageReason`，Linux 上 `basic_text` 后端会被拒绝 |
| 拉起 | 真实路径使用 `daemonLaunchTarget` 和打包后的 `resourcesPath`、版本号；脚本实测了拉起、入网、`daemonInfo`、secret 重放被拒 |
| run 视图 | 改写历史时置 `resyncRequired`，不当作追加；`bound` 标记拿不到就标 `bound:false`；同一个提问只推送一次 |
| N3 UI | 只有宿主**明确**报 `false` 才隐藏对应操作，没报这个字段的老宿主保持原样；受限时显示原因 |

## 必须修

### M1 断线后会重发写操作，`start` 可能产生第二个 run

`daemon-run-lazy.ts` 的 `call()` 在遇到 `daemon_not_running` 时，会重建连接并把**同一个调用再执行一次**，这对 `start`、`stop`、`answerQuestion`、`steer`、`stopBackgroundTask` 都生效。

而 `daemon-run-transport.ts:236` 会把**任何**传输层异常都归为 `daemon_not_running`，包括请求字节已经写出、但回执丢失的情况。

后果：

- `start`：intentId 在 `daemon-run-surface.ts:85` 生成，取值是 `payload.commandId?.trim() || randomUUID()`，**每次 invoke 都会重新生成**。payload 没有 `commandId` 时，重发会产生一个新的 intent，也就是第二个 run。即使带了 `commandId`，重发也绕过了“结果未知时按 intent 核对”这一步。
- `stop`、`answer`、`steer` 这类写操作，在结果未知时会被再执行一次。

这违反了 PLAN 不变量 4（“已写出但未收到回执即为 unknown，只按 intent id 核对”），也违反了 EXECUTION-BATCH4 B4-L2 的要求（“写操作在结果未知时按 intent id 核对，不重放”）。

修法：

1. 传输层要保留 lane 已经区分出的 `notSent` 和 `lost`，不要把它们合并成 `daemon_not_running`。
2. **读操作**可以重连后重读一次。**写操作**只有 `notSent`（请求字节确认没有写出）时才能在新连接上重发；`lost` 一律报 unknown。
3. `start` 的 intentId 在第一次尝试**之前**生成并固定，结果未知时用 `intentStatus(intentId)` 核对，不重新提交。
4. 测试：
   - 写出后断开的 `start`，daemon 只看到一个 intent，并且通过 `intentStatus` 核对出结果；
   - 写出后断开的 `stop` 和 `answer`，返回 unknown，没有第二次调用；
   - 连接阶段就失败的写操作，允许重发一次；
   - 用控制实验证明，把限制去掉后上面的测试会失败。

### M2 分类表里一半的“提交者语义”行还没切换，但状态写成了“代码完成”

`b4-l3-scope.md` 把下列行归为“提交者语义 → `appSemantics`”，但代码里仍然按 `isRemoteRun` 判断：

- `run-admission.ts:59,64,70,71,72,108,134,138,214,220`
- `run-completion.ts:172,197,235`
- `run-failure.ts:160,184,221`
- `run-session.ts:48,50`
- `run-startup.ts:183,189,198,210,211`

`appSemantics` 目前只出现在 frontdoor、diff、provider、startup 和 execution 里。也就是说，本机经 daemon 提交的 run 在这些地方仍按远程语义处理，具体包括：

- **会话续接与一致性保护**：`expectedExternalSessionId` 与 `sessionByContext` 的取舍，以及“本会话已有待处理轮次”“restart 来源匹配”这几项检查会被跳过。它们保护的是会话完整性，跳过后可能在同一会话上出现并发 turn，或者续接到已经过期的会话。
- **录制失败**：只设置 `remoteRecordingFailed`。本机 App 的 run 视图能不能看到“录制失败”，没有任何证据。如果看不到，就违反了 CLAUDE.md 第 1 条（证据不能说谎）。
- **注册、聚焦、dock badge 与当前会话视图。**

修法：每一行二选一，结论写进分类表。

- **切换**到 `appSemantics`，并补本机/远程对照测试。
- 如果在 daemon 模式下远程语义才是对的，就**改判**并写明理由。例如：daemon 无法得知 App 的“当前会话”，必须由 App 显式传入 `expectedExternalSessionId`。改判时要说明 App 侧由什么机制替代原来的保护，并用测试证明保护仍然存在。

无论选哪种，**录制失败必须能在本机 run 视图里看到**，并有测试证明（daemon 侧的 run 录制失败 → App 的 run 视图出现对应状态）。dock badge 和未读状态如果要推迟到 L4（§13.5），在 STATUS 中写明“开关打开时暂不可用”。

`b4-l3.md` 改为“进行中”，直到 M2 完成。

### M3 开关打开后没有在真实 App 上验证过

`b4-l3.md` 的「未验证」已经如实写了这一点。但 EXECUTION-BATCH4 对 L3 的验收要求是：“现有 run 相关的 renderer 与 main 测试，在开关打开时全部通过”。CLAUDE.md 也要求，验证 App 行为时要用独立 userData 的 test 实例。

目前只有单元测试、组件测试和帧层面的证据，`spawnDaemonSupervisor` 也没有经过 App 本身调用。

修法：

- 在独立 userData、临时工作区下启动 smoke provider（`SCRY_ELECTRON_SMOKE_PROVIDER` 的现有 fixture），设置 `SCRY_HOST_DAEMON=1`，启动 test 实例，跑通：拉起 daemon → 入网 → 发送 → 流式显示 → 提问与回答 → 停止 → 结束；再 SIGKILL daemon，确认 App 重新拉起后会重新订阅。
- 把现有 run 相关的 main/renderer 测试中适用的部分，在开关打开时跑一遍，失败项逐条记录。

截图、设备或 Provider 不可用的项，标为 not-run。

## 应修

**S1 trace 计时不满足已决定的条件。** 维护者 2026-11-07 决定的预算是：首 token 与流式输出的 P95 相对进程内不超过 +10 ms，**使用同一个 fake provider**。`daemon-trace-latency.mjs` 读的是一个不存在的 run，测到的是“每轮多一次 socket 往返”，wiring 文档对此有如实说明。但 `b4-l3.md` 的验收表把它写成了“P95 3.89 ms（预算 10 ms）”，读起来像是已经满足预算。

修法：

- 把这一项改成“部分：只测了泵每轮的固定开销”；
- 在 M3 的 test 实例上，用同一个 smoke provider 分别测进程内与 daemon 两种模式下的首 token 和流式更新延迟，各至少 30 个样本，串行测量并记录负载；
- 结果出来之前，不得进入 B4-S。

## 需要维护者确认

`b4-l3.md` 与 `8db2631` 把“撤销后的重新连接入口放在设置页，与 B4-S 的 daemon 状态页一起做”记为“维护者 2026-11-07 答复”。核验方在此前的答复记录中没有找到这一条。请维护者确认：如果确实同意，保持现状；如果不同意，这一项回到 L3。

## 下一步

先修 M1，再修 M2，最后做 M3 和 S1，每项先写失败测试。全部完成后停下等核验。
