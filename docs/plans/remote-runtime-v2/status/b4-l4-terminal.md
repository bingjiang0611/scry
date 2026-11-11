# B4-L4 · 终端（daemon 模式）

设计见 [P3-terminal](../P3-terminal.md)。11 个 `terminal:*` 通道全部由 daemon 回答。

## 改动

| 层 | 改动 |
|---|---|
| 共用 | main 的 11 个处理抽到 `terminal-channels.ts`，进程内行为不变（单独提交）。`createTerminalRuntime` 的输出改为写入一个 sink：main 写窗口，daemon 写队列 |
| daemon | `terminal-service.ts`：一个管理器和一个输出 bridge，录制在 `userData/terminal-recordings`，与进程内是同一个目录。窗口 cwd 由 App 在每次调用时附上，daemon 用 `resolveKnownProjectDirectory` 重新解析，并用 `AsyncLocalStorage` 限定在这一次调用内。输出写入有界队列，同时在事件流追加一条可合并的 `terminal` 通知 |
| 回收 | 事件流记录最近一次被读的时间（单调时钟，睡眠不计）。超过 60 秒没人读、且有活动终端时，全部关闭并重建；每 5 秒检查一次，端到端最坏约 90 秒（原为空闲 90 秒、每 15 秒检查，实测 117.8 秒，见下文）。App 退出时主动 `terminalFeed.shutdown`（最多等 3 秒） |
| 本机 op | `terminal`（11 个 method）；`terminalFeed`（`read` / `detachRenderer` / `shutdown`）。只在本机端点提供 |
| lane | 新增 `terminal` lane：输入、调整大小、确认和输出读取都走它，不会排在历史读取后面；录制的列表和读取走 bulk。终端写操作不重放 |
| App | `DaemonTerminalReader`：收到通知或重同步后，按游标读完队列，原样发给窗口的 `terminal:data` / `exit` / `recordingError`；同一时间只有一个读取。`terminal-daemon.ts` 的守卫：只发渲染端原有的参数，末尾附上窗口 cwd；进程内会因窗口不可接收而拒绝的地方，这里同样在发送前拒绝；start/attach 返回时窗口已经没了，就通知 daemon 的 bridge 并拒绝。窗口关闭、导航或崩溃时调用 `terminalFeed.detachRenderer`；退出时调用 `shutdown` |
| 文档 | 矩阵生成器把 App 终端行归入工作台那份文档，避免主矩阵超过 20 KB |

## 测试（均先失败）

- 真实 daemon（假 PTY，回显输入）：
  - 在窗口工作区启动；
  - 未知目录被拒绝（目录真实存在，确保拒绝的原因是校验）；
  - 过期的 ownership 返回 false；
  - 事件流收到 `terminal` 通知，按游标读到输出，读过的不会再给；
  - `active` 列出终端；
  - App 主动 shutdown 时 shell 结束；App 不再读事件流时，过了宽限期被回收。
- 对照实验，全部失败后恢复：
  - 不校验目录；
  - 不回收；
  - 不发通知；
  - 守卫不附 cwd；
  - 守卫不做窗口检查；
  - 读取器不合并通知；
  - 读取器不检查窗口。
- 其他：事件流的 `terminal` 通知合并，空闲时间计算正确（读取中也算在读）；`terminalFeed` 在网络端点回答 `unsupported_op`、拒绝非法字段；lane 分配与可否重放。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过；
- `src/daemon src/main scripts`：3891 通过，3 失败，都是已知的环境问题（chmod as root、进程回收）。

## 未验证

- macOS 与真实 App，包括真实 PTY（node-pty 在 `ELECTRON_RUN_AS_NODE` 下）、录制 worker 从 `out/main` 加载、打字延迟、窗口重载后重新接上、App 崩溃后 90 秒内回收。
- 毫秒级延迟没有测：每次按键多一次本机 socket 往返。

## be81d57 本机验证（macOS 26.3.2 arm64，临时 userData/HOME）

| 项 | 结论 |
|---|---|
| A1 基本命令与连打 | 通过。按键到回显 p50 20.0 ms（关闭模式 18.4 ms），daemon 每键多约 1–2 ms |
| A2 大量输出 | 通过。约 20 万行完整落盘，渲染进程最长任务 85 ms |
| A3 重载后重新接上 | 功能通过，但重新接上用了 15.2–15.5 s。原因未定位：15 秒的超时有好几处候选（shell 环境加载、Git 命令、run 长轮询），也缺少进程内对照。下次验证补测 |
| A4 录制 | 通过 |
| A5 退出时回收 | 通过，101 ms |
| A6 崩溃后回收 | 不达标：两次实测都是 117.8 s。已改为空闲 60 s、每 5 s 检查，端到端最坏约 90 s，有测试锁住上界 |
| A7 切项目后新开终端 | 通过 |

同一轮验证带出的其他修复：

- 文件面板和 IPC 错误文案：`daemon_unavailable:*`、`daemon_not_running` 改为中文说明，并保留原因码；
- 选择器切换工作区失败时，在输入框上方显示原因，原来只打到 Console；
- 每次 daemon 模式启动日志里都有一条 `agent:unreadSessions` 错误：改为最多等 5 秒 daemon 的第一份未读快照，等不到才报不可用。
