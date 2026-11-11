# B4-L4 · 终端（daemon 模式）

设计见 [P3-terminal](../P3-terminal.md)。11 个 `terminal:*` 通道全部由 daemon 回答。

## 改动

| 层 | 改动 |
|---|---|
| 共用 | main 的 11 个处理抽到 `terminal-channels.ts`，进程内行为不变（单独提交）。`createTerminalRuntime` 的输出改为写入一个 sink：main 写窗口，daemon 写队列 |
| daemon | `terminal-service.ts`：一个管理器和一个输出 bridge，录制在 `userData/terminal-recordings`，与进程内是同一个目录。窗口 cwd 由 App 在每次调用时附上，daemon 用 `resolveKnownProjectDirectory` 重新解析，并用 `AsyncLocalStorage` 限定在这一次调用内。输出写入有界队列，同时在事件流追加一条可合并的 `terminal` 通知 |
| 回收 | 事件流记录最近一次被读的时间（单调时钟，睡眠不计）。超过 90 秒没人读、且有活动终端时，全部关闭并重建。App 退出时主动 `terminalFeed.shutdown`（最多等 3 秒） |
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
