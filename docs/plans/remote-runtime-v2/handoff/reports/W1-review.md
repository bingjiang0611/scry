结论：通过（附条件：合入 main 前须完成 W10）

# W1 核验（核验方，2026-11-20，提交 `664084d2`）

16 项全部实测，证据路径齐全（`~/.local/state/scry-handoff-evidence/W1/`）：

- 安装门禁第二轮 872/872 文件通过。
- 默认 daemon 下真实 Codex 5 项、Qoder（SDK 内置 1.1.11）发送、工具、停止都通过。
- 原生确认框用 AX 动作补验通过，测速 8/8，101 分钟长跑 11/11，RSS 没有持续增长。
- `swift test` 100/100 通过。
- iPhone 13 真机：`172074a2` 的协议修复前后对照成立，三处输入回归、远程发送一轮、覆盖安装和冷重启后重连都通过。

报告 19,506 字节，未提交签名改动。

## 接受为未验证（不阻塞）

- #5：正式签名包在真实钥匙串下的自动化发送。
- #8：远程设备夹具三步。
- #13：非空历史库（本机库为空；换机器有数据时再补）。

## 核验方确认的缺陷：默认 daemon 下 iPhone 看不到「其他主机」，侧栏常驻误导告警

**代码核对属实：**
- `src/main/index.ts:375` 只在进程内模式把 `desktopRemoteClient` 交给 host runtime。
- `src/daemon/` 没有对应注入，所以 `RemoteHostService.create`（`remote-host-service.ts:94`）不会构造 `ExecutionTargetRouter`。
- 结果是 `inner-mtls-dispatch.ts:99`、`:104` 对 `executionTargets` 和 `target` 都返回 `execution_targets_unavailable`。

**影响：**
- iPhone 经这台 Mac 转到用户其他已保存主机的功能，在默认 daemon 下整个不可用。
- iOS 把这个错误归为协议失败，显示「主机暂不支持读取会话，请更新 Scry」，文案误导。

**原因：**
- 设计缺口：P3 迁移清单没有列出执行目标路由。
- 已保存主机的凭据在 App 的 `safeStorage` 里，daemon 无法直接使用。

`main` 已含默认 daemon（PR #119），所以这是线上回归。修复任务单为 W10，并列为下一次合入 `main` 的门槛。

## 另记：公网中继的僵死 leg

配对 35 分钟后出现一次 `I/O on closed channel`：第一次探测发出 ClientHello 后 6 s 无响应，之后两次成功。中继代码在 `experiments/remote-g0/cf-relay/src/worker.js`，其中的租约活性判断可能放进了半死的 leg。W10 第二部分做只读分析和本地复现，不部署。

## 维护者事项

- 临时工作区 `~/scry-w1-ios-test`：建议保留到 W10 真机复验后再移除。
- 本机 `~/.local/bin/git` 依赖 `$HOME`：属于本机环境，是否改由维护者决定；执行方继续用 `/usr/bin/git` 前置的做法即可。
