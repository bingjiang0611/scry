# Batch 4 核验（S1、B4-L3 第一段）

核验对象：`1bca3d4..af44fad`，其中 `92d3d62` 是我的核验 cherry-pick。提交身份全部是 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：读 diff、`status/b4-l3.md`，并对照 `run-frontdoor.ts` 和运行管线中所有 `isRemoteRun` 分支。本轮没有在本机重跑测试。

## 结论

S1 和“按 grant scope 选语义”的第一段都接受，在这里停下是合理的。

但 L3 的核心还没有覆盖到：本机提交进入 daemon 以后，仍然走遍运行管线里所有“远程 run”分支，scope 目前只改了其中两种语义。

另外，空 cwd 那一条**维护者已经决定过**，不需要重新提问。

## 接受

| 项 | 说明 |
|---|---|
| S1 | `authorizesCertificate` 改为对称规则：`local` 传输只接受 `scope: local`，`network` 传输只接受 `scope: remote`；省略 transport 的调用属于可信的内部调用，行为保持不变。`grantScope` 是唯一的判定来源，证书未知时返回 `undefined`。增加了“远程 grant 出示在 local.sock 上被拒”的测试 |
| scope 传递 | `submitIntent` 记录提交者的 scope，执行器用 `runScope` 查询；网关读不到时按 `remote` 处理，也就是取更严格的一侧。重启后恢复的 intent 也按远程处理，而这些 run 本来就会以 `host_restarted` 失败，所以不会被放宽 |
| 两处语义 | `SCRY_REMOTE_PERMISSION_MODE` 只对非 local 生效；`sessionDeleteRequiresArchive` 在 scope 为 local 时返回 false，`undefined` 和 `remote` 都返回 true。用同一个 controller 和两个真实 grant 做了对照测试 |
| 拆分 | `remote-gateway.ts` 与 `remote-run-binding.ts` 按职责拆分，没有绕过 20 KB 门禁 |
| Linux 凭据 | 已确认 `unsafeCredentialStorageReason` 判定存在（`basic_text` 一律拒绝）。L3 接线时必须复用它 |

## L3 必须补

### P1 本机提交仍按“远程 run”跑完整条管线

经 `submit` 进来的本机 run，在管线里依然是 `isRemoteRun = true`。这个标志分布在 14 个文件中，约 65 处（`run-admission` 11、`run-execution` 11、`run-startup` 8、`run-frontdoor` 6、`run-completion` 5、`run-failure` 4，另有 `run-diff`、`run-live-state`、`run-provider`、`run-session`、`run-remote-state`，以及 `host-controller-*` 三个文件）。

目前 scope 只影响权限模式覆盖和删除限制。其余这些分支决定的东西包括：

- 工作区怎么解析：`run-frontdoor.ts:62-77`。远程用 `resolveRemoteProjectDirectory`，本机用 `resolveKnownProjectDirectory` 加 `currentCwd` 一致性检查；
- diff 预览的需求通道：`run-diff.ts:44`，远程 run 没有这个通道；
- 录制失败怎么处理：`run-completion.ts:172,197,235`；
- 准入、启动、失败处理、会话绑定等。

这些分支不改，开关打开后本机 App 会在这些地方静默地变成“远程语义”，违反“本机不缩水”的决定。

修法：

1. 在 `status/b4-l3.md` 中列一张表，逐处写出每个 `isRemoteRun` 分支属于哪一类：
   - **提交者语义**：本机应当走 App 原有路径，例如工作区解析、diff 预览、录制失败展示、权限模式；
   - **传输与台账**：两边都保留，例如 intent 回执、ledger、run output。
2. 把提交者语义改由 grant scope 决定。一种可行的做法是拆成两个标志：`isRemoteRun` 只表示经台账提交，另加一个 `appSemantics = grantScope === 'local'`。不要用一个布尔值同时表示两件事。
3. 每类至少写一条对照测试，用同一个 controller、两种 scope，断言本机行为与当前 in-process App 一致，远程行为与现状一致。

### P2 空 cwd：已经决定，按方案 (b) 实现

2026-11-07 维护者答复第 3 条（[REVIEW-BATCH4-D2](REVIEW-BATCH4-D2.md)）已经明确：`scope: local` 完全沿用当前 App 的行为，**包括空 cwd 会话**。方案 (a) 会让 B4-S 删除进程内路径之后，这项现有能力永久消失，与这条决定冲突，所以不采用。

做法：空 cwd 会随着 P1 的工作区解析分支一起落地。

- `scope: local` 走 App 的 frontdoor 语义：请求没带 cwd 时，使用 daemon 持有的 `currentCwd`（由 `workspaceSelection` op 维护）；带了 cwd 时，走 `resolveKnownProjectDirectory`，并检查与 `currentCwd` 一致。
- `scope: remote` 不变，空 cwd 仍然被拒。

测试：

- 远程空 cwd 被拒，报错与现状相同；
- 本机空 cwd 与 in-process App 行为一致；
- 本机带了 cwd、但与 `currentCwd` 不一致时被拒。

App 接线之前，UI 不需要也不应该假装支持。

`STATUS-BATCH4.md` 中这一条请从「需要决定」移到「已决定」，并引用上述答复。

## 其余 L3 待办（`status/b4-l3.md` 已经列出，我同意）

App 侧开关以及“App 进程内不得构造运行管线”的断言、`workbenchOps` 的 UI 接入、`DaemonClient` 复用 `unsafeCredentialStorageReason`、真实的 `launch()`、撤销后重新连接、trace 预算的 L2 计时。

## 下一步

先做 P1：先写分类表，再写对照测试；P2 跟随 P1 一起完成。然后做 App 侧接线和其余待办。L3 全部完成后停下等核验。
