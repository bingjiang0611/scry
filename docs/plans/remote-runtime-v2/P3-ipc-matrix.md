# P3 附录 · IPC channel 路由矩阵（生成文件）

本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing.json` 后重新生成。

- 生产 `handleTrusted` channel：119 个（`src/main/**`，不含测试）
- 留在 main：27，转发到现有 op：39，需要新增 op：53
- 新增 op 的请求、响应与授权见 [P3-ipc-ops](P3-ipc-ops.md)；设计正文见 [P3 §13](P3-daemon-design.md)

## 判定规则

| 去向 | 含义 |
|---|---|
| `main` | 窗口、菜单、原生对话框、剪贴板、本机只读文件引用，以及连接别的宿主的 `DesktopRemoteClient`。 |
| `forward` | 能力已在 daemon 里且有现成协议 op；迁移只做转发与 envelope 转换。 |
| `new-op` | 能力在 daemon 侧已存在或必须存在，但设备协议里还没有对应 op。 |

`forward` 沿用该 op 现有鉴权（已验证 peer + 该 op 自己的 payload/cwd 校验）；`new-op` 按 [P3-ipc-ops](P3-ipc-ops.md) 的授权实现。两者都不因「本机」放宽。

## 矩阵

| channel | 去向 | op(method) | 用户路径 | 依据 |
|---|---|---|---|---|
| `agent:activeRun` | forward | `runState` | — | run 状态在 daemon |
| `agent:activeRuns` | forward | `liveRuns` | — | live run 在 daemon |
| `agent:addPiProfile` | new-op | `piProfile:addPiProfile` | providers | Provider 配置随 adapter 一起迁移 |
| `agent:adoptActiveRun` | new-op | `runControl:adoptActiveRun` | controls | run 登记表在 daemon |
| `agent:answerQuestion` | forward | `answerQuestion` | — | 待答问题在 daemon |
| `agent:billingState` | new-op | `billing:billingState` | analytics | 账本与 transcript 在 daemon 侧 |
| `agent:catalogHealth` | new-op | `sessionStore:catalogHealth` | navigation | 会话账本在 daemon |
| `agent:chooseFolder` | main | `—` | — | 原生目录选择器 |
| `agent:clipboardImage` | main | `—` | — | 剪贴板 |
| `agent:deleteArchivedSessions` | new-op | `sessionPurge:deleteArchivedSessions` | navigation | 批量删除要重放既有 preview/指纹语义 |
| `agent:deleteSession` | forward | `sessionDelete` | — | 既有 sessionDelete |
| `agent:detect` | forward | `providers` | — | adapter 在 daemon |
| `agent:detectFast` | forward | `providers` | — | adapter 在 daemon |
| `agent:focusedRunSnapshot` | forward | `runState` | — | 权威快照在 daemon |
| `agent:focusRun` | main | `—` | — | 窗口级焦点书签 |
| `agent:forkSession` | forward | `sessionFork` | — | 既有 sessionFork |
| `agent:importBillingFixture` | new-op | `billing:importBillingFixture` | analytics | 账本与 transcript 在 daemon 侧 |
| `agent:invalidateProviderContext` | new-op | `providerContext:invalidateProviderContext` | providers | Provider 运行时在 daemon |
| `agent:listArchivedSessions` | new-op | `sessionStore:listArchivedSessions` | navigation | 会话账本在 daemon |
| `agent:listCommands` | forward | `commands` | — | 既有 commands |
| `agent:listProjects` | new-op | `projectStore:listProjects` | navigation | 项目目录需单一写者 |
| `agent:listSessions` | forward | `sessionsPage` | — | 既有 sessionsPage |
| `agent:listSkills` | new-op | `skills:listSkills` | providers | daemon 才能读 Provider 的 skill 目录 |
| `agent:llmPerformanceHistory` | new-op | `llmPerformance:llmPerformanceHistory` | analytics | usage JSONL 与 run 状态由 daemon 写 |
| `agent:llmPerformanceSummary` | new-op | `llmPerformance:llmPerformanceSummary` | analytics | usage JSONL 与 run 状态由 daemon 写 |
| `agent:loadSession` | forward | `historyTurnsPage` | — | 既有 historyTurnsPage |
| `agent:loadSessionOlder` | forward | `historyPage` | — | 既有 historyPage |
| `agent:mcpGuardScan` | new-op | `mcp:mcpGuardScan` | providers | MCP 与 trust gate 都在 daemon |
| `agent:mcpSnapshot` | new-op | `mcp:mcpSnapshot` | providers | MCP 与 trust gate 都在 daemon |
| `agent:newSession` | new-op | `providerContext:newSession` | providers | Provider 运行时在 daemon |
| `agent:providerDescriptors` | forward | `providers` | — | 既有 providers |
| `agent:reauthenticateMcp` | new-op | `mcp:reauthenticateMcp` | providers | MCP 与 trust gate 都在 daemon |
| `agent:recentFolders` | main | `—` | — | 窗口侧最近列表 |
| `agent:recorderContentPage` | new-op | `recorderContent:recorderContentPage` | evidence | recorder 记录写在工作区里，由 daemon 读 |
| `agent:removePiProfile` | new-op | `piProfile:removePiProfile` | providers | Provider 配置随 adapter 一起迁移 |
| `agent:removeProject` | new-op | `projectStore:removeProject` | navigation | 设备也读项目目录，必须单一写者 |
| `agent:removeRecentFolder` | main | `—` | — | 窗口侧最近列表 |
| `agent:renameProject` | new-op | `projectStore:renameProject` | navigation | 设备也读项目目录，必须单一写者 |
| `agent:renameSession` | forward | `sessionAction` | — | 既有 sessionAction |
| `agent:revealProject` | main | `—` | — | 原生 showItemInFolder |
| `agent:runControls` | forward | `providers` | — | providers 的 selected |
| `agent:setCwd` | new-op | `workspaceSelection:setCwd` | navigation | 当前工作区是 daemon 授权上下文的一部分 |
| `agent:setProjectPinned` | new-op | `projectStore:setProjectPinned` | navigation | 设备也读项目目录，必须单一写者 |
| `agent:setSessionArchived` | forward | `sessionAction` | — | 既有 sessionAction |
| `agent:setSessionPinned` | forward | `sessionAction` | — | 既有 sessionAction |
| `agent:start` | forward | `submit` | — | 既有 submit（带 intentId） |
| `agent:stats` | new-op | `usage:stats` | analytics | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:steer` | new-op | `runControl:steer` | controls | run 登记表在 daemon |
| `agent:stop` | forward | `stop` | — | 既有 stop |
| `agent:stopBackgroundTask` | new-op | `runControl:stopBackgroundTask` | controls | run 登记表在 daemon |
| `agent:syncBillingAdmin` | new-op | `billing:syncBillingAdmin` | analytics | 账本与 transcript 在 daemon 侧 |
| `agent:testMcp` | new-op | `mcp:testMcp` | providers | MCP 与 trust gate 都在 daemon |
| `agent:traceAck` | main | `—` | — | renderer 消费回执 |
| `agent:traceResynchronized` | main | `—` | — | main 的投递桥状态 |
| `agent:turnTerminalEvidence` | new-op | `turnEvidence:turnTerminalEvidence` | evidence | 归档终态由 daemon 写 |
| `agent:unreadSessions` | main | `—` | — | badge 由 main 渲染 |
| `agent:usageAnalytics` | new-op | `usage:usageAnalytics` | analytics | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:usageCredits` | new-op | `usage:usageCredits` | analytics | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `agent:usageStats` | new-op | `usage:usageStats` | analytics | usage 来自 daemon 持有的 SQLite 与 usage JSONL |
| `app:copyText` | main | `—` | — | 剪贴板 |
| `app:performanceDiagnosticsEnabled` | main | `—` | — | 本机性能开关 |
| `app:rendererRestart` | main | `—` | — | 窗口行为 |
| `app:reportRendererPerformance` | main | `—` | — | renderer 自报指标 |
| `app:setTheme` | main | `—` | — | 窗口主题 |
| `conversation:adopt` | new-op | `conversation:adopt` | history | 对话账本在 daemon 的 SQLite 里 |
| `conversation:create` | new-op | `conversation:create` | compose | 对话账本在 daemon 的 SQLite 里 |
| `conversation:createSideChat` | new-op | `conversation:createSideChat` | compose | 对话账本在 daemon 的 SQLite 里 |
| `conversation:delete` | new-op | `conversation:delete` | navigation | 对话账本在 daemon 的 SQLite 里 |
| `conversation:findSideChatCommand` | new-op | `conversation:findSideChatCommand` | compose | 对话账本在 daemon 的 SQLite 里 |
| `conversation:fork` | new-op | `conversation:fork` | navigation | 对话账本在 daemon 的 SQLite 里 |
| `conversation:list` | new-op | `conversation:list` | navigation | 对话账本在 daemon 的 SQLite 里 |
| `conversation:listSideChats` | new-op | `conversation:listSideChats` | navigation | 对话账本在 daemon 的 SQLite 里 |
| `conversation:preview` | new-op | `conversation:preview` | compose | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewAdoption` | new-op | `conversation:previewAdoption` | history | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewDeletion` | new-op | `conversation:previewDeletion` | navigation | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewSideChat` | new-op | `conversation:previewSideChat` | compose | 对话账本在 daemon 的 SQLite 里 |
| `conversation:read` | new-op | `conversation:read` | history | 对话账本在 daemon 的 SQLite 里 |
| `conversation:readItem` | new-op | `conversation:readItem` | history | 对话账本在 daemon 的 SQLite 里 |
| `conversation:readSideChatSnapshot` | new-op | `conversation:readSideChatSnapshot` | history | 对话账本在 daemon 的 SQLite 里 |
| `conversation:send` | new-op | `conversation:send` | send | 对话账本在 daemon 的 SQLite 里 |
| `conversation:update` | new-op | `conversation:update` | navigation | 对话账本在 daemon 的 SQLite 里 |
| `remote:desktop:disable` | main | `—` | — | DesktopRemoteClient |
| `remote:desktop:invite` | main | `—` | — | DesktopRemoteClient |
| `remote:desktop:status` | main | `—` | — | DesktopRemoteClient |
| `remote:device:revoke` | new-op | `localPairing:revoke` | remote | 配对权威随 daemon 迁移 |
| `remote:pairing:begin` | new-op | `localPairing:begin` | remote | 配对权威随 daemon 迁移 |
| `remote:pairing:cancel` | new-op | `localPairing:cancel` | remote | 配对权威随 daemon 迁移 |
| `remote:pairing:confirm` | new-op | `localPairing:confirm` | remote | 配对权威随 daemon 迁移 |
| `remote:status` | new-op | `localHostStatus:status` | remote | 宿主状态由 daemon 持有 |
| `runTraces:ack` | main | `—` | — | main 投递桥记账 |
| `runTraces:confirm` | main | `—` | — | main 订阅状态 |
| `runTraces:resync` | main | `—` | — | main 订阅状态 |
| `runTraces:setLegacyDemand` | main | `—` | — | 窗口焦点决定 |
| `runTraces:subscribe` | main | `—` | — | main 拉流后分发 |
| `runTraces:unsubscribe` | main | `—` | — | main 拉流后分发 |
| `terminal:ack` | forward | `desktopWorkbench:terminalAck` | — | PTY 在 daemon |
| `terminal:active` | forward | `desktopWorkbench:terminalActive` | — | PTY 在 daemon |
| `terminal:attach` | forward | `desktopWorkbench:terminalAttach` | — | PTY 在 daemon |
| `terminal:close` | forward | `desktopWorkbench:terminalClose` | — | PTY 在 daemon |
| `terminal:ready` | forward | `desktopWorkbench:terminalReady` | — | PTY 在 daemon |
| `terminal:recordingDelete` | forward | `desktopWorkbench:terminalRecordingDelete` | — | 录制在 daemon |
| `terminal:recordingList` | forward | `desktopWorkbench:terminalRecordingList` | — | 录制在 daemon |
| `terminal:recordingRead` | forward | `desktopWorkbench:terminalRecordingRead` | — | 录制在 daemon |
| `terminal:resize` | forward | `desktopWorkbench:terminalResize` | — | PTY 在 daemon |
| `terminal:start` | forward | `desktopWorkbench:terminalStart` | — | PTY 在 daemon |
| `terminal:write` | forward | `desktopWorkbench:terminalWrite` | — | PTY 在 daemon |
| `workspace:create` | forward | `desktopWorkbench:workspaceCreate` | — | 工作区写入归 daemon |
| `workspace:list` | forward | `desktopWorkbench:workspaceList` | — | 工作区读取归 daemon |
| `workspace:move` | forward | `desktopWorkbench:workspaceMove` | — | 工作区写入归 daemon |
| `workspace:openExternal` | forward | `desktopWorkbench:workspaceOpenExternal` | — | 工作区内交给系统打开 |
| `workspace:openKnownExternal` | main | `—` | — | main 的只读引用表 |
| `workspace:read` | forward | `desktopWorkbench:workspaceRead` | — | 工作区读取归 daemon |
| `workspace:readKnown` | main | `—` | — | main 的只读引用表 |
| `workspace:readPage` | forward | `desktopWorkbench:workspaceReadPage` | — | 工作区读取归 daemon |
| `workspace:readPageKnown` | main | `—` | — | main 的只读引用表 |
| `workspace:rename` | forward | `desktopWorkbench:workspaceRename` | — | 工作区写入归 daemon |
| `workspace:resolveFile` | main | `—` | — | main 签发只读引用 |
| `workspace:trash` | forward | `desktopWorkbench:workspaceTrash` | — | 工作区写入归 daemon |
| `workspace:write` | forward | `desktopWorkbench:workspaceWrite` | — | 工作区写入归 daemon |
