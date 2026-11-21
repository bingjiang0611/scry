# W10 · 默认 daemon 下恢复 iPhone 的「其他主机」路由，并修正误导文案

执行方 A（有 iPhone 与真机环境；W1 已待核验，W2b 只剩需要停机窗口的两项）。缺陷见 [reports/W1-review.md](../reports/W1-review.md)。

## 背景

在进程内模式下，`src/main/index.ts:375` 把 `desktopRemoteClient` 交给 host runtime，`RemoteHostService.create`（`src/main/remote/remote-host-service.ts:94`）据此构造 `ExecutionTargetRouter`，iPhone 可以经这台 Mac 转到用户其他已保存的主机。

daemon 没有注入它，所以 `executionTargets` 和 `target` 都返回 `execution_targets_unavailable`（`inner-mtls-dispatch.ts:99`、`:104`）。

已保存主机的凭据在 App 的 `safeStorage` 里（`src/main/bootstrap/remote-connections.ts`）。

## 核验方的决定（按推荐，与进程内模式对等）

进程内模式本来就要求 App 在运行，所以先做到「App 开着时与进程内一致，App 关着时说清楚」。daemon 自己持有已保存主机凭据、做到无界面也能转发，属于 P5 第 2 步之后的事，不在本任务里。

## 第一部分：修复

| # | 项 | 要求 |
|---|---|---|
| 1 | daemon 总是构造路由 | `RemoteHostService` 在 daemon 下也构造 `ExecutionTargetRouter`，客户端换成「经 App 转发」的实现；进程内模式不变 |
| 2 | 经 App 转发 | 现在没有 daemon 向 App 发请求的通道。参照 `appEvents` 的拉取方式新增一对本地操作：App 取待办调用，执行 `executionTargets`、`mobileRequest`、`mobileSubmit`、`mobileIntentStatus`，再回传结果。只接受 App 主实例的已登记身份，scry CLI 等其他本地客户端不能领取或回传。每个调用有超时，超时要大于 `watch`/`liveRuns` 的 `waitMs` 上限，并有单帧上限（沿用 `MAX_FRAME`）。App 断开时，进行中的调用立即以明确错误结束 |
| 3 | App 未连接 | `discovery` 返回只含网关、`targets: []` 的正常结果，不报错；`target` 请求返回新错误码（如 `execution_target_gateway_offline`），iOS 显示「在这台 Mac 上打开 Scry 后才能使用其他主机」一类准确文案 |
| 4 | iOS 文案 | `execution_targets_unavailable`（来自已发布的旧主机）不再映射成「主机暂不支持读取会话，请更新 Scry」，改成不误导的说法，并且不让侧栏常驻黄色告警。改动后 `swift test` 必须全过 |
| 5 | 授权 | 路由已有的 `authorizePeer` 前后复核保持不变；转发前后都要复核，App 回传的结果不能扩大手机的权限 |
| 6 | 测试 | 先写失败测试：daemon 模式下 `executionTargets` 不再返回 unavailable；App 未连接时只返回网关；非 App 身份不能领取调用；超时与断开；进程内行为不变 |

约束：
- `src/daemon/host-process.ts`、`host-process-assembly.ts` 改动尽量小，放进独立函数，推送前先合并他人提交（C 正在改 P4-2 的挂点）。
- 不碰 Antigravity 与 orchestration 文件。
- 不改协议版本号；新增错误码时要兼容旧 iOS，旧版看到的只能是普通错误，不能导致崩溃或错误降级。

## 第二部分：真机复验

用已安装的 App（用 `npm run install:mac:dev` 覆盖安装）和 iPhone，经测试工作区 `~/scry-w1-ios-test` 验证：
- App 开着：侧栏不再出现告警，「其他主机」列表能显示。如果本机没有保存其他主机，就以空列表、无告警为准，并在报告里写明。
- 退出 App 只留后台服务：侧栏没有误导告警，进入其他主机时显示准确文案。
- 重新打开 App 后自动恢复。

## 第三部分：公网中继僵死 leg（只分析，不部署）

读 `experiments/remote-g0/cf-relay/src/worker.js` 的 leg 活性与选择逻辑，结合 W1 的探测证据（第一次发出 ClientHello 后 6 s 无响应，之后两次成功），判断设备有没有可能被粘到半死的 leg 上。

- 能本地复现的，用本地测试复现，并给出修复补丁和测试。
- **不部署到线上中继**，部署由维护者决定。

## 报告

写 `reports/W10.md`，第一行写状态。全部能做的做完，或只剩需要维护者决定的事项时停下。注销与 FileVault 两项（W2b #2、#4）仍等维护者约时间。
