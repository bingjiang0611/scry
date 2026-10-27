# 卡住运行的本地诊断

包含本次诊断代码的 App 启动后，会在 `userData/pi-run-diagnostics.json` 写入 Pi 运行的阶段快照。macOS 默认路径为 `~/Library/Application Support/Scry/pi-run-diagnostics.json`。旧版正在运行的 App 不会因此获得诊断，既有卡住运行也不能被追溯补齐。

## 如何判断

先匹配 `runId`，再看 `appPid`、`startedAt` 和该条目的 `updatedAt`。这是最后一次观察，不是实时健康检查；进程存在也不证明 RPC 正常。`rpcPid` 可能属于结束后暂存复用的 Rotom 进程，不能据此直接停止进程。

| 最后阶段 | 能证明的范围 |
| --- | --- |
| `main_preparing` / `main_registration` / `main_registered` | 请求进入 main 准备、注册或已注册；不能据此证明已投递给 Pi |
| `profile_lookup` / `environment` / `pool_lookup` | adapter 正在解析 Profile、环境或复用进程 |
| `initial_state` | 等待 Pi 初始 `get_state` 返回 |
| `setup` | 初始状态已返回；尚处于模型、Skill、历史输入或 recorder 准备 |
| `prompt_response` | `prompt` RPC 已发起，尚未观察到其应答；不等于未执行 |
| `user_entry` | prompt 已应答，正在核对原生输入或处理扩展命令 |
| `agent_settlement` | 等待原生结束及后台工作收敛 |
| `final_state` / `rpc_cleanup` | 原生等待已结束，正在补取状态或释放 / 暂存 RPC |
| `provider_returned` / `provider_rejected` | adapter 返回或抛错；返回时须另看 `providerStatus`，不能等同 main 已释放运行 |
| `main_finalization` / `main_settlement` | Provider 已退出，main 仍在处理投递、证据、diff 或统一对话收口 |
| `main_settled` | main 已移除本次运行的登记；`mainDone`、`mainSettled` 是该时刻的观察值，不证明 renderer 已收到通知或队列已发送 |

`lastNativeLifecycle` 与 `lastNativeLifecycleAt` 是收到的原生生命周期事件。`agentSettled` 则是 Scry adapter 的有效收敛标记。例如，原生 `agent_settled` 已到达，但 `nativeIdle=true`、`backgroundPending=true`、`agentSettled=false`，表示仍在等待后台证据，不能直接把轮次改成完成。

未出现的字段表示没有该项观察，不等于 `false`。`providerStatus` 是 Provider 结果，不替代 main 的完成记录或归档事实源。

## 保留与隐私

- 只保存运行编号、阶段、时间、进程号和固定状态字段。不保存提示词、工作区路径、RPC 内容、stderr 或凭据。
- 文件权限为 `0600`；异步合并写入，原子替换，输入投递不等待磁盘写入。
- 最多保留最近更新的 64 个运行，每个运行保留 16 次阶段变更。`coverage=partial` 始终保留：缺少运行或历史不证明它没有执行或已经结束。
- 不增加运行超时、不轮询 Provider、不重试 prompt、不改变停止与排队语义。存储失败只报告诊断不可用，不改变运行结果。
- 如需同时追踪超过 64 个运行或完整逐事件回放，应另行设计保留与隐私策略，使用明确启用的 Provider event log；不要把本快照当成完整审计日志。

## SSH 连接失败

桌面端 SSH 会持续消费 stderr，只在内存保留最后 8192 个字符。隧道就绪失败时，在原退出码后附加经现有认证信息脱敏规则处理、最多 2000 个字符的诊断。例如 `No route to host`、`Permission denied` 或 host-key 错误。等待 `close` 而不是 `exit`，以免遗漏退出后才到达的 stderr。

原始 stderr 不写入文件。脱敏针对常见认证头与命名凭据，不承诺识别远端任意文本中的所有秘密；分享错误前仍应人工检查。SSH config、严格主机密钥校验、非交互认证、无远程命令与 mTLS 边界均保持不变。
