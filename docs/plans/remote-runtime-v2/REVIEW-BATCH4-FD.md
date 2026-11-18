# Batch 4 核验（B4-F1/F2/F3、B4-D）

核验对象：`66225f1..90a3c47`（4 个提交加任务书的 cherry-pick）。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：

- 读每个提交的 diff 与 status 文件；
- 对照 `app-agent.ts`、`workspace.ts`、`session-deletion.ts`、`workspace-runtime.ts`、`host-runtime.ts`、`provider-discovery.ts`，抽查矩阵里各分类的依据。

本轮**没有在本机重跑测试**，执行机 `/tmp` 下的日志我看不到。

## 结论

- B4-F 三项都接受。
- B4-D 的方法接受：矩阵由脚本生成，有守卫测试，反例也实测过。
- 但设计里有四处缺口，其中三处涉及授权或单写者，**必须在 B4-L1 之前补上**，补完后请维护者确认决策点。

## 接受

| 项 | 说明 |
|---|---|
| F1 | 原因已经定位到具体元素：fixture 自己的控件条宽度 1430 px 超出 1000 px 视口，横向滚动后，macOS 覆盖式滚动条接走了指针命中；产品弹层在栈里位于控件条之下，没有遮挡按钮。改的是 fixture 布局（换行，不再滚动），并加了一条自检，以后同类问题会报出真实原因，不再伪装成产品遮挡。命中检测、超时和断言都没动。修复前后的日志都在，完整 `test:renderer:ui` 通过 |
| F2 | `daemon_*` / `remote_*` 机器码统一映射为 exit 4，不重试，并写入 failure 记录；reason 提取已包含 `remote_` 前缀；正文不落盘 |
| F3 | 判断依据从“哪个平台”改为“身份格式能否比较”：Linux 精确 key 和 macOS UTC `lstart` 都算可比，可比且不一致就是 pid 复用；旧格式记录仍走 Scry command 兜底。Linux 上 R3 时期留下的 `lstart` 记录，读到的当前身份是 Linux key，两种格式不能比较，所以不会被误判为可比 |
| D 方法 | 119 个 channel 由扫描源码得出，守卫测试覆盖：未判定、已删除、op 不存在、method 漂移、性能路径缺失、文档漂移；解析器有自检。新增 op 按“一个授权边界一个 op”聚合，与 `desktopWorkbench` 一致 |
| D 其余 | 生命周期表、trace 预算（P95 相对进程内 ≤ +10 ms，≥30 样本）、badge 环形缓冲加 `partial`，方向都对 |

## 必须补（B4-D 范围内，只改文档、数据与守卫）

### D1 新增 op 没有写明调用方范围，多数默认对远程设备开放

17 个新 op 中，只有 `conversation`、`localPairing`、`localHostStatus` 写了 `scope: local`。其余 14 个（`piProfile`、`mcp`、`usage`、`billing`、`llmPerformance`、`projectStore`、`sessionStore`、`sessionPurge`、`runControl`、`workspaceSelection`、`recorderContent`、`turnEvidence`、`providerContext`、`skills`）的授权一栏只写了“已验证 peer + authorize(cwd)”。按这种写法，任何已配对的手机都能调用这些 op，例如编辑 Pi profile、同步 billing admin、批量清除会话、重认证 MCP。

这些都是远程设备目前没有的能力，属于授权扩大，按任务书停止条件必须先由维护者决定。

修法：

- `daemon-ipc-ops.json` 中每个 op 加结构化字段 `scopes`，默认值为 `["local"]`；
- 守卫测试要求每个 op 都有 `scopes`；
- 任何包含 `remote` 的 op，必须同时出现在一份“维护者已批准远程开放”的清单里，否则测试失败。

本批建议不向远程开放任何新 op。

### D2 “转发到现有 op”默认语义等价，至少两处不成立

远程 op 带有远程专属策略，本机 App 的语义与之不同：

- **`agent:start` → `submit`**：
  - `submit` 走远程策略：`SCRY_REMOTE_PERMISSION_MODE` 覆盖（`host-runtime.ts:51,62`、`provider-discovery.ts`），工作区授权走 `resolveRemoteProjectDirectory`；
  - 本机 `agent:start` 使用用户选择的权限模式（含 `full_access` 的 Provider-specific 语义），允许不绑定项目的空 cwd 会话，`AgentStartRequest` 字段也比远程 detail 多；
  - 直接转发，要么本机能力缩水，要么远程覆盖策略作用到本机。
- **`agent:deleteSession` → `sessionDelete`**：
  - 本机删除走 `confirm: !isOwnedTestApp`，即原生确认框，可以删除未归档的会话（`session-deletion.ts:223`）；
  - 远程 `sessionDelete` 只允许删除已归档会话，且 `confirm: false`（`host-runtime.ts` 的 `authorizeArchived`）。

修法：

- 矩阵中每一条 `forward` 行都加一列“语义差异”，填“等价”或写明具体差异及处理方式。
- 对存在差异的 op，在 daemon 内**按 grant scope 选择策略**：`scope: local` 完全沿用当前 App 语义，远程设备保持不变。这同样属于授权语义，列入维护者决策（建议如上）。
- 需要原生确认框的操作，确认框留在 main，确认后再转发。daemon 只对 `scope: local` 接受“已确认”的请求。
- L3 时补本机与远程的语义对照测试。
- 其余 `forward` 行（`loadSession` → `historyTurnsPage`、`listSessions` → `sessionsPage`、`forkSession`、`workspace:*` 等）也要逐条填写差异列，例如分页上限，以及远程历史投影是否裁掉了本机可见的字段。

### D3 工作区授权的写入被留在 main，“分开存储”的说法不对

daemon 判定工作区授权依据的是 `knownProjectDirectories = recentStore ∪ projectStore`（`workspace-runtime.ts:24-31`）。而矩阵把以下 channel 判为留在 main：

- `agent:chooseFolder`：会调用 `rememberProject(dir)` 和 `setCurrentCwd`（`app-agent.ts:156-163`）；
- `agent:recentFolders` / `agent:removeRecentFolder`：读写 `recentStore`。

理由写的是“窗口侧最近列表，与 daemon 的目录投影分开存储”。事实是同一个文件，它就是 daemon 的授权输入。这意味着开关打开后，main 仍会写 daemon 的授权数据，违反单写者原则；同时也违反 2026-10-15 的规则，即“明确选择后由宿主校验真实目录并通过同一项目 authority 持久化”。

修法：

- 把这几个 channel 判为 `split`：原生选择框留在 main，选中后的持久化、最近列表的读取和删除、当前 cwd 都通过 daemon op（可以并入 `projectStore` / `workspaceSelection`）完成，由 daemon 校验 canonical 目录；
- 矩阵增加 `split` 类别，守卫测试要求 `split` 行同时写明 main 侧做什么、daemon op 是哪个。
- `workspace:readKnown` / `readPageKnown` / `resolveFile` / `openKnownExternal` 留在 main 可以，但要写明它们需要的“已知项目”集合从 daemon 获取（带 revision 的快照），main 不能自己打开这两个 store。
- B4-S 的静态检查要加上：`src/main` 中不得出现 `recentStore` / `projectStore` 的写入方法。

### D4 本机入网缺少“撤销后如何重新入网”和 secret 的生命周期

§13.2 写了“撤销后不自动重新入网”，但没写用户怎样重新入网：App 撤销后已经没有 grant，无法再调用 daemon 的任何 op，包括 shutdown。

需要写清楚：

- daemon 在什么条件下生成新 secret。建议：启动时，若不存在有效的 local grant，就生成新 secret；已有有效 grant 时不生成。
- 用户如何触发重新入网。建议：App 提供“重新连接本机后台服务”。由于 App 无法经协议停止 daemon，只能按 `daemon.lock` 登记的进程身份重验后发送 SIGTERM，这符合 CLAUDE.md“只停止登记且重验 identity 的进程”；daemon 重启后生成新 secret，App 再入网。运行中的 run 按 shutdown 语义处理，界面要二次确认。
- 已有一个 local grant 时，第二个 App 实例或第二台“本机”能否入网。建议：每份 userData 只保留一个有效的 local grant，新入网会作废旧 grant。
- secret 文件被删除或损坏时，fail closed，显示可操作的错误。

## 需要维护者确认（D1–D4 补完后由执行方汇总到 STATUS「需要决定」）

1. **§13.2 本机入网**：同一 uid 的进程凭 `0600` secret 自证为本机设备。核验方认为，按现有信任模型（同 uid 的并发攻击者不在保证范围内）可以接受，前提是补齐 D4。
2. **新 op 的远程开放**：建议本批一个都不开放（D1）。
3. **按 scope 选择策略**：`scope: local` 完全沿用当前 App 的权限模式、空 cwd 会话和删除语义；远程设备不变（D2）。
4. **§13.4 trace 预算**：P95 相对进程内 ≤ +10 ms。核验方认为合理，测量要用同一个 fake provider，同机串行，并标明负载。

## 下一步

1. 补 D1–D4：修改 `daemon-ipc-ops.json` / `daemon-ipc-routing.json`、守卫测试、生成文档和 §13。每项先写一条在当前数据上会失败的守卫断言，例如“`scopes` 缺失”“`split` 行缺少 daemon op”。
2. 门禁：`daemon-ipc-matrix.test.ts`、`performance-feedback.test.ts`、生成器 `--check`、typecheck、`git diff --check`。
3. 把上面四个决策点写进 `STATUS-BATCH4.md` 的「需要决定」，推送后停下，等维护者确认后再开始 B4-L1。
