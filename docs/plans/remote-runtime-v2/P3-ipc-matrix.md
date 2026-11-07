# P3 附录 · IPC channel 路由矩阵（生成文件）

本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing.json` 后重新生成。

- 生产 `handleTrusted` channel：119 个（`src/main/**`，不含测试）
- 留在 main：24，一半 main 一半 daemon（`split`）：3，转发到现有 op：39，需要新增 op：53
- 新增 op 的请求、响应、授权与调用方范围见 [P3-ipc-ops](P3-ipc-ops.md)；设计正文见 [P3 §13](P3-batch4-design.md)

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
| `agent:addPiProfile` | new-op | `piProfile:addPiProfile` | providers | — | Provider 配置随 adapter 一起迁移 |
| `agent:adoptActiveRun` | new-op | `runControl:adoptActiveRun` | controls | — | run 登记表在 daemon |
| `agent:answerQuestion` | forward | `answerQuestion` | — | 等价 | 待答问题在 daemon |
| `agent:billingState` | new-op | `billing:billingState` | analytics | — | 账本与 transcript 在 daemon 侧 |
| `agent:catalogHealth` | new-op | `sessionStore:catalogHealth` | navigation | — | 会话账本在 daemon |
| `agent:chooseFolder` | split | `workspaceSelection:chooseFolder` | navigation | main: 原生目录选择框留在 main；选中后由 daemon 校验 canonical 目录、rememberProject 与 setCurrentCwd | 选择框与持久化分开 |
| `agent:clipboardImage` | main | `—` | — | — | 剪贴板 |
| `agent:deleteArchivedSessions` | new-op | `sessionPurge:deleteArchivedSessions` | navigation | — | 批量删除要重放既有 preview/指纹语义 |
| `agent:deleteSession` | forward | `sessionDelete` | — | 不同：本机走原生确认框且可删未归档；远程只允许已归档、confirm:false。按 grant scope 选策略；确认框留在 main，daemon 只对 scope: local 接受已确认请求 | 既有 sessionDelete |
| `agent:detect` | forward | `providers` | — | 不同：远程只给 providerDiscovery 元数据，本机还要 installed 路径与版本。按 grant scope 选 detail | adapter 在 daemon |
| `agent:detectFast` | forward | `providers` | — | 不同：快探测只在 scope: local 使用，远程仍走完整探测 | adapter 在 daemon |
| `agent:focusedRunSnapshot` | forward | `runState` | — | 等价（同一 run 登记表；只是按焦点取一条） | 权威快照在 daemon |
| `agent:focusRun` | main | `—` | — | — | 窗口级焦点书签 |
| `agent:forkSession` | forward | `sessionFork` | — | 等价 | 既有 sessionFork |
| `agent:importBillingFixture` | new-op | `billing:importBillingFixture` | analytics | — | 账本与 transcript 在 daemon 侧 |
| `agent:invalidateProviderContext` | new-op | `providerContext:invalidateProviderContext` | providers | — | Provider 运行时在 daemon |
| `agent:listArchivedSessions` | new-op | `sessionStore:listArchivedSessions` | navigation | — | 会话账本在 daemon |
| `agent:listCommands` | forward | `commands` | — | 不同：远程按 provider 白名单裁剪命令集，本机保留全部命令。按 scope 选策略 | 既有 commands |
| `agent:listProjects` | new-op | `projectStore:listProjects` | navigation | — | 项目目录需单一写者 |
| `agent:listSessions` | forward | `sessionsPage` | — | 不同：远程分页上限更小且不返回归档会话。按 grant scope 选上限与归档可见性：scope: local 返回全部 | 既有 sessionsPage |
| `agent:listSkills` | new-op | `skills:listSkills` | providers | — | daemon 才能读 Provider 的 skill 目录 |
| `agent:llmPerformanceHistory` | new-op | `llmPerformance:llmPerformanceHistory` | analytics | — | usage JSONL 与 run 状态由 daemon 写 |
| `agent:llmPerformanceSummary` | new-op | `llmPerformance:llmPerformanceSummary` | analytics | — | usage JSONL 与 run 状态由 daemon 写 |
| `agent:loadSession` | forward | `historyTurnsPage` | — | 不同：远程历史投影裁掉工具原文与文件足迹，本机保留完整证据。按 grant scope 选投影：scope: local 给本机完整结果 | 既有 historyTurnsPage |
| `agent:loadSessionOlder` | forward | `historyPage` | — | 不同：同 loadSession 的投影差异（分页更早的部分同样被裁剪）。按 grant scope 选投影 | 既有 historyPage |
| `agent:mcpGuardScan` | new-op | `mcp:mcpGuardScan` | providers | — | MCP 与 trust gate 都在 daemon |
| `agent:mcpSnapshot` | new-op | `mcp:mcpSnapshot` | providers | — | MCP 与 trust gate 都在 daemon |
| `agent:newSession` | new-op | `providerContext:newSession` | providers | — | Provider 运行时在 daemon |
| `agent:providerDescriptors` | forward | `providers` | — | 不同：本机要完整 descriptors（含 controls 与默认模型），远程只取 metadata。按 grant scope 选 detail | 既有 providers |
| `agent:reauthenticateMcp` | new-op | `mcp:reauthenticateMcp` | providers | — | MCP 与 trust gate 都在 daemon |
| `agent:recentFolders` | split | `projectStore:recentFolders` | navigation | main: 窗口只渲染；列表来自 daemon 的授权输入，main 不打开该 store | 授权输入单一写者 |
| `agent:recorderContentPage` | new-op | `recorderContent:recorderContentPage` | evidence | — | recorder 记录写在工作区里，由 daemon 读 |
| `agent:removePiProfile` | new-op | `piProfile:removePiProfile` | providers | — | Provider 配置随 adapter 一起迁移 |
| `agent:removeProject` | new-op | `projectStore:removeProject` | navigation | — | 设备也读项目目录，必须单一写者 |
| `agent:removeRecentFolder` | split | `projectStore:removeRecentFolder` | navigation | main: 窗口只发请求；删除由 daemon 执行并回新 revision | 授权输入单一写者 |
| `agent:renameProject` | new-op | `projectStore:renameProject` | navigation | — | 设备也读项目目录，必须单一写者 |
| `agent:renameSession` | forward | `sessionAction` | — | 等价 | 既有 sessionAction |
| `agent:revealProject` | main | `—` | — | — | 原生 showItemInFolder |
| `agent:runControls` | forward | `providers` | — | 不同：远程受 SCRY_REMOTE_PERMISSION_MODE 约束，本机用用户选择的权限模式（含 full_access）。按 grant scope 选策略 | providers 的 selected |
| `agent:setCwd` | new-op | `workspaceSelection:setCwd` | navigation | — | 当前工作区是 daemon 授权上下文的一部分 |
| `agent:setProjectPinned` | new-op | `projectStore:setProjectPinned` | navigation | — | 设备也读项目目录，必须单一写者 |
| `agent:setSessionArchived` | forward | `sessionAction` | — | 等价 | 既有 sessionAction |
| `agent:setSessionPinned` | forward | `sessionAction` | — | 等价 | 既有 sessionAction |
| `agent:start` | forward | `submit` | — | 不同：远程用 SCRY_REMOTE_PERMISSION_MODE、走 resolveRemoteProjectDirectory、detail 字段更少；本机用用户权限模式（含 full_access）并允许空 cwd 会话。按 grant scope 选策略，两者都不缩水 | 既有 submit（带 intentId） |
| `agent:stats` | new-op | `usage:stats` | analytics | — | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:steer` | new-op | `runControl:steer` | controls | — | run 登记表在 daemon |
| `agent:stop` | forward | `stop` | — | 等价 | 既有 stop |
| `agent:stopBackgroundTask` | new-op | `runControl:stopBackgroundTask` | controls | — | run 登记表在 daemon |
| `agent:syncBillingAdmin` | new-op | `billing:syncBillingAdmin` | analytics | — | 账本与 transcript 在 daemon 侧 |
| `agent:testMcp` | new-op | `mcp:testMcp` | providers | — | MCP 与 trust gate 都在 daemon |
| `agent:traceAck` | main | `—` | — | — | renderer 消费回执 |
| `agent:traceResynchronized` | main | `—` | — | — | main 的投递桥状态 |
| `agent:turnTerminalEvidence` | new-op | `turnEvidence:turnTerminalEvidence` | evidence | — | 归档终态由 daemon 写 |
| `agent:unreadSessions` | main | `—` | — | — | badge 由 main 渲染 |
| `agent:usageAnalytics` | new-op | `usage:usageAnalytics` | analytics | — | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:usageCredits` | new-op | `usage:usageCredits` | analytics | — | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:usageStats` | new-op | `usage:usageStats` | analytics | — | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `app:copyText` | main | `—` | — | — | 剪贴板 |
| `app:performanceDiagnosticsEnabled` | main | `—` | — | — | 本机性能开关 |
| `app:rendererRestart` | main | `—` | — | — | 窗口行为 |
| `app:reportRendererPerformance` | main | `—` | — | — | renderer 自报指标 |
| `app:setTheme` | main | `—` | — | — | 窗口主题 |
| `conversation:adopt` | new-op | `conversation:adopt` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:create` | new-op | `conversation:create` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:createSideChat` | new-op | `conversation:createSideChat` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:delete` | new-op | `conversation:delete` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:findSideChatCommand` | new-op | `conversation:findSideChatCommand` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:fork` | new-op | `conversation:fork` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:list` | new-op | `conversation:list` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:listSideChats` | new-op | `conversation:listSideChats` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:preview` | new-op | `conversation:preview` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewAdoption` | new-op | `conversation:previewAdoption` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewDeletion` | new-op | `conversation:previewDeletion` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewSideChat` | new-op | `conversation:previewSideChat` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:read` | new-op | `conversation:read` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:readItem` | new-op | `conversation:readItem` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:readSideChatSnapshot` | new-op | `conversation:readSideChatSnapshot` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:send` | new-op | `conversation:send` | send | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:update` | new-op | `conversation:update` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `remote:desktop:disable` | main | `—` | — | — | DesktopRemoteClient |
| `remote:desktop:invite` | main | `—` | — | — | DesktopRemoteClient |
| `remote:desktop:status` | main | `—` | — | — | DesktopRemoteClient |
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
| `terminal:ack` | forward | `desktopWorkbench:terminalAck` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | PTY 在 daemon |
| `terminal:active` | forward | `desktopWorkbench:terminalActive` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | PTY 在 daemon |
| `terminal:attach` | forward | `desktopWorkbench:terminalAttach` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | PTY 在 daemon |
| `terminal:close` | forward | `desktopWorkbench:terminalClose` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | PTY 在 daemon |
| `terminal:ready` | forward | `desktopWorkbench:terminalReady` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | PTY 在 daemon |
| `terminal:recordingDelete` | forward | `desktopWorkbench:terminalRecordingDelete` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | 录制在 daemon |
| `terminal:recordingList` | forward | `desktopWorkbench:terminalRecordingList` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | 录制在 daemon |
| `terminal:recordingRead` | forward | `desktopWorkbench:terminalRecordingRead` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | 录制在 daemon |
| `terminal:resize` | forward | `desktopWorkbench:terminalResize` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | PTY 在 daemon |
| `terminal:start` | forward | `desktopWorkbench:terminalStart` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | PTY 在 daemon |
| `terminal:write` | forward | `desktopWorkbench:terminalWrite` | — | 等价（同一 workbench terminal surface，ownershipEpoch 与 ack 语义不变） | PTY 在 daemon |
| `workspace:create` | forward | `desktopWorkbench:workspaceCreate` | — | 等价（同上；写入带 expectedRevision，受限宿主按 typed 错误降级） | 工作区写入归 daemon |
| `workspace:list` | forward | `desktopWorkbench:workspaceList` | — | 等价（同一 desktopWorkbench workspace surface，每次重验 cwd） | 工作区读取归 daemon |
| `workspace:move` | forward | `desktopWorkbench:workspaceMove` | — | 等价（同上；写入带 expectedRevision，受限宿主按 typed 错误降级） | 工作区写入归 daemon |
| `workspace:openExternal` | forward | `desktopWorkbench:workspaceOpenExternal` | — | 等价（同一 desktopWorkbench workspace surface，每次重验 cwd） | 工作区内交给系统打开 |
| `workspace:openKnownExternal` | main | `—` | — | daemon:projectStore+sessionStore | main 的只读引用表 |
| `workspace:read` | forward | `desktopWorkbench:workspaceRead` | — | 等价（同一 desktopWorkbench workspace surface，每次重验 cwd） | 工作区读取归 daemon |
| `workspace:readKnown` | main | `—` | — | daemon:projectStore+sessionStore | main 的只读引用表 |
| `workspace:readPage` | forward | `desktopWorkbench:workspaceReadPage` | — | 等价（同一 desktopWorkbench workspace surface，每次重验 cwd） | 工作区读取归 daemon |
| `workspace:readPageKnown` | main | `—` | — | daemon:projectStore+sessionStore | main 的只读引用表 |
| `workspace:rename` | forward | `desktopWorkbench:workspaceRename` | — | 等价（同上；写入带 expectedRevision，受限宿主按 typed 错误降级） | 工作区写入归 daemon |
| `workspace:resolveFile` | main | `—` | — | daemon:projectStore+sessionStore | main 签发只读引用 |
| `workspace:trash` | forward | `desktopWorkbench:workspaceTrash` | — | 等价（同上；写入带 expectedRevision，受限宿主按 typed 错误降级） | 工作区写入归 daemon |
| `workspace:write` | forward | `desktopWorkbench:workspaceWrite` | — | 等价（同上；写入带 expectedRevision，受限宿主按 typed 错误降级） | 工作区写入归 daemon |
