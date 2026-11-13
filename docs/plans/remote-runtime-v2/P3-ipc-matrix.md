# P3 附录 · IPC channel 路由矩阵（生成文件）

本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing.json` 后重新生成。

- 生产特权 IPC channel：172 个（`src/main/**` 经 `handleTrusted` 注册，不含测试；含 `handle(` 参数名与 `sourceControl:${method}` 这类按表展开的注册）
- 留在 main：56，一半 main 一半 daemon（`split`）：7，转发到现有 op：25，需要新增 op：84
- 新增 op 的请求、响应、授权与调用方范围见 [P3-ipc-ops](P3-ipc-ops.md)；设计正文见 [P3 §13](P3-batch4-design.md)
- 统一对话（`conversation:*`，共 17 行）见 [P3-ipc-matrix-conversation](P3-ipc-matrix-conversation.md)
- 工作台行（`desktopWorkbench` 转发的 workspace / sourceControl，与 App 终端 op `terminal`，共 30 行）见 [P3-ipc-matrix-workbench](P3-ipc-matrix-workbench.md)

## 判定规则

| 去向 | 含义 |
|---|---|
| `main` | 窗口、菜单、原生对话框、剪贴板、本机只读文件引用，以及连接别的宿主的 `DesktopRemoteClient`。 |
| `forward` | 能力已在 daemon 里且有现成协议 op；迁移只做转发与 envelope 转换。 |
| `new-op` | 能力在 daemon 侧已存在或必须存在，但设备协议里还没有对应 op。 |
| `split` | 一半留 main 一半走 daemon：原生选择框之类只能窗口做，但落盘的是 daemon 的授权输入，必须由 daemon 写。 |

`forward` 沿用该 op 现有鉴权（已验证 peer + 该 op 自己的 payload/cwd 校验），但语义不一定等价，逐行见「差异与分工」。`new-op` 与 `split` 的 op 按 [P3-ipc-ops](P3-ipc-ops.md) 实现，调用方范围由 `scopes` 决定（默认只有 `local`）。都不因「本机」放宽。

## 矩阵

「差异与分工」列：`forward` 行写与设备协议的语义差异（等价也要写），`split` 行写 main 侧做什么，`main` 行写它依赖的 daemon 数据来源。

| channel | 去向 | op(method) | 用户路径 | 差异与分工 | 依据 |
|---|---|---|---|---|---|
| `agent:activeRun` | forward | `runState` | — | 等价（同一 run 登记表） | run 状态在 daemon |
| `agent:activeRuns` | forward | `liveRuns` | — | 等价；远程长轮询 waitMs 由 daemon 决定，本机传 0 | live run 在 daemon |
| `agent:addPiProfile` | split | `piProfile:addPiProfile` | providers | main: 启动器文件选择框与握手失败提示留在 main；daemon 解析启动器、在已知项目目录里做 Pi RPC 握手并写入 profile | Provider 配置随 adapter 一起迁移 |
| `agent:adoptActiveRun` | new-op | `runControl:adoptActiveRun` | controls | — | run 登记表在 daemon |
| `agent:answerQuestion` | forward | `answerQuestion` | — | 等价 | 待答问题在 daemon |
| `agent:billingState` | new-op | `billing:billingState` | analytics | — | 计费账本在 daemon 持有的 scry.db 里 |
| `agent:catalogHealth` | new-op | `sessionStore:catalogHealth` | navigation | — | 会话账本在 daemon |
| `agent:chooseFolder` | split | `workspaceSelection:chooseFolder` | navigation | main: 原生目录选择框与窗口的当前工作区（同 agent:setCwd）留在 main；daemon 只收选择框给出的路径，校验 canonical 目录并 rememberProject，App 在 daemon 回答后再选中该目录 | 选择框与持久化分开 |
| `agent:clipboardImage` | main | `—` | — | — | 剪贴板 |
| `agent:deleteArchivedSessions` | new-op | `sessionPurge:deleteArchivedSessions` | navigation | — | 批量删除要重放既有 preview/指纹语义 |
| `agent:deleteSession` | new-op | `sessionLifecycle:deleteSession` | navigation | — | App 语义：空 cwd 会话、确认后可删未存档会话、确认框在 App；设备的 sessionAction/sessionDelete 规则不同，不复用 |
| `agent:detect` | new-op | `providerCatalog:detect` | providers | — | 本机要安装路径、版本与兼容判定；远程设备的 providers 元数据不变 |
| `agent:detectFast` | new-op | `providerCatalog:detectFast` | providers | — | 快探测只给本机 |
| `agent:focusedRunSnapshot` | forward | `runState` | — | 等价（同一 run 登记表；只是按焦点取一条） | 权威快照在 daemon |
| `agent:focusRun` | main | `—` | — | — | 窗口级焦点书签 |
| `agent:forkSession` | new-op | `sessionLifecycle:forkSession` | navigation | — | App 语义：没有 cwd 时用窗口当前工作区，空 cwd 会话照旧；设备的 sessionFork 要求非空 cwd，不复用 |
| `agent:gitCommitDiffSnapshot` | new-op | `workspaceDiff:gitCommitDiffSnapshot` | source-control | — | 项目授权归 daemon；git 读取跟随授权 |
| `agent:gitDiff` | new-op | `workspaceDiff:gitDiff` | source-control | — | 项目授权归 daemon；git 读取跟随授权 |
| `agent:gitDiffCommits` | new-op | `workspaceDiff:gitDiffCommits` | source-control | — | 项目授权归 daemon；git 读取跟随授权 |
| `agent:gitDiffSnapshot` | new-op | `workspaceDiff:gitDiffSnapshot` | source-control | — | 项目授权归 daemon；git 读取跟随授权 |
| `agent:importBillingFixture` | new-op | `billing:importBillingFixture` | analytics | — | 计费账本在 daemon 持有的 scry.db 里 |
| `agent:invalidateProviderContext` | new-op | `providerContext:invalidateProviderContext` | providers | — | Provider 运行时在 daemon |
| `agent:listArchivedSessions` | new-op | `sessionStore:listArchivedSessions` | navigation | — | 会话账本在 daemon |
| `agent:listCommands` | new-op | `providerCommands:listCommands` | providers | — | 设备 op commands 丢掉 CapabilityEnvelope（unavailable 会变成空列表）；本机要完整 envelope |
| `agent:listProjects` | new-op | `projectStore:listProjects` | navigation | — | 项目目录需单一写者 |
| `agent:listSessions` | new-op | `sessionStore:listSessions` | navigation | — | 本机拿 App 自己的完整会话目录；远程设备的 sessionsPage 投影不变 |
| `agent:listSkills` | new-op | `skills:listSkills` | providers | — | daemon 才能读 Provider 的 skill 目录 |
| `agent:llmPerformanceHistory` | new-op | `llmPerformance:llmPerformanceHistory` | analytics | — | usage JSONL 与 run 状态由 daemon 写 |
| `agent:llmPerformanceSummary` | new-op | `llmPerformance:llmPerformanceSummary` | analytics | — | usage JSONL 与 run 状态由 daemon 写 |
| `agent:loadSession` | split | `sessionHistory:loadSession` | history | main: 应用 daemon 回报的窗口会话选择（setCurrentCwd、会话镜像、角标）后把页交给 renderer | 读页与窗口选择分开 |
| `agent:loadSessionOlder` | new-op | `sessionHistory:loadSessionOlder` | history | — | 翻页读 daemon 自己的历史缓存（由 loadSession 建立） |
| `agent:mcpGuardScan` | new-op | `mcp:mcpGuardScan` | providers | — | MCP 与 trust gate 都在 daemon；Provider 认证队列也在 daemon，App 不能在自己进程里另行认证 |
| `agent:mcpSnapshot` | new-op | `mcp:mcpSnapshot` | providers | — | MCP 与 trust gate 都在 daemon；Provider 认证队列也在 daemon，App 不能在自己进程里另行认证 |
| `agent:newSession` | new-op | `providerContext:newSession` | providers | — | Provider 运行时在 daemon |
| `agent:providerDescriptors` | new-op | `providerCatalog:providerDescriptors` | providers | — | 本机要完整 descriptors（含 controls 与默认模型） |
| `agent:reauthenticateMcp` | new-op | `mcp:reauthenticateMcp` | providers | — | MCP 与 trust gate 都在 daemon；Provider 认证队列也在 daemon，App 不能在自己进程里另行认证 |
| `agent:recentFolders` | split | `projectStore:recentFolders` | navigation | main: 窗口只渲染；列表来自 daemon 的授权输入，main 不打开该 store | 授权输入单一写者 |
| `agent:recorderContentPage` | new-op | `recorderContent:recorderContentPage` | evidence | — | recorder 记录写在工作区里，由 daemon 读 |
| `agent:removePiProfile` | new-op | `piProfile:removePiProfile` | providers | — | Provider 配置随 adapter 一起迁移 |
| `agent:removeProject` | new-op | `projectStore:removeProject` | navigation | — | 设备也读项目目录，必须单一写者 |
| `agent:removeRecentFolder` | split | `projectStore:removeRecentFolder` | navigation | main: 窗口只发请求；删除由 daemon 执行并回新的最近目录列表 | 授权输入单一写者 |
| `agent:renameProject` | new-op | `projectStore:renameProject` | navigation | — | 设备也读项目目录，必须单一写者 |
| `agent:renameSession` | new-op | `sessionLifecycle:renameSession` | navigation | — | App 语义：空 cwd 会话、确认后可删未存档会话、确认框在 App；设备的 sessionAction/sessionDelete 规则不同，不复用 |
| `agent:revealProject` | main | `—` | — | — | 原生 showItemInFolder |
| `agent:runControls` | new-op | `providerCatalog:runControls` | providers | — | 本机按用户权限模式取 run controls；远程设备受 SCRY_REMOTE_PERMISSION_MODE 约束的路径不变 |
| `agent:setCwd` | split | `workspaceSelection:setCwd` | navigation | main: 窗口选择留在 main，按发出顺序生效；daemon 按自己的已知项目校验目录、回 canonical 路径，不落盘 | 窗口选择与已知项目授权分开 |
| `agent:setProjectPinned` | new-op | `projectStore:setProjectPinned` | navigation | — | 设备也读项目目录，必须单一写者 |
| `agent:setSessionArchived` | new-op | `sessionLifecycle:setSessionArchived` | navigation | — | App 语义：空 cwd 会话、确认后可删未存档会话、确认框在 App；设备的 sessionAction/sessionDelete 规则不同，不复用 |
| `agent:setSessionPinned` | new-op | `sessionLifecycle:setSessionPinned` | navigation | — | App 语义：空 cwd 会话、确认后可删未存档会话、确认框在 App；设备的 sessionAction/sessionDelete 规则不同，不复用 |
| `agent:start` | forward | `submit` | — | 不同：远程用 SCRY_REMOTE_PERMISSION_MODE、走 resolveRemoteProjectDirectory、detail 字段更少；本机用用户权限模式（含 full_access）并允许空 cwd 会话。按 grant scope 选策略，两者都不缩水 | 既有 submit（带 intentId） |
| `agent:stats` | new-op | `usage:stats` | analytics | — | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:steer` | new-op | `runControl:steer` | controls | — | run 登记表在 daemon |
| `agent:stop` | forward | `stop` | — | 等价 | 既有 stop |
| `agent:stopBackgroundTask` | new-op | `runControl:stopBackgroundTask` | controls | — | run 登记表在 daemon |
| `agent:syncBillingAdmin` | new-op | `billing:syncBillingAdmin` | analytics | — | 计费账本在 daemon 持有的 scry.db 里 |
| `agent:testMcp` | new-op | `mcp:testMcp` | providers | — | MCP 与 trust gate 都在 daemon；Provider 认证队列也在 daemon，App 不能在自己进程里另行认证 |
| `agent:traceAck` | main | `—` | — | — | renderer 消费回执 |
| `agent:traceResynchronized` | main | `—` | — | — | main 的投递桥状态 |
| `agent:turnTerminalEvidence` | new-op | `turnEvidence:turnTerminalEvidence` | evidence | — | 归档终态由 daemon 写 |
| `agent:unreadSessions` | main | `—` | — | — | badge 由 main 渲染 |
| `agent:usageAnalytics` | new-op | `usage:usageAnalytics` | analytics | — | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:usageCredits` | new-op | `usage:usageCredits` | analytics | — | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:usageStats` | new-op | `usage:usageStats` | analytics | — | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:viewSessions` | main | `—` | — | — | badge 由 main 渲染 |
| `app:copyText` | main | `—` | — | — | 剪贴板 |
| `app:performanceDiagnosticsEnabled` | main | `—` | — | — | 本机性能开关 |
| `app:rendererRestart` | main | `—` | — | — | 窗口行为 |
| `app:reportRendererPerformance` | main | `—` | — | — | renderer 自报指标 |
| `app:setTheme` | main | `—` | — | — | 窗口主题 |
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
| `desktopRemote:stop` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:submit` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:trace` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:traceDelta` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:updateSsh` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `desktopRemote:workbench` | main | `—` | — | — | DesktopRemoteClient：本 App 连接其他宿主的客户端 |
| `remote:backgroundService:quit` | main | `—` | — | — | 原生二次确认框、向 daemon.lock 登记且身份复核一致的进程发 SIGTERM、app.quit；撤销或停止中 App 无法调用 daemon op |
| `remote:backgroundService:reconnect` | main | `—` | — | — | §13.2 链路：本机 grant 已被撤销，App 不能再调用 daemon 的任何 op；确认框、按身份停止、删除被拒的本机凭据、重新入网都在 App |
| `remote:backgroundService:restart` | main | `—` | — | — | 版本不一致时 App 不与 daemon 通话；确认框、按身份停止与启动对应版本的后台服务都在 App |
| `remote:backgroundService:status` | split | `localBackgroundService:status` | remote | main: 连接结果（就绪、版本不一致、未授权、不可用及原因）、userData 位置与 daemon.lock 登记且身份复核一致的 pid 由 App 自己确定；连接就绪时才向 daemon 询问其余字段，问不到的显示为未知 | 设置页「后台服务」状态 |
| `remote:desktop:disable` | new-op | `localDesktopHost:disable` | remote | — | 本机宿主的桌面接入：daemon 模式下宿主在 daemon |
| `remote:desktop:invite` | new-op | `localDesktopHost:invite` | remote | — | 本机宿主的桌面接入：daemon 模式下宿主在 daemon |
| `remote:desktop:status` | new-op | `localDesktopHost:status` | remote | — | 本机宿主的桌面接入：daemon 模式下宿主在 daemon |
| `remote:device:revoke` | new-op | `localPairing:revoke` | remote | — | 配对权威随 daemon 迁移 |
| `remote:pairing:begin` | new-op | `localPairing:begin` | remote | — | 配对权威随 daemon 迁移 |
| `remote:pairing:cancel` | new-op | `localPairing:cancel` | remote | — | 配对权威随 daemon 迁移 |
| `remote:pairing:confirm` | new-op | `localPairing:confirm` | remote | — | 配对权威随 daemon 迁移 |
| `remote:status` | new-op | `localHostStatus:status` | remote | — | 宿主状态由 daemon 持有 |
| `runTraces:ack` | main | `—` | — | — | main 投递桥记账 |
| `runTraces:confirm` | main | `—` | — | — | main 订阅状态 |
| `runTraces:resync` | main | `—` | — | — | main 订阅状态 |
| `runTraces:setLegacyDemand` | main | `—` | — | — | 窗口焦点决定 |
| `runTraces:subscribe` | main | `—` | — | — | main 拉流后分发 |
| `runTraces:unsubscribe` | main | `—` | — | — | main 拉流后分发 |
| `workspace:openExternal` | main | `—` | — | daemon:projectStore（listProjects + recentFolders） | daemon 没有 shell：留在 App，仍按窗口工作区授权；跨项目回退的已知项目列表向 daemon 取 |
| `workspace:openKnownExternal` | main | `—` | — | daemon:workspaceSelection:setCwd（每次问 daemon） | main 的只读引用表 |
| `workspace:readKnown` | main | `—` | — | daemon:workspaceSelection:setCwd（每次问 daemon） | main 的只读引用表 |
| `workspace:readPageKnown` | main | `—` | — | daemon:workspaceSelection:setCwd（每次问 daemon） | main 的只读引用表 |
| `workspace:resolveFile` | main | `—` | — | daemon:workspaceSelection:setCwd（每次问 daemon） | main 签发只读引用 |
| `workspace:trash` | main | `—` | — | — | daemon 没有 shell：留在 App，按窗口工作区授权后交给系统废纸篓 |
| `workspaceSelection:inspectStart` | new-op | `workspaceSelection:inspectStart` | navigation | — | 准备工作区前检查仓库 |
| `workspaceSelection:read` | new-op | `workspaceSelection:read` | navigation | — | worktree 选择读取 git 状态 |
| `workspaceSelection:validateBranch` | new-op | `workspaceSelection:validateBranch` | navigation | — | 校验新分支名 |
