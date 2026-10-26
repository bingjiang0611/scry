# 批次 C 执行报告

基线：`17f22edd`；分支：`reliability/collection`。只做 C，没有开始 D/E。环境：macOS arm64、Node 24.18.0、Vitest 3.2.7。

## 结论与提交

| 条目 | 结果 | 失败测试提交 | 修复提交 |
|---|---|---|---|
| C1 / M5 | **部分**：已消除 shell 失败回退中的第二次 daemon 请求，并先持久化到 inbox；未建立所有模式的硬实时上限或 exactly-once 保证 | `78d599fc` | `b8ad9b1e` |
| C2 / L1 | **已修复**：长 workspace 的实际 socket 路径可由 shell 读取；显式相对路径按 workspace 解析 | `3c5f9acc` | `de4baedb` |
| C3 / M6 | **已修复（fixture 范围）**：项目目录变量缺失时向上找 bridge，到最近 Git 边界停止；真实 Provider 环境待用户验证 | `ac1104bc` | `4d60564c` |

每条均先提交红测，再提交修复；提交前运行全量 unit，红测提交的失败是预期证据。用户已授权本批必要提交临时使用 `git -c core.hooksPath=/dev/null`，没有修改整文件大小门限或持久 Git 配置。

## C1：失败回退与预算

### 证实

`src/cli/hook-fallback.test.ts` 使用真实 Unix socket HTTP server：接受请求、消费 body，但不响应。运行生成的 shell；用临时 CLI 捕获其交接的 stdin/env，再在测试进程进入真实 `runScryCli`，以便 spy 统计 handler 调用。仅 daemon 启动被 stub，避免测试拉起其他进程。

旧实现的有效红测输出（`/tmp/scry-C1-red.log`）：

```text
{"event":"Stop","elapsedMs":8547,"postRequests":2,"handleInvocations":1}
{"event":"SessionEnd","elapsedMs":2469,"postRequests":2,"handleInvocations":1}
expected 2 to be 1
expected "sendRecorderDaemonHook" to not be called at all
expected "startRecorderDaemon" to not be called at all
expected [] to have a length of 1 but got +0
Tests 2 failed (2)
```

此 fixture 中 daemon 没有执行 core，因此实际 `handleRecorderHook` 是 **1 次，不是 3 次**。证明的是两次 POST 加一次本地 apply 路径；不能把推测的三重执行当成已测事实。首次草稿还有 `safeKey` 导入位置错误，保留在 `/tmp/scry-C1-before.log`；纠正测试导入后才得到以上有效红测并提交，没有弱化断言。

### 改动后的行为

- shell 的 curl 非 200 后设置 `SCRY_RECORDER_DAEMON_TRIED=1`。成功 200 分支仍直接 exit 0。
- CLI 收到该标记后，不再 send，不尝试停止/重启结果未知的 peer；调用 core 的 `queueOnly` 分支。
- 原 payload、provider、event、sessionId、arrivedAt 原子落到 `<dataRoot>/runtime/<provider>/<sessionKey>/inbox/<arrival>-<uuid>.json`；沿用 fsync，不先等 session lock 或执行 finalize/delivery。
- recorder.log 写 `WARN daemon delivery uncertain; queued ... for replay`。此时不是 record，也不增加 orphan/drop 计数。status/doctor 后续刷新会把它计为 pending。
- 后续 recover 或同会话 hook 重放 inbox；沿用 B 的隔离、重试和生命周期去重。新增断言验证 recover 后原 inbox 被消费，缺开始的 Stop 才成为真实 orphan；SessionEnd 不制造 orphan。
- 修复后 fixture 的 POST 为 1、handler 调用为 1，但 handler 只入队、不 apply。若原 daemon 已经处理请求而 ACK 丢失，之后仍可能 at-least-once replay，**不承诺 exactly-once**。

### 真实子进程计时与上限

另用当前构建 CLI、真实 shell、真实 curl、真实不响应 socket 做子进程探针，没有 Vitest mock；每例临时 git workspace，结束关闭 server 并删除 workspace。`/tmp/scry-C-budget-probe.mjs` 与 `/tmp/scry-C-budget.log` 保留本机。

通过现有 `timing-run.mjs` 串行加锁。第一次因别的测量持锁退出 75，未抢锁；确认锁已释放后才运行。10 核，1 分钟负载开始 **12.31**、结束 **11.35**，`highLoad=true`。

| 事件 | 本次 shell 开始到退出 | POST / 持久 inbox | 退出码 |
|---|---:|---|---:|
| Stop | 5233 ms | 1 / 1，payload 相同 | 0 |
| SessionEnd | 1908 ms | 1 / 1，payload 相同 | 0 |
| PreToolUse | 1907 ms | 1 / 1，payload 相同 | 0 |

这些是高负载单样本，不是延迟上界，也不用于宣称 L2/L3 性能提升。红测的合成 shell→CLI 计时未加锁、未采负载且不含真实 Node 启动成本，只作诊断；可稳定比较的 **L1 计数是 POST 2→1**。线上成功快路径仍只启动原有 dirname、cat、curl；定位新增的 shell 操作全是内建。

实际宿主配置来自 `workspace-init.ts`，不是沿用文档中的笼统 10 秒：

| Provider / 事件 | init/plugin 宿主超时 | curl 不响应的等待预算 | 修复后的该回退路径 |
|---|---:|---:|---|
| Claude / Codex / Qoder：UserPromptSubmit、Stop | 15 s | 4 s | 4 s + Node 启动、配置/身份读取、持久入队与日志 |
| Claude / Codex / Qoder：PreToolUse、PostToolUse、PostToolUseFailure | 10 s | 1 s | 1 s + 同上 |
| Claude：SessionEnd | 3 s | 1 s | 1 s + 同上；本次实测有余量，但不保证所有机器 |
| OpenCode：Stop（含 session.idle 转换） | spawnSync 15 s | 4 s | 4 s + 同上 |
| OpenCode：UserPromptSubmit | spawnSync 10 s | 4 s | 4 s + 同上 |
| OpenCode：工具事件 | spawnSync 10 s | 1 s | 1 s + 同上 |

Codex/Qoder 未配置未经验证的 SessionEnd。Pi 不经过本批生成的 shell/plugin，未新增宿主超时结论。

**不能给出的保证：**文件系统、fsync、进程启动没有硬实时上限。没有 curl/没有 socket 时仍进入原 CLI cold-start 路径；显式 direct/managed 仍走原 core 路径，锁等待、聚合、通知可能超过宿主预算。没有用 `Promise.race` 或杀子进程伪装有界，否则可能先丢事件。本批只修复已证实的 curl 失败后二次尝试及同步重做路径；全模式 deadline/admission 机制属于尚待决定的扩大范围。

### 非 Claude Stop 与 180 秒附带确认（仅评估）

没有把 Codex/Qoder/OpenCode Stop 全部改成 pending，也没有改 `DEFERRED_TERMINAL_GRACE_MS=180000`：

1. 当前非 Claude Stop 在不命中既有 stale-terminal 保护时仍同步聚合。改成一律 pending 会让显式 direct 且无后台进程的最后一轮永久等下一次动作；本批不引入新的后台调度策略。
2. OpenCode/Qoder 缺稳定 turn identity 的短轮次可命中 180 秒保护。起算点是 `open.deferredTerminalAt`，不是 prompt 的 startedAt。
3. daemon 在线时，recovery 调度以 1 秒开始退避、最高 15 秒，宽限后下一次 recover 可完成聚合；这不是严格的 180 秒完成保证，还受 I/O、锁和证据收敛影响。
4. **direct 且无 daemon 时，时间流逝不会自行调用 recover。**应在终态后至少 180 秒显式运行 `scry recorder recover --workspace ...`，或由用户显式启动/restart daemon。
5. `status`、`doctor`、`turns list` 不执行 recover，只读/刷新观测状态，不能写成“任意 scry 命令都能收尾”。同 session 的下一次 hook 也不是通用定时恢复器：新 prompt 走 supersede/finalize 分支；其他活动可能清除 deferred terminal。不要依赖无关 hook 替代 recover。
6. curl 回退已入队但 daemon 真正卡死时，也需要用户检查并 restart/recover；不会为了“自动成功”重启结果未知的进程。

## C2：实际 socket 路径

旧实现有效红测（`/tmp/scry-C2-red.log`）：

```text
publishes the actual long-workspace socket ...
  promise resolved "Buffer[...invoked...]" instead of rejecting
explicit relative socket ...
  expected +0 to be 1
Tests 2 failed | 2 passed (4)
```

测试创建超过 100 字节默认 socket 路径的 workspace，daemon 真正监听短哈希路径，旧 shell 却启动了临时 CLI。显式绝对路径与 stale-hint 对照用例在旧版本已通过。

改动：

- daemon listen 成功后，原子写 `<workspace>/.scry/recorder-socket-path`，内容是实际 socket 绝对路径加换行。
- 将已有原子写实现抽成 `writeTextAtomic`，`writeJsonAtomic` 委托它；原来的临时文件、文件 sync、rename、目录 sync 和错误清理全部保留。没有新的依赖。
- pointer 的 `.scry` 父目录若是符号链接则拒绝发布，并关闭本次已监听的 daemon；listen 失败时不去删除别人的 socket。
- 无显式 override 时，shell 用内建 read 读 pointer，只在目标仍为 socket 时采用；stale pointer 回退默认路径。停止后可保留 hint，不把 hint 当活性证据。
- `SCRY_RECORDER_SOCKET` 非空时优先，不用 pointer 覆盖；相对值与 Node 合同一致，按 workspace 拼接，而不是 hook 子目录。
- 显式**超长** socket 值仍由 Node 哈希解析，shell 不做哈希：该少见 override 仍可能启动 CLI，但不改写其目标语义。本批优化的长 workspace 默认路径已真实走 curl，不启动 CLI。

`hook-socket-path.test.ts` 验证实际 HTTP 请求、fallback CLI 不被调用、pointer 内容、绝对/相对 override、stale hint。durability 回归继续通过。

## C3：子目录定位和存量 repair

旧实现有效红测（`/tmp/scry-C3-red.log`）：

```text
claude/codex/qoder locates the nearest bridge ...
  expected 127 to be +0
missing bridge (...)
  expected 127 to be +0
repair replaces old ... commands ...
  expected 'SCRY_HANDLER_ID=turn-recorder-v1 sh -…' not to be ...
Tests 9 failed (9)
```

这是明确移除项目目录变量、从临时仓库子目录执行真实配置 command 的 shell 复现；**不等价于已证明真实 Codex/Qoder 不设置变量**。

- 起点仍尊重对应 Provider 项目目录变量，缺失则使用 PWD。只用 shell 内建向上找最近可执行 `.scry/provider-hook.sh`；找到即 exec，stdin 不被提前读取。
- 在最近 `.git` 文件或目录处停止，不跨嵌套仓库借用父项目 bridge；没有 Git 边界则到 `/` 为止。
- 找不到/不可执行时 exit 0；尽力追加 `${XDG_STATE_HOME:-$HOME/.local/state}/scry/hook-skip.log`，固定 TSV 原因为 `bridge_not_found`，不写 payload/cwd。不可写时仍 fail open；拒绝日志目标及直接父目录的符号链接。
- 此用户级日志目前**不进入 workspace doctor/support-bundle 汇总**，也没有新增轮转机制；需要人工检查，不能宣称 workspace doctor 覆盖所有找不到 workspace 的故障。
- 没有重写 repair 算法：现有 `stripManagedHooks` 按 handler id 清除旧/重复条目，然后写新 command。三种 JSON Provider 的测试均证明只剩一个 managed Stop、foreign hook 原样保留、第二次 repair 无改动。
- 快路径计数测试从“直接执行 bridge”扩大为“子目录执行配置中的完整 command”，仍只观测到 dirname、cat、curl；断言未削弱。

## 生效方式

| 条目 | 需要的操作 |
|---|---|
| C1 | 升级 CLI **并 repair workspace bridge**；旧 bridge 不传新标记，单升级不能消除双重尝试 |
| C2 | 升级 CLI、repair bridge、`recorder restart` 让新 daemon 发布 pointer |
| C3 | `integrations repair --yes` 改写 Provider command，再重启 Provider；Codex 按原生 `/hooks` 提示重新确认 trust |

不要只升级后继续使用旧 daemon。迁移旧 command 用 repair，不把重复 init 当成迁移证明。本批未改 commit-hook trust、record schema 或权限语义，未安装日常 CLI/App。
