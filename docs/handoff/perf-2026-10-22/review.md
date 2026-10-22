# 性能问题审查（静态，`main@531e88c`）

只读源码得出，**未测量**。行号以 `531e88c` 为准，执行前请重新定位。已在 `docs/performance-opportunities.md` 排名的 git 等待、listCommands/runControls 不在此重复。

## #1 每次发送在主线程同步执行全系统 `ps`

- `src/main/agent-runner.ts:314` 与 `src/main/providers/qoder.ts:377` 在 spawn 后调用 `captureProcessIdentity`。
- → `src/main/process-diagnostics.ts:246` → `readProcessSnapshot` → `:57` `execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart=,command='])`：列出整机进程、解析全表、只取一个 PID；**无 timeout**。
- 位于 `stage.provider_launch` 用户等待段内；ps 卡住时主进程整体挂起。
- 方向：只查单 PID（`ps -o … -p <pid>`）、异步、加超时；保持“身份未知则拒绝发信号”。

## #2 会话目录与项目存储的同步读写

- `src/main/app-store.ts:183` `writeJsonRecoverable`：每次变更整份写 `.bak` + 主文件，`writeAtomic`（`:148`）各自 fsync 文件与目录，即每次 4 次 fsync、2 次全量序列化，全部同步。
- `record()`（`:420`）每轮多次调用：`src/main/index.ts:3589/3601/3888/4291/4523`；`app-sessions.json` 无上限。
- `index.ts:436-437` `recentStore()` / `projectStore()` 每次调用新建实例、无缓存，`load()` 都是 `readFileSync` + 全量校验；`knownProjectDirectories()`（`:443`）一次读 3 个文件，经 `resolveKnownProjectDirectory` 等在多个 IPC 路径调用。
- 方向：stat key 缓存读结果（appSessionStore 已有此模式可复用）；内容未变不重写；同一轮内合并多次 record。**不删 fsync/`.bak`。**

## #3 冷启动侧栏被全量归档扫描阻塞

- 每次写轮次 `upsertTraceArchiveTurnAsync` 都 `markTraceArchiveCatalogIndexDirtyAsync`（`src/main/transcript-archive.ts:2093`）。
- 启动后 `listProjectCatalog`（`index.ts:482`）先 `await recoverTraceCatalogOnce()`（`:451`）→ `discoverTraceArchiveSessionsAsync`（`transcript-archive.ts:455`）→ 索引 dirty 时 `scanTraceArchiveCatalogIndexAsync`（`:337`）逐个 `JSON.parse` 所有 per-turn 归档（上限 1 万文件/256 MB），再**同步** `writeTraceArchiveCatalogIndex`（≤32 MB）。
- 实际用途仅为 Qoder 目录补缺（`index.ts:463` 过滤 `providerId !== 'qoder'`），却扫描所有 Provider。
- 方向：写入时增量更新索引条目，或只扫 qoder 子树；不阻塞首屏项目列表，恢复结果经 `agent:dataUpdated` 推送。

## #4 轮次提交时同步、重复读取整份旧归档

- `src/main/managed-turn-commit.ts` 中 `matchingArchiveTurn`（`:395`，调用于 `:471` 与 `:688`）和 `archiveJournal`（`:492`）都调用同步 `findTraceArchiveTurnMatches`（`transcript-archive.ts:1946`）→ `readArchiveFile` → `inspectArchiveFile` → `readFileSync` + `JSON.parse` 整份 legacy 归档 + 精确轮次文件。
- 一次 `commitManagedTraceTurn` 最多读 3 遍；旧长会话每轮结束都付出此代价。`trace-turn-progress.ts:291` 同样调用。
- 方向：异步读一次、向下传递；保持 conflict / dominates / enriches 判定不变。

## #5 工作区 diff 视图复用整套轮次快照

- `agent:gitDiff`（`src/main/git.ts:12`）→ `gitNumstat`（`src/core/turn-recorder/git.ts:1326`）→ `beginGitTurnDiff`（`:311`）：rev-parse、status、可能再 status、mkdtemp、`read-tree`、`update-index --really-refresh`、`add -A`、`write-tree`（写临时对象库），再 `diff --numstat`，最后 rm 临时目录。约 7 次 spawn + 哈希所有脏/未跟踪文件。
- 无并发合并、无缓存。renderer 每次窗口可见即触发（`src/renderer/hooks/useIntegrations.ts:1168`），`loadGitDiff`（`:770`）先 `setGitDiff(null)` 清空已有结果。
- 既有日常记录：`ipc.agent:gitDiff` p50 741–1041 ms，p95 3282–5020 ms（`docs/performance-opportunities.md` 原始排名第 1）。

## #6 远程会话：全量快照轮询，后台不暂停

- 6a 不随窗口隐藏暂停的轮询：`src/renderer/components/RemoteChat.tsx:472`（1.5 s）、`src/renderer/hooks/useRemoteCatalogs.ts:75`（3 s）、`src/renderer/hooks/useDesktopConnections.ts:30`（3 s）、`src/renderer/components/RemotePairing.tsx:59`（2 s）。违反 CLAUDE.md「窗口不可见时暂停」。
- 6b `RemoteChat` 每次 `api.trace` 都经 relay 取回整轮 items（≤10 000，`src/main/remote/desktop-client.ts:30/521-532`），逐条校验后整体替换 `activeRun`；长轮次 O(n²)。本地路径已有游标/合批/背压（`index.ts:2944` `TraceOutputBridge`）。

## #7 iOS：单一 ObservableObject 带全部视图重绘

- `apps/ios/ScryRemote/RemoteRunStore.swift:23` `final class RemoteRunStore: ObservableObject`，67 个 `@Published`（`:192-523`），约 19 处视图观察。流式 `output`（`:385`）每次追加触发所有观察者重算 body。
- 部署目标 iOS 17.0，可用 `@Observable` 按属性追踪。

## #8 renderer transcript 与 App 重渲染

- `useAgentSession` 位于 `src/renderer/App.tsx:897`；每个 rAF trace 合批都重新执行 2900 行、45 个 state 的 `App` body。
- `src/renderer/components/ChatView.tsx:164-258`：窗口化时每个轮次常驻 DOM 壳，并各自注册 IntersectionObserver、MutationObserver、`focusout` 与 document 级 `selectionchange`。输入框光标移动也会触发 selectionchange → 每次按键 O(轮次数) 回调。
- 置信度中，尚无数据（compose 路径在既有覆盖缺口中）。
