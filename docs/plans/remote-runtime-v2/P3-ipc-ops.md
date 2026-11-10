# P3 附录 · 新增协议 op（生成文件）

本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑。

列出 [IPC 矩阵](P3-ipc-matrix.md) 判为 `new-op` 或 `split` 的 op。每个 op 用 `method` 区分通道（method 等于 channel 最后一段），与 `desktopWorkbench` 的 surface/method 约定一致：一个授权边界一个 op，不为每个 channel 造一个顶层 op。

`scopes` 是允许调用该 op 的调用方范围：`local` = 本机 App（unix socket + `scope: local` grant），`remote` = 已配对设备。默认只有 `local`；任何新增 `remote` 都要先写进 `scripts/daemon-ipc-remote-approvals.json`，那属于授权扩大，需维护者批准。

| op | 调用方 | 用户路径 | 请求 | 响应 | 授权 |
|---|---|---|---|---|---|
| `billing` | local | analytics | { op:'billing', method, context? } | 现有 billingState / admin 同步结果 | 已验证 peer + authorize(context.cwd)；fixture 导入额外要求开发开关 |
| `conversation` | local | history | { op:'conversation', method, id?, cwd?, cursor?, request? } | 现有 conversationService 结果（列表/正文/预览/更新/删除回执） | 已验证 peer + scope: local；每次按 cwd 归属与对话归属重验，删除需指纹确认 |
| `llmPerformance` | local | analytics | { op:'llmPerformance', method, runId? } | 现有 history / summary 结构 | 已验证 peer + authorize(cwd)；summary 只覆盖当前 workspace 的 run |
| `localHostStatus` | local | remote | { op:'localHostStatus', method:'status' } | 现有 host 状态（hostId、监听、租约、设备数） | 只在 unix socket 上、且调用方持有 scope: local grant |
| `localPairing` | local | remote | { op:'localPairing', method:'begin'|'confirm'|'cancel'|'revoke', payload } | 现有 PairingAuthority 结果 | 只在 unix socket 上、且调用方持有 scope: local grant（见 P3 §13.2） |
| `mcp` | local | providers | { op:'mcp', method, context, targetId? } | 现有 MCP 快照/探测/重认证 envelope（含 unavailable） | 已验证 peer + authorize(context.cwd) + 每次重验仓库 trust 与指纹 |
| `piProfile` | local | providers | { op:'piProfile', method, profile } | pi profile 列表或错误 envelope | 已验证 peer + profile 形状校验（配置文件属 daemon 的 userData） |
| `projectStore` | local | navigation | { op:'projectStore', method, cwd, label?, pinned? } | 现有 project store 结果 | 已验证 peer + scope: local + authorize(cwd)；recentFolders/removeRecentFolder 读写的就是 daemon 的授权输入（knownProjectDirectories），main 不得自己写 |
| `providerCatalog` | local | providers | { op:'providerCatalog', method:'detect'|'detectFast'|'providerDescriptors'|'runControls', args } | 与 main 同一 handler 的结果（startup-channels 的 providerDetectionChannelHandlers / providerControlChannelHandlers） | 已验证 peer + scope: local（只在本机端点存在）；runControls 与 Provider 认证同队列（withProviderOperation） |
| `providerContext` | local | providers | { op:'providerContext', method, context } | context 归一化或 invalidation 结果 | 已验证 peer + authorize(context.cwd) + provider 白名单 |
| `recorderContent` | local | evidence | { op:'recorderContent', method, cwd, cursor } | 现有 recorder content page | 已验证 peer + authorize(cwd) + `.scry` 路径校验 |
| `runControl` | local | controls | { op:'runControl', method, runId, payload } | 现有 run 控制结果 | 已验证 peer + run 归属 + authorize(cwd) |
| `sessionHistory` | local | history | { op:'sessionHistory', method:'loadSession'|'loadSessionOlder', args } | loadSession：{ page, selection }（App 应用 selection 后把 page 交给 renderer）；loadSessionOlder：与 main 同一 handler 的页 | 已验证 peer + scope: local（只在本机端点存在）；会话须属于 daemon 的 App catalog，cwd 经 resolveKnownProjectDirectory 重验 |
| `sessionLifecycle` | local | navigation | { op:'sessionLifecycle', method, args }（App 渲染端参数原样） | main 同一处理函数的返回值（DeleteSessionResult / boolean） | 本机 grant；daemon 内与进程内相同的 contextAdmission、统一对话写入校验与运行中会话判定；删除确认框由 App 在发送前弹出 |
| `sessionPurge` | local | navigation | { op:'sessionPurge', method, request } | 现有批量删除结果（逐条 preview 与指纹） | 已验证 peer + authorize(cwd) + 指纹确认与逐条预览 |
| `sessionStore` | local | navigation | { op:'sessionStore', method:'listSessions'|'catalogHealth'|'listArchivedSessions', args } | 现有 appSessionStore 结果（健康、归档列表） | 已验证 peer + authorize(context.cwd) + provider/profile |
| `skills` | local | providers | { op:'skills', method, context } | 现有 skill 列表 envelope | 已验证 peer + authorize(context.cwd) + provider 白名单 |
| `turnEvidence` | local | evidence | { op:'turnEvidence', method, context, runId } | 现有终态证据数组 | 已验证 peer + 先过 catalog 校验 cwd/sessionId + run 归属 |
| `usage` | local | analytics | { op:'usage', method, context?, range? } | 现有 usage 投影（缺失证据仍是 unavailable，不回 0） | 已验证 peer + authorize(context.cwd)（有 context 时）+ 结果上限 |
| `workspaceDiff` | local | source-control | { op:'workspaceDiff', method:'gitDiff'|'gitDiffSnapshot'|'gitDiffCommits'|'gitCommitDiffSnapshot', args } | 现有 WorkspaceDiffResult / WorkspaceDiffSnapshotResult / 提交列表与提交 diff 快照 | 已验证 peer + scope: local；按 canonical cwd 重验项目授权（与 main 的 authorizeDirectory 相同） |
| `workspaceSelection` | local | navigation | { op:'workspaceSelection', method:'setCwd'|'chooseFolder'|'read'|'inspectStart'|'validateBranch', … } | setCwd/chooseFolder：归一化后的 cwd；read/inspectStart/validateBranch：现有 SourceControlService 的 worktree 选择、准备检查与分支校验结果 | 已验证 peer + scope: local；按 canonical 目录重验（chooseFolder 由 daemon 校验真实目录并持久化，setCwd 只接受已知项目根或用户目录；read/inspectStart/validateBranch 按 repositoryId 归属已授权工作区） |
