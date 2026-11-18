# Batch 4 核验（B4-L3 分类表）

核验对象：`af44fad..2e1c0fc`，其中 `8ee28ce` 是我的核验 cherry-pick。这几次提交都是纯文档改动，提交身份正确。

方法：对照 `status/b4-l3.md` 的分类表，逐行检查对应源码，并检查进入运行管线**之前**的 daemon 处理路径（routing → `RemoteRunPolicy` / `GatedExecutor` → `startAppRun`）。

## 结论

分类表可以接受：两个标志的拆法对，65 处分支的大部分归类也对。下一段写代码之前，需要先做两处更正，再删掉一句过期的说法。

## 更正

### C1 `run-frontdoor.ts:108` 的认证 lease 应归为“传输与台账”

表里把它列为提交者语义，理由是“App 获取 lease，远程跳过”。但远程之所以跳过，是因为经 `submit` 进来的**每一个** run（无论 scope）在进入管线之前，已经由 `GatedExecutor` → `RemoteRunPolicy.authorize` 拿到了同一个 `providerOperationKey` 的 lease（`remote-run-policy.ts:50-52`），并在 run 结束时释放。

如果把这一行切到 `appSemantics`，本机 run 就会第二次 acquire 同一个 lease：轻则重复记账，重则被自己挡住，报 `provider_authenticating`。

修法：

- 这一行改为“传输与台账：lease 已在上游获取，两种 scope 都不在 frontdoor 重复获取”。
- 本机 scope 被 lease 拒绝时，错误展示要与 App 一致：映射成 App 原有的“当前 Provider 正在认证 MCP”提示与 `nextAction`，不能直接把 `provider_authenticating` 机器码抛给 UI。
- 测试：认证进行期间，本机 grant 提交得到 App 语义的拒绝；远程 grant 提交得到现状的 `provider_authenticating`。

### C2 分类表漏了进入管线之前的三处上游检查，P2 在这里会被先挡住

表格只覆盖了运行管线。但本机提交在到达 `run-frontdoor` 之前，还要依次经过：

| 位置 | 现状 | 对本机 scope 的影响 |
|---|---|---|
| `host-controller-routing.ts:71` | `routing.cwd` 不是字符串就抛 `invalid_target` | 空 cwd 的本机请求在这里就被拒，到不了 frontdoor |
| `RemoteRunPolicy.authorize` → `workspace.authorize(cwd)`（`host-controller-factory.ts:159`） | 用远程授权器（允许已知项目的子目录） | 空 cwd 会被拒；带 cwd 时比 App 规则更宽，App 只认已知项目本身，外加 `currentCwd` 一致性检查 |
| detail → `AgentStartRequest` 的解析（D2 已指出“detail 字段更少”） | 远程只接受一部分字段 | App 的附件、run controls、side chat 等字段可能在这里丢失 |

修法：把这三处加进分类表，都归为提交者语义，按 grant scope 分开处理。

- **routing**：`scope: local` 允许 cwd 缺失；`scope: remote` 保持 `invalid_target`。
- **policy**：`scope: local` 改用 App 的已知项目判定（`resolveKnownProjectDirectory`）；cwd 为空时，交给 frontdoor 按 `currentCwd` 处理。**授权不能因此消失**：本机请求最终仍必须通过 frontdoor 的 App 规则。`scope: remote` 不变。lease 仍在这一层获取（见 C1）。
- **detail 解析**：`scope: local` 接受完整的 `AgentStartRequest`，并用现有的 App 侧 schema 校验，不另写一套；`scope: remote` 不变。

P2 的三条测试，要从 `submit` 入口开始驱动，不能直接调用 frontdoor。这样才能证明空 cwd 的本机请求确实穿过了 routing 和 policy 两层。另外加一条：本机 grant 带一个“已知项目的子目录”作为 cwd，按 App 规则应该被拒；远程 grant 带同样的 cwd，按现状被接受。

## 过期的说法

`status/b4-l3.md` 的「未验证」一节里还写着空 cwd“要等 App 侧接线时一起决定”。它和 P2 的“已决定”矛盾，请删掉，改成“已决定，未实现”。

## 下一段

1. 更新分类表（C1、C2），删掉过期的说法。
2. 按原定落地顺序走：先加 `grantScope`，由上游的 routing / policy 和 frontdoor 计算两个标志；先写对照测试，确认它们失败，再切换分支。
3. `run-execution.ts` 接近 20 KB，如果超限，按职责拆分。

L3 全部完成后停下等核验。
