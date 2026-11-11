# B4-L4 · 会话生命周期（daemon 模式）

## 已迁移

| 通道 | 路由 | 说明 |
|---|---|---|
| `agent:renameSession`、`agent:setSessionPinned`、`agent:setSessionArchived`、`agent:deleteSession` | 本机 op `sessionLifecycle` | 原计划转发到设备 op `sessionAction`/`sessionDelete`。设备 op 要求非空 cwd、要求工作区授权、只能删已存档会话，会改变 App 现在的行为，所以改为在 daemon 里跑 main 的同一份逻辑 |
| `agent:listArchivedSessions` | 本机 op `sessionStore` | 只读 |
| `agent:deleteArchivedSessions` | 本机 op `sessionPurge` | 见下文的确认与条数校验 |
| `conversation:delete` | 本机 op `conversation` | daemon 能删会话之后放开。渲染端预览并确认指纹；指纹不符时不清理任何东西 |

实现：

- 删除、改名、置顶、存档、批量删除的逻辑抽到 `session-lifecycle.ts`，不依赖 Electron。main 的 `session-deletion.ts` 只负责弹窗和注册通道；daemon 端在 `src/daemon/local-ops/session-lifecycle.ts`。
- 统一会话删除要删会话，会话删除又要查统一会话的删除计划。daemon 端两组之间用 `links` 互相引用，和 main 的 `index.ts` 做法相同。

## 确认框留在 App（B4 D2）

- 闸门新增 `installDaemonChannelGuard`：在请求发给 daemon 之前先在 App 里执行。用户选「取消」时，请求根本不会发出去。
- 单条删除：
  - App 先弹确认；自有测试 App 和进程内一样不弹；
  - 部分失败时，在拿到结果之后由 App 弹出失败提示。
- 批量删除已存档会话：
  - App 先读一次存档列表，按会话条数弹确认，再把这个条数带给 daemon；
  - daemon 发现条数对不上（用户确认之后存档集合变了）时一条都不删，返回新的原因码 `catalog_changed`，App 弹窗说明。
- 和进程内的差异：
  - 进程内先检查会话是否正在运行，再弹确认；daemon 模式下先弹确认，运行中的会话随后才在 daemon 那边以 `active_session` 拒绝；
  - 单条删除时，如果连读取会话目录都失败了，daemon 模式也会弹失败提示，进程内不弹。

## 顺带修复（两种模式都有）

已存档、但从没发过消息的统一会话草稿（没有任何 binding），删除时报 `Context admission requires at least one identity`。现在没有 binding 时不再去拿 Provider 上下文的准入；外层已经按会话 id 串行。

## 测试

- `host-process-session-lifecycle.test.ts`（真实 daemon）：
  - 改名、置顶、存档、列出、条数不符时不删除、批量删除、单条删除；
  - 事件流里能收到 `session_deleted`；
  - 草稿统一会话的预览与删除，指纹不符时拒绝。
- `session-lifecycle-daemon.test.ts`（App 端）：
  - 取消时不发请求；
  - 部分失败时弹提示；
  - 测试 App 不弹确认；
  - 批量删除带上条数；
  - `catalog_changed` 时弹提示。
- 对照实验：
  - 去掉条数校验 → 失败；
  - 去掉这一组 → 失败；
  - 去掉确认 → 失败；
  - 恢复旧的准入写法 → 草稿删除失败。

## 分支（第二轮）

| 通道 | 路由 | 说明 |
|---|---|---|
| `agent:forkSession` | 本机 op `sessionLifecycle` | 原计划转发到设备 op `sessionFork`。设备 op 要求非空 cwd；进程内没有 cwd 时用窗口当前工作区，所以改为本机 op |
| `conversation:fork` | 本机 op `conversation` | 统一会话按轮分支，走 daemon 的同一套分支逻辑 |

实现：

- daemon 按 main 的方式（`index.ts`）构建 `createForkOperations`。会话目录在启动时就需要分支函数，此时还没有它，所以按调用时解析。
- daemon 没有窗口选择。分支请求不带 cwd 时，App 在发送前补上窗口的 cwd；daemon 用 `resolveKnownProjectDirectory` 重新解析，未知目录拒绝。请求自带 cwd 时 App 不覆盖。窗口没有选择时，请求原样发出，与进程内一致（空 cwd 会话）。
- 配对设备通过 daemon 宿主仍拿不到分支：`supportsForkSession` 仍是 false，runtime 也没有加 `forkSessionWithAuthority`。要不要向设备开放，另行决定。

测试：

- 真实 daemon：
  - 未知目录被拒绝；
  - 没有归档边界时拒绝（`找不到可分支的已结束轮次`），Provider 没有被调用（以 smoke calls 文件为证）；
  - 统一会话分支走到 main 自己的请求校验。
- App 端：
  - 不带 cwd 时补上窗口的 cwd；
  - 自带 cwd 时不覆盖；
  - 窗口没有选择时原样发出。
- 对照实验：
  - 去掉补 cwd → 失败；
  - daemon 端分支改回不可用 → 失败。

## 未做

- 带真实归档轮次的完整分支，只能在 macOS 用真实 App 验证。
- 未在 macOS 与真实 App 中验证。
