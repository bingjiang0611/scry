# B4-L4 · 项目与工作区选择（daemon 模式）

上级状态见 [b4-l4](b4-l4.md)。本组 11 个通道全部迁移，没有留在拒绝状态的通道。

## 已迁移

| 通道 | 路由 | 说明 |
|---|---|---|
| `agent:setProjectPinned`、`agent:renameProject`、`agent:removeProject` | 本机 op `projectStore` | main 的同一份校验（绝对路径、名称 1–120 字符、置顶必须是 boolean） |
| `agent:removeRecentFolder` | split，`projectStore` | daemon 删除并回新的最近目录列表。最近目录是 daemon 的工作区授权输入，daemon 模式下 main 不写 |
| `workspaceSelection:read`、`validateBranch` | 本机 op `workspaceSelection`，只读 | daemon 用 main 的 `registerWorkspaceSelectionIpc` 注册到自己的 `SourceControlService` 上；repositoryId 只在读过它的那个 service 里有效，所以三个通道必须同在 daemon |
| `workspaceSelection:inspectStart` | 本机 op `workspaceSelection` | 标为写：核查时可能把核对结果写回操作日志，丢失回答后不重放 |
| `agent:chooseFolder` | split，`workspaceSelection` | 见下文 |
| `agent:invalidateProviderContext` | 本机 op `providerContext` | main 在 context 没有 cwd 时用窗口当前工作区。daemon 不知道窗口的选择，所以 App 先填好 cwd 再发 |
| `agent:addPiProfile` | split（原为 new-op），`piProfile` | 见下文 |
| `agent:removePiProfile` | 本机 op `piProfile` | 同 main：只接受 `pi:<16 位十六进制>`，删除后让 Pi 元数据失效 |

实现：

- 共用处理函数抽到 `src/main/bootstrap/project-channels.ts`（不依赖 Electron），main 的 `project-handlers.ts`、`app-agent.ts`、`provider-handlers.ts` 改为注册这些表，行为不变；daemon 端在 `src/daemon/local-ops/project.ts`。
- daemon 的依赖新增 `sourceControl` 与 `providerDiscovery`（`deps.ts`、`host-process.ts` 各一处）。Provider context 与 Pi profile 的变化同样让 daemon 给配对设备的 Provider 元数据失效并刷新，与 main 让自己的远程元数据失效相同。

## 选择框留在 App

App 端在 `src/main/bootstrap/project-daemon.ts`，用 `installDaemonChannelGuard` 与 `installDaemonChannelResultHandler`：

- **选择目录**：App 先弹原生目录选择框，取消时不问 daemon；daemon 收到的是选择框给出的路径，**渲染端传的参数一律丢弃**。否则被攻破的渲染端可以让任意目录被记成项目，也就是写进 daemon 的授权输入。daemon 校验真实目录（解析符号链接、必须存在且是目录），让会话历史加载失效，`rememberProject`，回答 canonical 目录。App 在 daemon 回答之后才选中这个目录（同 `agent:setCwd`，选中的是 daemon 的 canonical 路径而不是选择框的写法）；daemon 拒绝或回答格式不对时窗口选择不变。
- **添加 Pi**：App 先弹启动器文件选择框，把选择的路径和窗口工作区（没有时为 null，即 home）发给 daemon；渲染端参数同样丢弃。daemon 解析启动器、查版本、在该目录做 Pi RPC 握手、写入 profile。握手失败不抛错，回答 `{ status: 'failed', message }`，App 弹出与进程内相同的错误框后回答 null。
- **Pi 不涉及密钥**：profile 只有 id、显示名和启动器路径，存在 userData 的 `pi-agent-profiles.json`，没有用 `safeStorage`，所以没有明文凭据问题。

和进程内的差异：

- 握手目录：进程内用窗口当前工作区（选中时已校验）。daemon 收到的目录要再验一次，必须是 daemon 已知项目，否则按失败回答，不在这个目录启动启动器；
- `agent:removeRecentFolder` 现在拒绝非字符串参数（两种模式都是）。以前会把文件原样重写一遍。

## App 如何得知变化

- 渲染端在每次写之后自己重读项目列表与最近目录（`loadProjects`、`refreshRecent`，或直接用 `removeRecentFolder` 的返回值），读请求也走 daemon；
- App 进程内的 `agent:setCwd` 与 `workspace:*Known` 当时用 App 自己的 workspace runtime 判断已知项目；现已改为每次问 daemon，App 不再读这些文件，见 [b4-l4-known-projects](b4-l4-known-projects.md)；
- 窗口工作区：选择目录由结果处理函数在 App 里设置；
- 进程内的这些写都不发 `agent:dataUpdated`，daemon 也不发，没有新增事件。

## 测试（均先失败，再做对照）

- `src/daemon/host-process-project.test.ts`（真实 daemon，临时 userData 与工作区）：
  - 选择目录：符号链接记成 canonical 目录，App 的读取器随后认出它；相对路径、非字符串、文件都被拒绝，且不留下记录；
  - 置顶、改名、删除项目与最近目录，main 的校验原样生效；
  - 在临时 git 仓库上读 worktree 选择，用拿到的 repositoryId 校验分支、核查准备操作；不认识的 id 与未授权目录被拒绝；
  - Provider context 失效，未注册的 Provider 被拒绝；
  - Pi：用一个只会回答版本和四个目录读取的假启动器完成握手并写入；握手失败按 `failed` 回答且不写入；未知目录不握手；删除 profile。
- `src/main/bootstrap/project-daemon.test.ts`（App 端）：选择框取消时不发请求；渲染端参数被丢弃；daemon 回答后才选中、拒绝或格式不对时不选中；Pi 失败弹框并回 null；缺 cwd 时填窗口工作区；写通道都标为不可重放。
- `src/main/bootstrap/project-channels.test.ts`：共用处理函数的校验与顺序（先失效历史加载再记住；Provider 失效在 Provider 队列里、适配器失败也刷新元数据）。

首次运行：三个新测试文件全部失败（daemon 回答 `unknown_op`，两个模块不存在）。实现后真实 daemon 测试还有两条失败，原因在测试夹具：harness 只注册 Codex 的 smoke Provider，测试里写了 `claude`，Pi 也没有 descriptor。改为 `codex`，Pi 那条测试打开带 Pi 的 smoke 集合（`SCRY_ELECTRON_SMOKE_CONVERSATIONS=1`）后通过，生产代码没有为此改动。

对照实验：

- App 端选择目录的守卫改为沿用渲染端参数 → 「渲染端参数被丢弃」失败；不再填窗口 cwd → Provider context 那条失败；
- daemon 的握手目录不再校验 → 未知目录那条失败（假启动器在未授权目录里握手成功）；
- 共用函数改为记住选择框的原始路径 → 真实 daemon 与单元测试都失败；去掉最近目录的字符串校验 → 两处失败；
- 恢复后全部通过。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过；
- `npx vitest run src/daemon src/main scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts`：3280 passed / 2 failed / 3 skipped。两条失败都是已知的 root 环境原因（`db-outbox`、`desktop-directory-picker` 的「不可读目录」，root 下 chmod 不生效）；
- 矩阵文档已用 `node scripts/daemon-ipc-matrix.mjs --write` 重新生成（`agent:addPiProfile` 改判 split，四个 op 的请求、回答与鉴权说明按实现更新）；
- 改动的文件都不在 `performance-paths.json` 的 `sources` 里，没有跑 `performance:measure`；通道集合没有变化，`performance-feedback` 通过。

## 未做

- 已有的进程内行为：Pi 握手成功、写入 profile 之后如果 Pi Provider 未注册，会弹失败框，但 profile 已写入。两种模式相同，这次没有改；
- 未在 macOS 与真实 App 中验证。

## f2df3d0 本机 UI 验证

- 项目菜单的置顶、改名、移除都由 daemon 回答，并写入成功。
- 「移除后侧栏 1 秒内没刷新」：界面上的移除菜单调用后会自己 `refreshRecent()` 和 `loadProjects()`（`app-session-actions.ts`）。直接调用 preload API 时不会触发刷新，这是预期的，不是缺陷。
- 最近目录的增删要走原生目录选择器，本次没有验证。
- 不可用的面板显示「暂不可用」或「没有可用的接口」，没有显示成 0。
- 录制内容浏览需要 managed-recorder 轮次，smoke 不产生，归入真实 Provider 验收。daemon 侧的读取与目录校验已有真实 daemon 测试覆盖。
