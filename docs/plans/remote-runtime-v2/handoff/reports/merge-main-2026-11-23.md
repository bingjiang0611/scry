状态：合并已提交，待验证

把 `origin/main`（`a60c498b`，#131–#170）合入 `claude/scry-performance-optimization-46ngcf`（`71bab069`）。保留本分支的架构：App 只走 daemon（S3）、会话目录与详情投影（P4-4）、`subscribe` 与协议 v3（P4-5a/5b）、P4-6 的删除。main 的修复按行为重放到现在的位置。

## 移到新位置的修复

- #131 本机截图按完整意图上限校验：`parseRouting(detail, scope)` 采用 main 的形参；本分支允许 App 在给出源目录时带工作区选择，这条规则不变。
- #133 超大本机截图分块暂存：`prepareSubmit` 进入 `daemon-run-surface.ts`。暂存前的只读回执查询改用 v3 的 `intentStatusAtLog`；`unknown_intent` 记为 `daemon_run_unknown`，不会调用写墓碑的 `resolveIntent`。
- #136 绑定不等前一个运行的终态读取：`daemon-run-subscribe.ts` 自动合入；测试改用只有订阅的 `DaemonEventPump`。
- #140 提交响应丢失后核对回执：恢复从 surface 移到 `DaemonRunRuntime.start`。v3 没有 `watch` 游标，所以不移植 `initialWatch`；恢复的回执与重复提交一样读取该运行的 `activeRuns` 投影行，再按正常的绑定与准入等待。缺少绑定或准入时不聚焦窗口。意图 ID 仍按 main 由 commandId 派生，内联与分块两种表示共用一个。
- #138 原工作目录不存在时打开历史：目录判定移到 `history-catalog.ts`；`workspaceMissing` 加在 `src/shared/session-history.ts`。daemon 侧的 `agent:setCwd` 已支持 `clearIfMissing`。
- #144 远程会话先确认实时运行：保留首次读取时的历史刷新。冒烟测试在开会话前发布目录变化，因为本分支没有轮询。
- #147 实时 trace 加载时可排队：冒烟先等队列出现，再发布运行变化。
- #149 大运行接回：`DaemonRunTransport.adopt` 先取 `traceContext`，再分块读取 trace。宿主与客户端都保留统一对话的接管拒绝（`refused`）。
- #151 worktree 准备进度：v3 没有 `watch`，进度改为 `SubscribeHub` 的易失状态。宿主把 `workspaceProgress` 标记写到运行行和 run hint，准入时标记为 `completed`。App 自己的窗口通过保留的 `workspaceSelection:progress` 窗口通知接收，每个运行只保留最新一条。设备端从订阅行或 hint 读取并校验（`src/shared/workspace-prepare-progress.ts`）。`RemoteChatWorktreeSetup` 去掉了轮询间隔参数。
- #155 iOS 空状态：`RemoteRunStore.swift` 的四处改动移到 `RunStore/`：目录 `.denied`、归档读取夹具、Provider 选择保留、`workspace_not_authorized`。
- #167 记录仓库位置：`git-capture.ts` 同时保留 `.scry` 数据排除与位置采样。
- #170 打包宿主冒烟：保留本分支的能力断言（`hostAdminNotices: 1, subscribe: 1`）。

## 按设计不再适用

- `RemoteChat` 的 `{ immediate }` 选项（#144）：v3 的 `runStatus` 和 `liveRun` 直接读取保留的订阅投影，不会等下一次变化。API、preload 和冒烟中的 `openingLiveImmediate` 检查一并删除。`desktop-client-reads.test.ts` 保留本分支版本，main 的断言针对已删除的 `watch` 和 `liveRuns` 长轮询窗口。
- 运行时的 `initialWatch`/`#seen`（#140）：v3 没有 `watch` 游标。
- 进程内的 `agent:setCwd` 分支（#138）：S3 已删除进程内路径。
- `app-event-feed.ts` 的 `DAEMON_WINDOW_NOTICES`（#151）：P4-6 已删除该文件，通知改为加到 `SUBSCRIBE_RETAINED_WINDOW_NOTICES`。
- `RemoteChat` 的 `POLL_MS`/`setPollInterval`（#151）：本分支没有轮询。

## P4-5b 开工条件

main 在 #140 为 P4-5b 加了开工条件（原文）：

- 不依赖 `runState`：订阅重置后，确实已结束的运行只标记一次终态；快照生成后才启动的运行继续跟踪。单凭快照未列出不能判定终态。
- 不依赖 `intentStatus`：分块图片暂存前能只读查询既有回执，未找到不能阻断首次提交；提交响应丢失后能核对原回执，不重新提交，也不会在缺少绑定或准入证据时聚焦窗口。`resolveIntent` 在找不到意图时会写墓碑，不可直接替换上传前的只读查询。见 [protocol §5.7](../../P4-orchestration-protocol.md#57-协议版本与能力决定-f维护者-2026-11-18)。

v3 的做法：`runState` 由 `activeRuns` 投影行回答。分块暂存前与提交响应丢失后都只读调用 `intentStatusAtLog`。恢复路径见上文 #140。

## 拆分

合并后超过 20,000 字节、且与两侧都不同的文件已拆分：`QUEUE_COPY` 移到 `constants/queue-copy.ts`；窗格尺寸与详情订阅移到 `hooks/useAppPanes.ts`；缺失工作区冒烟移到 `scripts/electron-security-missing-workspace.mjs`；P4-5b 开工条件移到本页。main 上已超限、本次未改动的文件保持原样。
