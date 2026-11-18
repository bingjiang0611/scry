# B4-L4 本机验证记录

由维护者的 agent 在 macOS 上独立 worktree 中执行，只报告不提交。方案与实现见 [b4-l4](b4-l4.md)。

## H1 + L4-0（维护者的 agent，macOS，worktree `587b68c`）

| 项 | 命令 | 结果 |
|---|---|---|
| 1 | 闸门、ipc-trust、remote-defaults、矩阵测试 | 4 文件 / 29 测试通过 |
| 2 | `npm run typecheck`；`npx vitest run src/main src/daemon src/host-runtime` | 通过；3107 passed / 3 skipped / 0 failed。macOS 非 root 下 `db-outbox` 与 `desktop-directory-picker` 的「不可读目录」两条执行并通过（容器里的这两条失败确为 root 环境原因） |
| 3 | `npm run build`、`daemon-mode-smoke.mjs`、`test:desktop-remote` | 通过；smoke 12 步全 true |
| 4 | `SCRY_HOST_DAEMON=1` 开发实例 | 不崩溃、不白屏；未迁移通道显示可读错误，无无限转圈；主进程日志证实闸门拒绝且 handler 未执行 |
| 5a | `npm run pack:artifact` | **失败**于 `check:packaged-app`：supervisor 的 `ELECTRON_RUN_AS_NODE` 已被拆进 chunk，检查只读入口文件。既有问题（与 H1/L4-0 无关），已由 `0448e68` 修复：检查改为读 supervisor 入口的模块图 |
| 5b | 打包构建 + `SCRY_HOST_DAEMON=1`、不设 `SCRY_REMOTE_HOST` | App 未启动进程内远程宿主：`userData/remote` 不存在，无远程宿主启动日志，无配对监听端口；正对照（`SCRY_REMOTE_HOST=1`、不开 daemon 开关）同一构建会创建三个 lease 并由 App 进程持有 |

第 4 项发现的两处呈现问题已由 `a5169dc` 修复（项目读取失败显示「暂无项目」、catalog health 读取失败归因到 `app-sessions.json`；另把 IPC 包装前缀与 `daemon_capability_unavailable:*` 转成可读文案）。其中项目、会话列表、Provider 探测在 L4-1 之后已经由 daemon 回答，这次修的是「读取失败」时的呈现。

未覆盖：iOS 真机配对、`smoke:electron`（因 5a 当时失败未执行）、Linux。验证 agent 记录的环境注记：`npm ci` 受 npm allow-scripts 门禁未执行 6 个包的 install script（Electron 与 node-pty 产物需手动补齐）；开发实例里 `better-sqlite3` 因按 Node ABI 安装而初始化失败，分析面板额外降级——与闸门无关。

## L4-1（worktree `5e5bee7`）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `src/main src/daemon src/host-runtime` | 1 条失败：`host-process.test.ts` 的 recentFolders 断言。夹具存入的是 `/var/...` 原始路径，断言比较的是 realpath（macOS 上为 `/private/var/...`）。是测试夹具的问题，与产品无关：生产中目录选择器存的是规范路径 |
| `npm run build`、`daemon-mode-smoke.mjs`、`test:desktop-remote` | 通过 |
| `SCRY_HOST_DAEMON=1` 测试实例 | 项目列表、会话列表、Provider 选择器、run controls 都由 daemon 回答，显示正常；工作区选择器显示不可用（尚未迁移，符合预期） |
| 主进程日志中被闸门拒绝的通道 | `desktopRemote:list` 67 次，`agent:listCommands` 3 次，`agent:usageStats` 2 次，`agent:unreadSessions`、`agent:gitDiff`、`workspaceSelection:read` 各 1 次 |
| 分析面板 | 直接显示 Electron 的原始包装文本 “Error invoking remote method 'agent:usageAnalytics' …” |

清理已完成。旧会话遗留的孤儿 daemon（`/tmp/scry-g1-stuck-*`）验证 agent 没有处理，需要维护者自行确认后清理。

### 据此修复

| 发现 | 原因 | 修复 |
|---|---|---|
| `desktopRemote:*` 被拒，每秒轮询一次就报一次错 | 扫描器只认 `handleTrusted(` 和 `handle(` 两种写法。桌面客户端用 `` registerTrusted(`desktopRemote:${method}`) `` 注册，git diff 用 `register('agent:gitDiff'`，这 33 个通道都不在矩阵里，闸门把它们当作未分类通道拒绝了 | 扫描器补上这两种写法，并新增一项独立核对：preload 里 `invoke` 的每个通道都必须被注册扫描找到，否则记为缺陷。矩阵从 134 个通道增至 167 个，与 preload 一致。`desktopRemote:*` 路由到 main（另起 `daemon-ipc-routing-client.json` 记录），理由是这些连接属于 App 自己保存的宿主，不属于 daemon。闸门直接用 `DESKTOP_REMOTE_CLIENT_METHODS` 生成放行清单，不另外抄一份 |
| `agent:gitDiff` 等 4 个 git diff 通道 | 同上，之前漏扫 | 记为新 op `workspaceDiff`（仅 `scope: local`，用户路径 source-control）。按 canonical cwd 重新校验项目授权。本次只做分类，**还没有迁移**，所以闸门仍以命名缺席拒绝 |
| recentFolders 断言 | 见上 | 夹具改为存入规范路径，与生产一致 |
| 分析面板显示原始包装文本 | `useUsageInsights` 直接显示 `error.message` | 改用 `ipcErrorMessage` |

测试：

- `daemon-channel-gate.test.ts` 新增断言：除 `agent:unreadSessions` 外，每个 route `main` 的通道在开关打开时都在进程内执行。修复前这条测试失败，列出 29 个 `desktopRemote:*`。
- `daemon-ipc-matrix.test.ts` 新增：preload 调用了扫描没找到的通道时，记为缺陷。
- 控制实验：把扫描器恢复成只认 `handleTrusted|handle` 后，preload 核对立刻报出 4 个 `agent:git*` 通道。`desktopRemote:*` 这次是靠新增的模板展开找到的，不依赖这个正则。

还没处理的拒绝：`agent:listCommands`、`agent:usageStats`、`workspaceSelection:read`、`agent:gitDiff` 系列，以及按设计保持缺席的 `agent:unreadSessions`。它们都在后续迁移组里。

## `8a85351` + L4-2c `conversation:send`（worktree `292811f`）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| 7 个目标的 vitest（含 `src/main/remote`、`src/main/bootstrap`） | 127 个文件、814 条测试通过，0 失败 |
| `host-process.test.ts` | 2/2 通过。recentFolders 的规范路径断言在 macOS 上成立；实例中经 daemon 返回 `/private/tmp/...` |
| `npm run build`、`daemon-mode-smoke.mjs` | 通过：流式 20 次到达，间隔中位数 152 ms；提问回答两次；停止被接受；daemon 被 SIGKILL 后重启，新 run 正常结束 |
| 会话视图 | **打不开**：`conversation:read` 返回「统一对话分页游标无效」，视图停在「正在读取对话…」，发送按钮与 Agent 选择器都不可用 |
| 经同一 IPC 通道直接调用 | 第一次发送：20 段流式文本在 2.9 s 内到达，turn 为 `accepted`、`completed`；第二次发送后停止：`stop` 返回 true，turn 为 `accepted`、`interrupted` |
| 主进程日志中的命名缺席 | `agent:listCommands` 3、`agent:usageStats` 2、`agent:unreadSessions` 1、`agent:gitDiff` 1、`workspaceSelection:read` 1、`agent:usageAnalytics` 1；`conversation:send` 与 `desktopRemote:*` 为 0 |
| 分析面板 | 显示可读文案「后台服务尚未提供这项功能（agent:usageAnalytics）」，不再有 IPC 包装文本 |

### 会话视图打不开的原因与修复

原因：preload 调用时总会把可省略的参数一起传过去，`read(id)` 实际调用的是 `invoke('conversation:read', id, undefined)`。经 daemon 转发时，参数数组被序列化成 JSON，`undefined` 变成了 `null`。daemon 上运行的是 main 的同一个处理函数，它对 `beforeOrdinal !== undefined && !Number.isSafeInteger(beforeOrdinal)` 抛错。

这不只影响 `conversation:read`：所有转发给 daemon、且 renderer 省略了可选参数的通道都会这样。真实 daemon 测试没发现它，是因为测试里只传了一个参数，没有末尾的 `undefined`。问题从 L4-2a 起就存在。

修复：

- App 侧在转发时记下哪些位置是 `undefined`（`absent`）；
- daemon 在调用处理函数前把这些位置恢复成 `undefined`；
- renderer 自己传的 `null` 仍然是 `null`；
- `absent` 逐项校验：越界、重复、非整数都拒绝。

测试：

- transport 与本机 op 各加一条测试；
- 真实 daemon socket 用 renderer 实际发出的帧读取：不带标记时复现「统一对话分页游标无效」，带标记时读取成功；
- 控制实验：去掉 daemon 侧恢复，或去掉 App 侧标记，各自的测试都会失败。

同时，会话视图、会话正文、侧聊快照与发送 hook 的错误文案改用 `ipcErrorMessage`，不再显示 Electron 的 IPC 包装文本。

未覆盖：

- 通过输入框、Agent 选择器与停止按钮操作的完整 UI 路径（会话视图打不开，未能执行）；
- 被中断的一轮在界面上如何显示；
- 开发实例里 `better-sqlite3` 仍是 Node 的 ABI，DB 相关面板降级，这是已知的环境问题；
- `test:renderer:ui`、完整 `npm test` 与 Linux 未运行。

## E2（worktree `bfd38da`）与 E1b（`a525d9b`）

| 项 | 结果 |
|---|---|
| typecheck、build、`daemon-mode-smoke.mjs` | 通过；smoke 12 步全 ok，流式 20 次到达、间隔中位数 153 ms（b4-l3g 为 152 ms） |
| vitest（7 个目标） | 906 条测试 905 通过。1 条失败：`host-process.test.ts` 的等待循环按回复次数计上限，并行时被进度事件用完；父提交上同样失败，已由 `ecd2579` 改为按时间计上限 |
| 首 token（warm，P50，30 样本） | 两组干净的计时：daemon 124.7 / 120.2 ms，进程内 107.6 / 89.0 ms，差 +17 到 +31 ms（b4-l3f 为 +41 到 +58 ms）。第 1 组与另一个验证重叠且 highLoad，不计 |
| 更新间隔 | 两种模式一致：daemon 152 ms，进程内 151 ms |
| `eventLag` 指标 | daemon 约 1.5 s。这是统计方法造成的：daemon 把流式文本合成一个不断变长的条目，时间戳沿用第一段；实际到达间隔仍是 152 ms |
| 并发（A 停在提问，B 运行） | B 的 start 51 ms，首 token 70 ms，20 次到达，间隔 149 ms，与 B 单独运行一致；A 回答两次提问后正常结束 |
| 会话视图、停止、侧栏 | daemon 模式下不显示文字、停在「运行中」「记录收口中」，侧栏不刷新；父提交上相同。原因与修复见 [b4-l4-window](b4-l4-window.md) |
| 角标（a525d9b） | 窗口在后台时，一轮结束后角标从 0 变为 1，renderer 收到 `{revision: 2, keys: 1}`。「切回 App 后清除」和「窗口获得焦点时不闪」未验证：那台 Mac 停在登录界面，没有程序能获得焦点 |
| `agent:unreadSessions` 被拒 1 次 | 启动后、daemon 的第一份快照到达之前，按设计以命名缺席拒绝；之后正常返回。验证步骤里写的「不应再出现」是我写错了 |

环境注记：`better-sqlite3` 按 Node 的 ABI 编译，DB 相关面板降级，这是已知的环境问题。所有界面操作都是通过 CDP 输入到一个不可见、未获焦点的窗口完成的。
