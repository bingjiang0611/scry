# B4-L4 workbench：工作区与源代码管理经 daemon

上级状态见 [b4-l4](b4-l4.md)，路由见 [P3-ipc-matrix-workbench](../P3-ipc-matrix-workbench.md)（未改）。

## 结论

| 组 | channel | 结果 |
|---|---|---|
| workspace | list、read、readPage、write、create、rename、move | 已转发到 `desktopWorkbench` |
| sourceControl | 全部 12 个 | 已转发到 `desktopWorkbench` |
| workspace | openExternal、trash | 仍拒绝（`daemon_capability_unavailable:<channel>`），见下「待决定」 |
| terminal | 全部 11 个 | 仍拒绝，见下「待决定」 |

daemon 侧不需要改：`host-process.ts` 已经把 `createHostRuntime` 的 `desktopWorkbench` 交给宿主，本机 grant 直接可用（新测试第一次运行即通过，见下面的控制实验）。`openPath`/`trashItem` 没有接，宿主如实报告 `workbenchOps: { openPath: false, trashItem: false }`。

## 做了什么

| 层 | 改动 |
|---|---|
| App 转发表 | `daemon-local-ops/workbench.ts`：按矩阵的 surface/method 构造 `desktopWorkbench` 请求，只带 main handler 收到的那一个参数；回答经 `validateDesktopWorkbenchResponse`（与配对设备客户端同一份）校验后原样返回；`saveDraft`/`saveCommitDraft` 的 `null` 还原为 main 返回的 `undefined` |
| workspace 绑定 | 进程内 handler 要求请求的 cwd 与窗口选择（`agent:setCwd`）一致。转发时 query 的 cwd 用窗口选择，请求里的 cwd 原样带过去，由 daemon 两边都规范化后比对，并再验 known project；窗口没有选择时在发送前拒绝（同一错误文案）。`registerWorkspaceHandlers` 在 daemon 模式下安装这个来源 |
| sourceControl 绑定 | 进程内不绑窗口：`read(cwd)` 自带目录，其余只带 repositoryId。转发时 `read` 用它的参数作 cwd，成功读到的 `repositoryId → cwd` 记在 App 内存里（上限 64，LRU），其余方法按 id 找回 cwd；没读过的 id 在发送前拒绝，文案与进程内服务相同（「仓库引用已过期，请重新读取工作区」）。这张表只是路由：daemon 每次重读该目录并比对 id，不符即 `repository_context_mismatch` |
| 重放 | 新增 `DESKTOP_WORKBENCH_READ_METHODS`（shared），转发表的 `read`、配对设备客户端和 lane 路由共用。写入 `read: false`，App 的 daemon 传输不会在重连后重发 |
| lane 路由（改了 `desktop-lane-routing.ts`，最小改动） | 原来 `desktopWorkbench` 一律走 bulk 且 `replayableRequest` 为 true：配对设备客户端里的文件写入、Git 变更、PTY 输入在回复丢失后会被 lane 重发一次（与 `desktop-client-workbench.ts` 注释「写入从不自动重试」相反）。现在按 query.method 判断：写入走 control 且不可重放，读取仍走 bulk |

## 测试（新测试先失败，或先跑一次控制实验）

| 测试 | 断言 |
|---|---|
| `src/main/daemon-local-ops/workbench.test.ts` | 转发表恰好覆盖矩阵中 workspace/sourceControl 的 19 行；请求的 surface/method 与矩阵一致、绑定窗口 cwd、多余参数不带；无窗口选择时不发送；sourceControl 按读过的仓库路由，没读过的 id 不发送；`read` 标记、lane、`replayableRequest` 三者一致；回答形状错误时拒绝；经闸门的写入在回复丢失时只发一次、`replayable: false`、报 `daemon_outcome_unknown`；openExternal、trash 和 terminal 经闸门是具名缺席 |
| `src/main/remote/desktop-lane.test.ts`（新增一条） | `terminalWrite`、`terminalClose`、`workspaceWrite`、`mutate` 不可重放且走 control；没有 method 的请求不算读；读取可重放且走 bulk |
| `src/daemon/host-process-workbench.test.ts`（真实 daemon、本机 socket 与 grant） | 读写授权工作区里的文件，过期 revision 的写入被拒且文件不变；未授权目录、请求 cwd 与 query cwd 不一致、`..` 逃逸都被拒且没有写到外面；git 仓库读出 id 后 operations/loadCommitDraft 可用，同一 id 换到另一个仓库目录被拒（`repository_context_mismatch`）；trash/openExternal 是具名缺席，文件仍在 |

首次运行：App 侧 8 条中 7 条失败（转发表为空），具名缺席那条通过（当时一切都被拒绝）；实现后 lane 那条仍失败，暴露了上面的重放问题。daemon 侧 4 条首次即通过，因为宿主早已接好。

控制实验（做完均已恢复）：

- 把 lane 路由恢复成旧版本 → lane 新测试与转发表的 lane 测试失败（`terminalWrite`、`workspace:write` 被判为可重放）。
- 转发表所有条目改成 `read: true` → 「只发一次」与「read 标记」两条失败。
- 把 openExternal 加进转发表 → 「恰好 19 行」与「具名缺席」两条失败。
- 宿主的 `authorizeWorkspace` 改成放行任意目录 → daemon「未授权目录」一条失败。
- 去掉宿主的 `desktopWorkbench` → daemon 读写、源代码管理、`workbench: 1` 三条失败。

## 门禁（Linux 容器，root，其它 lane 并行，load 约 8）

- `npm run typecheck` 通过。
- `npx vitest run src/daemon src/main scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts`：3227 passed / 4 failed / 3 skipped。两条是已知的 root 环境失败（desktop-directory-picker、db-outbox 的 chmod）；另两条（`conversation-side-chat-snapshot` 5 s 超时、`pi.test.ts` 计时断言 2999 < 3000）单独重跑在改动下连续两次通过，基线也通过，判为负载下的时序抖动，与本改动无引用关系。
- 未改 `scripts/performance-paths.json` 的 sources 文件，未跑 `performance:measure`。

## 与进程内的差异

- 大文件：daemon 的 workbench 对超过 3 MiB 的整文件读取回「文件较大，请使用分页只读视图」，renderer 已有的回退会转到分页只读视图；进程内没有这个上限。
- 源代码管理每个非 read 调用在 daemon 上都会先完整读一次仓库状态来核对 id（`desktop-workbench.ts` 既有行为）。面板刷新是 read + operations + loadCommitDraft，在 daemon 模式下 git status 从 1 次变 3 次，每次选文件看 diff 多 1 次。未测（L1 也没测）。可选修复：`SourceControlService` 提供只做 `rev-parse` 身份核对的方法给 workbench 用；`service.ts` 在性能 sources 里，需单独做并跑 `performance:measure`。
- 错误文案经宿主 dispatch 截到 64 个字符。

## 待决定

1. **openExternal / trash。** daemon 没有 `shell`。可选：
   - A：矩阵改为 `main`（进程内）。App 的 handler 只依赖窗口选择（`agent:setCwd` 已用 App 读到的 known project 授权过）、异步 realpath 包含检查和 `shell`；openExternal 的跨项目回退要读 known project 列表（App 读 daemon 拥有的 userData，属第二读者）；trash 不经 daemon 的工作区租约（进程内本来也不经）。
   - B：daemon 新增仅本机 scope 的方法，校验后只返回规范目标路径，App 用结果处理器做 `shell` 调用。需要新的 op/method、矩阵与 ops 文档。校验与调用之间多一次往返，同一用户下的并发篡改本就不在信任模型内。
   - 维持现状：具名缺席。
2. **terminal。** 不只是转发：
   - 输出：进程内用 `terminal:data/exit/recordingError` 推给窗口；workbench 是轮询 `terminalEvents`（游标、150 ms）。要么 App 主进程起一个轮询泵再推给 renderer，要么在 App 事件流（`appEvents`）里加终端事件——后者是新的推送通道。
   - 生命周期：workbench 的 PTY 按 (peer, cwd) 存在 daemon 里，只在 peer 被释放时关闭。App 退出或崩溃后，本机 grant 的 shell 会一直留在 daemon 里，需要决定是否允许、何时回收。
   - 语义：`terminal:active` 进程内没有 cwd，workbench 按 cwd 分组；ack 进程内是增量字节，workbench 是累计值（renderer 的远程适配器在做换算）；`terminal:ready` 的前缀校验在 workbench 里没有。
3. **lane。** 已解决（维护者 2026-11-11 同意）：工作台写入改走单独的 `workbench` lane，不重放、取消时不拆连接。push/merge 再长，同一连接的 stop/answer 也不会排在它后面。连其他宿主的客户端与 daemon 模式共用这条规则。
4. 本次改动的 lane 路由同时作用于配对设备客户端（远程工作台的写入不再被 lane 重放，并从 bulk 换到 control）。

## 未验证

- 未在 macOS、未在真实 App 中以 `SCRY_HOST_DAEMON=1` 操作文件面板与源代码管理面板。

## 第二轮：openExternal / trash 留在 App（维护者选 A）

- 路由：两行改为 `main`（`scripts/daemon-ipc-routing-workbench.json`，原因写明 daemon 没有 shell），加入 `DAEMON_MODE_IN_PROCESS_CHANNELS`；从 `daemon-local-ops/workbench.ts` 的「故意留空」注释里移除。`daemon-ipc-differences.json` 里这两行的 forward 差异记录随之删除。
- 授权不变：两个 handler 仍是 `authorizedWorkspaceRequest(getCurrentCwd(), request)`，请求目录必须是窗口选择。
- 不读 daemon 拥有的文件：trash 本来只碰工作区与 `shell.trashItem`。openExternal 的跨项目回退原来调用 `knownProjectDirectories()`（读 App 自己 userData 里的 recent folders、project store、会话目录）；daemon 模式下改为向 daemon 取 `agent:listProjects` 的 cwd 与 `agent:recentFolders` 的并集，所选候选也用这份列表经 `knownProjectDirectory` 重验，而不是 `resolveKnownProjectDirectory`。只在当前工作区没有该文件时才问 daemon（`openWorkspaceFileExternally` 的 `roots` 可传异步函数，进程内行为不变）。daemon 不可用或回答形状不对时拒绝（`daemon_capability_unavailable:agent:listProjects` / `invalid_daemon_known_projects`），不弹窗、不打开。
- 与进程内的差异：这份并集比进程内窄——已移除项目下的会话目录、managed worktree 不在 `listProjects` 里——只会少给候选。`listProjects` 在 daemon 侧会做一次与侧栏刷新相同的 seed 与对话目录读取，只在回退路径上发生。
- 测试：`src/main/bootstrap/workspace-daemon.test.ts`（经生产闸门包装）——两个 channel 在进程内执行且不发给 daemon；仍绑定窗口选择；回退从 daemon 的项目里找到文件并打开，进程内的 `knownProjectDirectories` / `resolveKnownProjectDirectory` 一次都没被调用；daemon 不可用时拒绝。`workbench.test.ts` 改为只数 forward 行，并断言这两个 channel 不在转发表、闸门原样放行。首次运行 4 条全部失败（闸门拒绝）。控制实验：把 daemon 模式判断写死为 false → 3 条失败；把两项移出进程内集合 → 2 条失败。
- 未验证：macOS 与真实 App 中以 `SCRY_HOST_DAEMON=1` 点击文件链接与移到废纸篓。

## f2df3d0 本机 UI 验证

- 文件面板：读、写、新建、改名、移动、移到废纸篓、系统打开，在 daemon 模式下都执行成功；系统打开后实际启动的进程没有单独观测。
- 源代码管理：读取、diff、提交草稿的保存与回读都通过。
- **推送被拒**（「工作目录尚未通过 Scry 目录选择器授权」）：推送到本地路径 remote 时，这个路径本身必须是已授权的目录（`authorizeLocalRemote` 走 `resolveKnownProjectDirectory`），两种模式一致，属于已有的安全规则。补测时，在启动前把 bare remote 的路径写进临时 userData 的 `recent-folders.json` 即可，不需要原生选择器。
- 「推送中途点停止」要测的是 **Agent 运行的停止按钮**，不是源代码管理里的取消：用来确认工作台写操作走单独的 lane 之后，一次慢推送不会让运行的停止排队。尚未测。

## A8 补测：慢推送期间点 Agent 运行的停止（d75cfca）

本地 bare remote 的 pre-receive 钩子里 `sleep 10`，路径事先写入 recent-folders 完成授权。Agent 运行（paced prompt）进行中发起推送，推送挂起时点「停止本轮」：

| 模式 | 点击到运行停止 | 流是否被截断 | 推送结果 |
|---|---|---|---|
| daemon | 224 ms | 是（11/20 段） | 停止之后独立完成，11.7 s，远端 HEAD 与本地一致 |
| 关闭 | 297 ms | 是（12/20 段） | 停止之后独立完成，11.4 s |

对照（没有推送在途）：daemon 422 ms、关闭 395 ms。停止没有被慢推送挡住，工作台写操作走单独 lane 的目的达到了。推送进行中，其他调用（`listProjects`）3 ms 返回。

附带确认：同一仓库里 Agent 运行还没结束时，`SourceControlService.busy()` 会拒绝 Git 写入（daemon 模式已验证；关闭模式这次没有构造出来，不算通过）。
