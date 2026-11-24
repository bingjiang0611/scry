# P3 附录 · IPC 路由矩阵：桌面远程客户端（生成文件）

本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing-client.json` 后重新生成。判定规则与其余 channel 见 [P3-ipc-matrix](P3-ipc-matrix.md)。

| channel | 去向 | op(method) | 用户路径 | 差异与分工 | 依据 |
|---|---|---|---|---|---|
| `desktopRemote:answer` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:catalog` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:commands` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:connect` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:deleteSession` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:directories` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:disconnect` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:file` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:files` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:finishPairing` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:forget` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:forkSession` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:history` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:hostMetrics` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主时读取该主机的资源汇总（P8 §5），只在目标声明 hostMetrics: 1 时请求 |
| `desktopRemote:intents` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:intentStatus` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:list` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:liveRun` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:pair` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:providerControls` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:resolveIntent` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:runStatus` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:selectDirectory` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:sessionAction` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:setViewedSession` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:stop` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:submit` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:trace` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:traceDelta` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:updateSsh` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:validateWorkspaceBranch` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:workbench` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:workspaceChoices` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
