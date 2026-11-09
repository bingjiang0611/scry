# P3 附录 · IPC 路由矩阵：desktopWorkbench 转发（生成文件）

本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing-workbench.json` 后重新生成。判定规则与其余 channel 见 [P3-ipc-matrix](P3-ipc-matrix.md)。

| channel | 去向 | op(method) | 用户路径 | 差异与分工 | 依据 |
|---|---|---|---|---|---|
| `sourceControl:acknowledge` | forward | `desktopWorkbench:acknowledge` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:diff` | forward | `desktopWorkbench:diff` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:loadCommitDraft` | forward | `desktopWorkbench:loadCommitDraft` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:loadDraft` | forward | `desktopWorkbench:loadDraft` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:mutate` | forward | `desktopWorkbench:mutate` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:operations` | forward | `desktopWorkbench:operations` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:pullRequest` | forward | `desktopWorkbench:pullRequest` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:pullRequests` | forward | `desktopWorkbench:pullRequests` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:read` | forward | `desktopWorkbench:read` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:reconcile` | forward | `desktopWorkbench:reconcile` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:saveCommitDraft` | forward | `desktopWorkbench:saveCommitDraft` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
| `sourceControl:saveDraft` | forward | `desktopWorkbench:saveDraft` | — | 等价（同一 sourceControlHandlers，经 desktopWorkbench sourceControl surface，每次按 repositoryId 与 workspace 授权重验） | git 与 workspace 授权归 daemon |
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
| `workspace:read` | forward | `desktopWorkbench:workspaceRead` | — | 等价（同一 desktopWorkbench workspace surface，每次重验 cwd） | 工作区读取归 daemon |
| `workspace:readPage` | forward | `desktopWorkbench:workspaceReadPage` | — | 等价（同一 desktopWorkbench workspace surface，每次重验 cwd） | 工作区读取归 daemon |
| `workspace:rename` | forward | `desktopWorkbench:workspaceRename` | — | 等价（同上；写入带 expectedRevision，受限宿主按 typed 错误降级） | 工作区写入归 daemon |
| `workspace:trash` | forward | `desktopWorkbench:workspaceTrash` | — | 等价（同上；写入带 expectedRevision，受限宿主按 typed 错误降级） | 工作区写入归 daemon |
| `workspace:write` | forward | `desktopWorkbench:workspaceWrite` | — | 等价（同上；写入带 expectedRevision，受限宿主按 typed 错误降级） | 工作区写入归 daemon |
