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

## 未做

- `agent:forkSession`、`conversation:fork`：daemon 还没有 Provider 分支（`supportsForkSession: () => false`），下一步做。
- 未在 macOS 与真实 App 中验证。
