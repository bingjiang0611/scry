# B4-L4 · 已知项目改由 daemon 回答（daemon 模式）

上级状态见 [b4-l4](b4-l4.md)；对应 [STATUS-BATCH4](../STATUS-BATCH4.md)「需要决定（第二轮之后，2026-11-11）」第 3 条。

## 问题

daemon 模式下，main 的 `resolveKnownProjectDirectory` 仍按 App 自己那份 userData 判断「已知项目」：最近目录（`recent-folders.json`）、项目记录（`projects.json`，去掉已移除的）和会话账本里的 cwd（`app-sessions.json`）。这些文件归 daemon 所有，App 读它们就成了第二个读取者。

逐一排查 daemon 模式下仍在 App 进程内运行、且会走到这条判断的路径（`DAEMON_MODE_IN_PROCESS_CHANNELS`、守卫与结果处理函数、非 IPC 路径）：

| 通道 | 以前 | 现在 |
|---|---|---|
| `agent:setCwd` | App 读自己的三份文件 | 每次问 daemon |
| `workspace:resolveFile` | 同上 | 每次问 daemon（`~` 与用户目录只读引用仍在 App，不问） |
| `workspace:readKnown`、`workspace:readPageKnown` | 同上 | 每次问 daemon（`~` 与 `scry-file:` 引用仍在 App，不问） |
| `workspace:openKnownExternal` | 同上 | 同上 |
| `workspace:openExternal` 的跨项目回退 | 已经向 daemon 取 `listProjects` + `recentFolders` | 不变（见下文「待决定」） |

其余用到 `resolveKnownProjectDirectory` / `knownProjectDirectories` 的 main 通道在 daemon 模式下要么转发给 daemon、要么被闸门拒绝，不会运行。main 的远程宿主（`remoteProviderDiscovery` 的 `authorizeWorkspace`、`remoteProjectRoots`）在 daemon 模式下不启动（`remote-defaults.ts`），也不会读。

## 做法

不缓存。复用路由矩阵里早就记下的 `workspaceSelection:setCwd`：

- **daemon**（`src/daemon/local-ops/project.ts`）：`agent:setCwd` 处理函数就是 daemon 自己的 `resolveKnownProjectDirectory`，即 daemon 的 runs 与 source control 用的同一份已知项目（最近目录、未移除的项目、会话 cwd）。目录参数为空时回 `null`，不解析。只读、不落盘，标为可重放（`read: true`）。
- **App**（`src/main/bootstrap/known-project-daemon.ts`）：
  - `daemonKnownProjectDirectory(cwd)`：经 `callDaemonChannel('agent:setCwd', [cwd])` 问 daemon，回答必须是绝对路径字符串，否则 `invalid_daemon_response`；空目录在本地按 main 的报错（`无效的工作目录`）拒绝，不发请求。四个文件通道在 daemon 模式下用它代替 `resolveKnownProjectDirectory`，文件读取、分页、只读引用和交给系统打开仍在 App 做。
  - `daemonSetCwdHandler`：窗口选择仍在 App。main 的处理函数是同步的，选择按窗口发出的顺序生效；改成异步后，每次调用都等前一次结束，慢的 daemon 回答不会覆盖更晚的选择。被拒绝时选择不变，也不挡住下一次。清空选择不问 daemon。
- **路由**：`agent:setCwd` 从 `new-op` 改为 `split`（窗口选择留 main，已知项目授权在 daemon）；四个文件通道仍为 `main`，`source` 改为 `daemon:workspaceSelection:setCwd`。`workspaceSelection` op 的请求、响应、授权说明补上 `setCwd`。文档由 `node scripts/daemon-ipc-matrix.mjs --write` 重新生成。`workspaceSelection` 本来就在 `DAEMON_LOCAL_OP_NAMES` 里，网络端点不提供。
- **闸门**：`agent:setCwd` 仍在 `DAEMON_MODE_IN_PROCESS_CHANNELS`（闸门先看进程内集合，所以不会被整个转发）；新增的 `DAEMON_LOCAL_OP_CHANNELS['agent:setCwd']` 只供 `callDaemonChannel` 使用。`daemon-channel-gate.ts` 只改了注释。

开关关闭时：四个文件通道仍调用 App 的 `resolveKnownProjectDirectory`（多了一个对同步值的 `await`，结果不变）；`agent:setCwd` 仍是原来的同步处理函数，原样返回值。

## 失败即拒绝

- daemon 客户端还没装好：`daemon_capability_unavailable:agent:setCwd`；
- daemon 拒绝：原样转出 daemon 的错误（如 `工作目录尚未通过 Scry 目录选择器授权`），窗口选择不变；
- daemon 回答格式不对：`invalid_daemon_response`；
- 任何情况下都不回退到 App 自己的文件。

## 与进程内的差异

- 每次 `agent:setCwd` 与 `*Known` 文件请求多一次本机 socket 往返。这些文件不在 `scripts/performance-paths.json` 的 `sources` 里，未跑 `performance:measure`，没有毫秒结论；
- `agent:setCwd` 只与自身排队。其他会改窗口选择的路径（`agent:chooseFolder` 的结果处理、`agent:loadSession` 的选择）在 daemon 模式下本来就是异步的，与 `setCwd` 之间不保证按到达顺序；
- 非字符串的 cwd：进程内抛 Node 的 `TypeError`，daemon 模式在 App 本地以 `无效的工作目录` 拒绝。两边都是拒绝。

## 测试（先失败，再做对照）

- `src/daemon/host-process-known-projects.test.ts`（真实 daemon，临时 userData 与工作区）：符号链接解析为 canonical 最近目录；未知目录、相对路径、文件被拒绝；空目录回 `null`；只在 daemon 会话账本里的 cwd 被认出；daemon 启动后选择的目录下一次调用就被认出，移除后下一次调用就被拒绝；校验不改动三份文件；`agent:setCwd` 是本机 op。
- `src/main/bootstrap/workspace-known-daemon.test.ts`（App 端，经生产闸门包装）：daemon 回答 canonical 路径后才选中，App 读取器一次也不调用；拒绝、daemon 不可用、回答格式不对时选择不变；清空不问 daemon；慢回答不覆盖更晚的选择；一次拒绝不挡后续；四个文件通道用 daemon 的 canonical 路径读写引用、打开；未知目录与 daemon 不可用时四个通道都拒绝；用户目录只读引用不问 daemon；开关关闭时 `setCwd` 仍同步返回、四个通道走 App 读取器、不问 daemon。

首次运行：App 端 9 条中 6 条失败（现有代码在 daemon 模式下调用 App 读取器）；另外 3 条（清空选择、用户目录只读引用、开关关闭）是行为保持测试，改动前就通过。daemon 端 4 条全部失败（`unsupported_op`）。

对照实验（每次只破坏一处，均已还原）：

- 文件通道在 daemon 模式下改回 App 读取器 → App 端 2 条失败；`setCwd` 改回进程内处理函数 → 4 条失败；
- daemon 不可用时回退到 App 读取器 → 「daemon 不能回答时拒绝」失败；
- 去掉 `setCwd` 排队 → 顺序那条失败；
- 去掉回答格式检查 → 2 条失败；
- daemon 只认最近目录 → 会话 cwd 那条失败；daemon 不校验直接回原路径 → 2 条失败。

门禁：`npm run typecheck` 通过；`npx vitest run src/daemon src/main scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts` 只有本容器已知的两条失败（`desktop-directory-picker`、`db-outbox`，root 下 chmod 无效）；`node scripts/daemon-ipc-matrix.mjs` 无漂移。

## 待决定

- `workspace:openExternal` 的跨项目回退仍用 daemon 的 `listProjects` + `recentFolders`，比进程内的 `knownProjectDirectories()` 少已移除项目的会话目录与 worktree（STATUS-BATCH4 第 4 条）。本次没有改。若维护者选择「新增本机方法直接返回 `knownProjectDirectories()`」，可在 `workspaceSelection` 下再加一个方法；需要一个真实的 App 通道名承载它（`DAEMON_LOCAL_OP_CHANNELS` 按通道登记，method 必须等于通道最后一段）。
