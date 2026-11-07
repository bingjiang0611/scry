# B4-L3 语义层：按 grant scope 选语义

分支 `claude/remote-runtime-v2`。本文件记录语义（scope）层的设计、测试与 P1 分类表；接线与验收见 [b4-l3-wiring](b4-l3-wiring.md)，总览见 [b4-l3](b4-l3.md)。

## 已完成：按 grant scope 选语义（daemon 侧）

决策依据一律是**已验证 grant 的 scope**，不读传输：

- `RemoteGateway.grantScope(peer)` 读 `authority.grantScope`，未知按 `remote`（失败时选更严的一侧）。
- `submitIntent` 把提交者的 scope 记到该 run 上；`runScope(runId)` 供执行器查询。内存记录是刻意的：重启后恢复的 intent 已经无法证明提交者，落回远程语义，不会因为「大概是本机」被放宽。
- `host-controller-execution` 把 `grantScope` 传给 `runProvider`；`remote-run-binding` 只在**非 local** 时套用 `SCRY_REMOTE_PERMISSION_MODE`，本机提交保留用户自己选的权限模式（含 `full_access`）。
- `runSessionDelete` 把 `grantScope` 传给实现；`sessionDeleteRequiresArchive(grantScope)` 决定是否只允许删除已存档会话。本机 grant 沿用 App 语义（main 已经弹过确认框），设备 grant 维持「只能删已存档」。

## 测试（`src/main/remote/scope-policy.test.ts`，4 条）

同一个 controller，两个真实 grant：

| 断言 | 内容 |
|---|---|
| submit 的 scope 传递 | 本机 grant 提交 → `startRun` 收到 `grantScope: 'local'`；设备 grant 提交 → `'remote'` |
| 未知证书 | `authority.grantScope` 返回 `undefined`，不会猜成本机 |
| sessionDelete | 两次调用分别收到 `'local'` 与 `'remote'`；`sessionDeleteRequiresArchive` 为 `false`/`true`，`undefined` 也按 `true` |
| 本机请求不被投影 | 本机提交的 `permissionMode: 'full_access'` 原样到达，cwd 保持规范化后的授权目录 |

## 提交时的结构调整

两个文件在改动前已超过 20 KB 门禁，按职责拆分而不是绕过：

- `remote-gateway.ts`（20.2 KB）→ 会话目录 face 移到 `remote-gateway-session-list.ts`，与其他 face 并列；快照 TTL 与上限常量随 face 一起走。
- `remote-run-binding.ts`（27.2 KB）→ 旧 Provider seam 移到 `remote-run-binding-legacy.ts`，规范路径（`startAppRun`）留在原文件。生产只用规范路径。

## P1 `isRemoteRun` 全量分类（14 文件 / 65 处 + 3 处上游检查）

**两个标志，各表达一件事**：

- `isRemoteRun`：这次 run 是「经台账 intent 提交的」——决定传输与台账行为（intent 回执、ledger、run output、daemon 侧回调）。本机与远程两种 scope 都保留。
- `appSemantics`（新增，= 已验证 grant 的 scope 为 `local`，in-process App 恒为 true）：决定**提交者语义**——本机必须走 App 原有路径。

判定来源都来自 `AppRunStartOptions`：`origin` 继续表示「经台账进来」，新增 `grantScope` 提供提交者身份；frontdoor 计算两个标志并向下传，不在下游重新推断。

### 进入管线之前的上游检查（也在提交者语义里）

本机提交在到达 frontdoor 之前先经过 routing → `RemoteRunPolicy`/`GatedExecutor` → `startAppRun`，这三处必须一起按 scope 分开，否则 P2 的空 cwd 根本到不了 frontdoor：

| 位置 | 现状 | 本机 scope 的目标 |
|---|---|---|
| `host-controller-routing.ts:71` | `routing.cwd` 不是字符串就抛 `invalid_target` | local 允许 cwd 缺失；remote 保持 `invalid_target` |
| `RemoteRunPolicy.authorize` → `workspace.authorize(cwd)`（`host-controller-factory.ts:159`） | 远程授权器，允许已知项目的子目录 | local 改用 App 的已知项目判定（`resolveKnownProjectDirectory`）；cwd 为空时不在这里拒绝，交给 frontdoor 按 `currentCwd` 处理。**授权不消失**：本机请求最终仍必须通过 frontdoor 的 App 规则。remote 不变；lease 仍在这一层获取（见 C1） |
| detail → `AgentStartRequest` 解析（D2 的「detail 字段更少」） | 远程只接受部分字段 | local 接受完整 `AgentStartRequest` 并复用 App 现有 schema 校验，不另写一套；remote 不变 |

### 运行管线内的分支

| 文件:行 | 现在的分支作用 | 分类 |
|---|---|---|
| `run-frontdoor.ts:63-68` | cwd 解析：远程 `resolveRemoteProjectDirectory`，本机 `resolveKnownProjectDirectory` / workspaceAdmission | 提交者语义 → `appSemantics`。**已切** |
| `run-frontdoor.ts:69-70` | workspaceAdmission 目录一致性 | 提交者语义 → `appSemantics`。**已切** |
| `run-frontdoor.ts:71-77` | 与 `currentCwd` 一致性检查（App 规则） | 提交者语义 → `appSemantics`（P2 空 cwd 也落在这里）。**已切** |
| `run-frontdoor.ts:108` | Provider 认证互斥 lease | **传输与台账**：经 `submit` 进来的每个 run（两种 scope）在进入管线前已由 `GatedExecutor` → `RemoteRunPolicy.authorize` 用同一个 `providerOperationKey` 取到并持有 lease（`remote-run-policy.ts:50-52`），frontdoor 不再重复获取。本机 scope 被上游 lease 拒绝时，把机器码映射成 App 原有文案（“当前 Provider 正在认证 MCP” + `nextAction`），不把 `provider_authenticating` 直接抛给 UI |
| `run-frontdoor.ts:122` | 返回标志给下游 | 传输与台账（两个标志都返回） |
| `run-diff.ts:44` | diff 预览需求通道（App 才有） | 提交者语义 → `appSemantics`。**已切**（`run-diff-scope.test.ts` 2 条） |
| `run-completion.ts:172,197,235` | `remoteRecordingFailed` 标记 | 提交者语义 → `appSemantics`（本机按 App 的录制失败展示） |
| `run-failure.ts:160,184,221` | 同上，失败路径的 `remoteRecordingFailed` | 提交者语义 → `appSemantics` |
| `run-admission.ts:59,64,70,71,72,108,134,138,214,220` | 准入与 resume：远程用显式 `expectedExternalSessionId` 且跳过「本会话已有待处理轮次」等本机检查 | 提交者语义 → `appSemantics` |
| `run-startup.ts:141` | 待答问题走远程 broker 还是本机 `userQuestionBroker` | 提交者语义 → `appSemantics` |
| `run-provider.ts:189` | 同上（provider 侧的提问路由） | 提交者语义 → `appSemantics` |
| `run-startup.ts:182,197` | 注册 run 时的 focus / 远程标记 | 提交者语义 → `appSemantics` |
| `run-startup.ts:209-210` | 本机才更新 dock badge 与当前会话视图 | 提交者语义 → `appSemantics` |
| `run-session.ts:48` | `onSession` 回调（远程注入） | 提交者语义 → `appSemantics` |
| `run-session.ts:50` | 会话 revision 一致性写入保护 | 提交者语义 → `appSemantics` |
| `run-live-state.ts:199` | `options.onTraceEvent` 订阅回调 | 传输与台账（daemon 需要它把 trace 推给 App） |
| `run-remote-state.ts:38,42` | 远程完成态/回执 | 传输与台账（回执）；其中 badge/通知部分按 `appSemantics` 抑制 |
| `run-execution.ts:352,360,385,399` | `remoteResult` / `remoteCompletion` 结算路径 | 传输与台账 |
| `run-execution.ts:110,133,164,178,235,272,294` | 把标志传给 diff/live/remote-state/startup | 传输与台账（透传两个标志） |
| `run-provider.ts:46,102` | 透传给 provider 侧 | 传输与台账 |
| `run-startup.ts:38,92` | 选项与透传 | 传输与台账 |
| `host-controller-run-controls.ts:25,51` | 「设备只能停自己的 run」归属检查 | 传输与台账（按 ledger 归属） |
| `host-controller-runs.ts:15` | `isRemoteRun(ledger, runId)` 定义 | 传输与台账 |
| `host-controller-surface.ts:254` | 注入 `isRemoteRun` 依赖 | 传输与台账 |

每类要有的对照测试（同一 controller、两种 scope）：

1. **提交者语义 / 工作区**：本机 grant 带 cwd → 走 `resolveKnownProjectDirectory` 且结果与 in-process App 一致；设备 grant 同一请求 → 仍走 `resolveRemoteProjectDirectory`。**已有**：`src/main/bootstrap/run-workspace-semantics.test.ts`（4 条，frontdoor 级；先失败后通过）。**仍缺**：从 `submit` 入口驱动的那一份，见 P2 一节。
2. **提交者语义 / diff 预览**：本机 grant 的 run 有 diff 预览通道，设备 grant 没有。
3. **提交者语义 / 提问路由**：本机 grant 的问题进本机 broker，设备 grant 进远程 broker。
4. **传输与台账**：两种 scope 都有 intent 回执、ledger 事件与 run output 页；本机 grant 的 `onTraceEvent` 仍被调用（daemon 靠它推送 trace）。

## M2：admission / completion / failure / session / startup 的逐行结论

核验指出这些行仍按 `isRemoteRun` 判断。逐行结论如下，**全部改判为「传输与台账」**，理由与替代保护写在一起。

| 行 | 现在的含义 | 结论与理由 | 替代保护与测试 |
|---|---|---|---|
| `run-admission.ts:59,64,70,71,72,108,134,138,214,220` | 用 `sessionByContext` / `sessionRevisionByContext` 判断「用户当前在看哪个会话」，并据此复位、比对、拒绝 | **改判**：这两张表是 App 窗口的当前会话镜像。daemon 没有「当前会话」，`daemon_mode_enabled` 下 App 也只是把会话身份显式发出去，所以在这里读 App 侧的镜像只会读到一个过期的值（切成 `appSemantics` 会让每个续接的 daemon run 都被 `expectedSessionMatches` 拒绝） | 替代保护是**显式身份**：`routingDetail` 把 `expectedExternalSessionId` 作为 `resume` 发出，daemon 用它做比对。测试：`run-admission-parallel.test.ts` 新增 2 条（daemon 提交、会话正在删除 → 拒绝；daemon 提交、同一原生会话已有 run → 拒绝），控制实验：把 `expectedExternalSessionId` 去掉后第二条立即失败 |
| 同上（`deletingSessions`、`runConflictsWithSession`→`waitForCompletedRuns`、`assertSessionNotArchived`） | 会话互斥与删除保护 | 这些检查**本来就不按 scope 分支**，daemon run 也走 | 同上两条测试从 daemon 提交路径证明了它们仍然生效 |
| `run-completion.ts:172,197,235`、`run-failure.ts:160,184,221`、`run-execution.ts:353,362,388` | 置 `remoteRecordingFailed` | **改判**：这个标记是**台账 run 把录制失败告诉 App 视图**的通道（`RemoteRunCompletion.recording: 'failed'` + `run.error`）。切成 `appSemantics` 会在 daemon 进程里置一个没有窗口渲染的本地标记，等于把失败藏起来 | 测试：`run-remote-state.test.ts`（3 条）——录制失败 → `recording: 'failed'` 且 `run.error` 可见；in-process run 没有 remote completion（对照）；没有标记时不会升级成 failed |
| `run-session.ts:48` | `onSession` 把原生 session 回给台账 | **传输与台账**：两种 scope 都有台账 run，都要回 | 现有台账/绑定测试覆盖（`remote-run-binding-*.test.ts` 断言 `onSession`/归档键） |
| `run-session.ts:50` | 用 revision 比较后更新 `sessionByContext` 镜像 | **改判**：写的是 App 窗口镜像；daemon 进程里这张表没有读者 | 同 admission：显式身份即保护；App 自己维护自己的镜像 |
| `run-startup.ts:183,198` | `remoteRunIds` / `remoteRunLedgerIds` 记账与失败回滚 | **传输与台账**：两种 scope 的 run 都有台账 id | 现有绑定/远程 run 测试覆盖 |
| `run-startup.ts:189` | 注册时 `focus: false` | **改判**：焦点是每个窗口的 UI 决定，daemon 不拥有窗口；App 在 daemon 模式下用 `runControl.adopt` / `focusRun` 决定 | `daemon-run-surface.test.ts`「adopts a live run and shows it afterwards」 |
| `run-startup.ts:210,211` | dock badge 与 `agent:focusedRun` 通知 | **改判**：这是 App 进程的 UI；daemon 模式下窗口由 daemon 视图驱动，badge/未读推迟到 L4（§13.5） | 见 [b4-l3](b4-l3.md)「开关打开时不可用」与 STATUS |

`run-startup.ts:142` 的 `requestUserInput` 分支保持不变：设备提问走 broker，本机 grant 的 run 在 daemon 里同样由绑定的 `requestUserInput` 承接，属于传输与台账。
