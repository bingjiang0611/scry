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
| `piProfile` | local | providers | { op:'piProfile', method:'addPiProfile'|'removePiProfile', args }：addPiProfile 的 args 是 App 选择框给出的启动器路径与窗口工作区（可为 null），不是渲染端参数 | removePiProfile：true；addPiProfile：{ status:'added', agent } 或 { status:'failed', message }（失败由 App 弹窗） | 已验证 peer + scope: local；profile id 形状校验；握手目录须是 daemon 已知项目（resolveKnownProjectDirectory），否则按失败回答；配置文件属 daemon 的 userData，不含密钥 |
| `projectStore` | local | navigation | { op:'projectStore', method, args }（App 渲染端参数原样） | 与 main 同一 handler 的结果（project-channels.ts / startup-channels.ts）：项目列表、最近目录、boolean，removeRecentFolder 回新的最近目录列表 | 已验证 peer + scope: local；项目目录须为绝对路径（与 main 相同，不要求已授权：只改列表元数据或收窄授权）；recentFolders/removeRecentFolder 读写的就是 daemon 的授权输入（knownProjectDirectories），daemon 模式下 main 不写 |
| `providerCatalog` | local | providers | { op:'providerCatalog', method:'detect'|'detectFast'|'providerDescriptors'|'runControls', args } | 与 main 同一 handler 的结果（startup-channels 的 providerDetectionChannelHandlers / providerControlChannelHandlers） | 已验证 peer + scope: local（只在本机端点存在）；runControls 与 Provider 认证同队列（withProviderOperation） |
| `providerContext` | local | providers | { op:'providerContext', method, args }（App 渲染端参数原样；invalidateProviderContext 缺 cwd 时由 App 先填窗口工作区） | true | 已验证 peer + scope: local；Provider 须已注册（registry.get），与该 Provider 的认证操作同队列；只清会话选择与 Provider 缓存，不执行仓库代码 |
| `providerCommands` | local | providers | { op:'providerCommands', method, args:[context] } | 现有 CapabilityEnvelope<ProviderCommand[]>（state/mode/observedAt 原样；不可用时 data: null + reason） | 已验证 peer + scope: local；在该 Provider 的操作队列内读取，与 main 同一份实现 |
| `recorderContent` | local | evidence | { op:'recorderContent', method, args:[request, cwd] }：request 为 renderer 原样请求，cwd 由 App 追加（窗口当前工作区，无选择时为空串） | 现有 recorder content page | 已验证 peer + scope: local；daemon 用自己的 resolveKnownProjectDirectory 重验 cwd（未知即 recorder_workspace_unavailable）+ `.scry` 路径与记录引用校验；App 在回复后再比对窗口选择 |
| `runControl` | local | controls | { op:'runControl', method, runId, payload } | 现有 run 控制结果 | 已验证 peer + run 归属 + authorize(cwd) |
| `sessionHistory` | local | history | { op:'sessionHistory', method:'loadSession'|'loadSessionOlder', args } | loadSession：{ page, selection }（App 应用 selection 后把 page 交给 renderer）；loadSessionOlder：与 main 同一 handler 的页 | 已验证 peer + scope: local（只在本机端点存在）；会话须属于 daemon 的 App catalog，cwd 经 resolveKnownProjectDirectory 重验 |
| `terminal` | local | terminal | { op:'terminal', method, args }（渲染端参数原样，末尾附 App 窗口当前 cwd 或 null）；输出另由 { op:'terminalFeed', method:'read', cursor } 按游标读取 | main 同一处理函数的返回值；terminalFeed.read 返回 { cursor, events }（每页不超过 512 KiB） | 本机 grant；daemon 用 resolveKnownProjectDirectory 重新解析 App 附上的 cwd，未知目录拒绝；ownership epoch 与 ready/ack 流控和进程内相同 |
| `sessionLifecycle` | local | navigation | { op:'sessionLifecycle', method, args }（App 渲染端参数原样） | main 同一处理函数的返回值（DeleteSessionResult / boolean） | 本机 grant；daemon 内与进程内相同的 contextAdmission、统一对话写入校验与运行中会话判定；删除确认框由 App 在发送前弹出 |
| `sessionPurge` | local | navigation | { op:'sessionPurge', method, request } | 现有批量删除结果（逐条 preview 与指纹） | 已验证 peer + authorize(cwd) + 指纹确认与逐条预览 |
| `sessionStore` | local | navigation | { op:'sessionStore', method:'listSessions'|'catalogHealth'|'listArchivedSessions', args } | 现有 appSessionStore 结果（健康、归档列表） | 已验证 peer + authorize(context.cwd) + provider/profile |
| `skills` | local | providers | { op:'skills', method, context } | 现有 skill 列表 envelope | 已验证 peer + authorize(context.cwd) + provider 白名单 |
| `turnEvidence` | local | evidence | { op:'turnEvidence', method, context, runId } | 现有终态证据数组 | 已验证 peer + 先过 catalog 校验 cwd/sessionId + run 归属 |
| `usage` | local | analytics | { op:'usage', method, context?, range? } | 现有 usage 投影（缺失证据仍是 unavailable，不回 0） | 已验证 peer + authorize(context.cwd)（有 context 时）+ 结果上限 |
| `workspaceDiff` | local | source-control | { op:'workspaceDiff', method:'gitDiff'|'gitDiffSnapshot'|'gitDiffCommits'|'gitCommitDiffSnapshot', args } | 现有 WorkspaceDiffResult / WorkspaceDiffSnapshotResult / 提交列表与提交 diff 快照 | 已验证 peer + scope: local；按 canonical cwd 重验项目授权（与 main 的 authorizeDirectory 相同） |
| `workspaceSelection` | local | navigation | { op:'workspaceSelection', method:'chooseFolder'|'setCwd'|'read'|'inspectStart'|'validateBranch', args }：chooseFolder 的 args 是 App 目录选择框给出的路径，不是渲染端参数；setCwd 的 args 是窗口要选中或已知项目文件通道请求里的目录；其余为渲染端参数原样 | chooseFolder：daemon 记住的 canonical 目录（App 随后选中）；setCwd：daemon 已知项目的 canonical 目录（目录参数为空时 null），不落盘；read/inspectStart/validateBranch：现有 SourceControlService 的 worktree 选择、准备检查与分支校验结果 | 已验证 peer + scope: local；按 canonical 目录重验（chooseFolder 由 daemon 校验真实目录并持久化；read 只读 daemon 已知项目；inspectStart/validateBranch 只认 daemon 自己读过的 repositoryId，并重验其根目录授权与仓库身份）；setCwd 用 daemon 自己的 resolveKnownProjectDirectory（最近目录、未移除的项目、会话 cwd）。窗口当前工作区留在 App |
