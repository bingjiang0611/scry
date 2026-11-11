# P3 · daemon 模式下的终端

维护者 2026-11-11 决定：

- 输出改为「事件流只发通知，App 再按需读取」；
- shell 不活过 App，断开后在宽限期内回收；
- 三处语义差异由 App 一侧适配。

本文说明具体怎么做。另外有一处偏离原计划：路由不转发到设备的 `desktopWorkbench`，原因见下文。

## 为什么不转发到设备的终端

设备那套按「设备证书 + 工作区」各开一个终端管理器（`desktop-workbench.ts` 的 `terminalScope`）。直接拿来给 App 用，有两个问题：

1. **`terminal:active` 不带 cwd。** 进程内列出的是全部活动终端，供窗口重载后重新接上。按工作区分开的管理器回答不了这个问题。
2. **录制目录跟着证书走。** 录制存在 `<目录>/<证书指纹>/<cwd 哈希>` 下。App 重新入网（secret 轮换、daemon 重启）就换了证书，以前的录制随之找不到；用户在进程内已有的 `userData/terminal-recordings` 也看不到。

因此 daemon 为 App 另开一套终端服务，跑 main 的同一份终端处理逻辑（抽成共用工厂），录制仍在 `userData/terminal-recordings`。两种模式看到的是同一批录制，userData 锁保证同一时刻只有一个写入者。这样三处语义差异不用适配，自然就没有了。

## 结构

| 部分 | 位置 | 做什么 |
|---|---|---|
| 共用处理 | `src/main/bootstrap/terminal-channels.ts` | main 原来 11 个 `terminal:*` handler 的逻辑。调用方检查（IPC 事件可信、窗口能接收）由调用方注入 |
| daemon 服务 | `src/daemon/terminal-service.ts` | 一个 `TerminalManager` 加一个 `TerminalOutputBridge`。bridge 的发送写入有界队列，并在事件流上追加一条 `terminal` 通知（可合并） |
| 本机 op | `terminal`（11 个通道）、`terminalFeed`（`read` / `detachRenderer` / `shutdown`） | 只在本机端点提供；网络端点回答 `unsupported_op` |
| App 读取 | `src/main/daemon-terminal-reader.ts` | 收到 `terminal` 通知或重同步后，按游标读完队列，原样发给窗口：`terminal:data` / `terminal:exit` / `terminal:recordingError` |

## 窗口当前目录

进程内的 `TerminalManager` 在 start、录制列表、读取和删除时读 `getCurrentCwd()`，也就是窗口的选择。daemon 没有窗口选择，所以：

- App 的 guard 给每个 `terminal:*` 调用在末尾附上窗口当前 cwd（没有选择时为 `null`）；
- daemon 用 `resolveKnownProjectDirectory` 重新解析，未知目录拒绝（fail closed）；
- 解析后的 cwd 用 `AsyncLocalStorage` 只作用于这一次调用，同一调用内的再次读取（例如录制列表前后的一致性检查）拿到的是同一个值。

## 流控与背压

- 不变：仍是 bridge 的 ready/ack。渲染端 ack 多少字节，App 就原样转给 daemon（进程内语义是增量，这里也是增量）。
- 队列里只有已经发出、还没被 App 读走的数据。bridge 的在途字节受 high-water 约束，超过就暂停 PTY 读取，所以队列有上界。
- 窗口关闭、导航或渲染进程崩溃时，App 除了处理自己那份，还调用 `terminalFeed.detachRenderer`，与进程内 `terminalOutput.detachRenderer()` 对应。

## shell 的生命周期

- **App 正常退出：** 在 quit 清理阶段调用 `terminalFeed.shutdown`，带超时，尽力而为。与进程内 `getTerminalManagerInstance()?.shutdown()` 对应。
- **App 崩溃：** App 活着的时候，事件流长轮询从不中断（最长 25 秒一次）。daemon 记录事件流最近一次被读的时间，用单调时钟，机器睡眠不计入。超过 90 秒没人读、并且还有活动终端时，关闭全部终端，并重建管理器和 bridge。这就是「断开后宽限期内回收」。
- 录制在关闭时照常收尾，留在 `terminal-recordings` 里，和进程内一样。

## 不在范围内

- 配对设备的终端：仍走 `desktopWorkbench`，不变。
- 终端 shell 的环境变量：daemon 启动时加载的 shell 环境与 App 相同（`warmShellEnv`）。如果 App 启动后用户改了登录 shell 配置，两边可能不同，这一点与进程内一致（都只加载一次）。
