# Batch 4 核验（B4-D 补全：D1–D4）

核验对象：`c52133d`。提交身份为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

方法：读 diff、守卫测试和三份数据文件，再对照 [REVIEW-BATCH4-FD](REVIEW-BATCH4-FD.md) 的要求逐项检查。本轮没有在本机重跑测试。

## 结论

D1–D4 都已补齐，可以接受。另有两处小缺口，只涉及文档和数据，可以在 B4-L1 开工时顺手修，不需要再停一轮。四个决策点已经写进 `STATUS-BATCH4.md` 的「需要决定」，等维护者确认。

| 项 | 核验 |
|---|---|
| D1 | 17 个新 op 全部声明了 `scopes: ["local"]`，`daemon-ipc-remote-approvals.json` 为空。守卫测试规定：缺少 `scopes`、或含 `remote` 却不在批准清单里，都会失败 |
| D2 | 39 条 `forward` 都填了「语义差异」：29 条等价，10 条有差异。`agent:start` 和 `agent:deleteSession` 写明了按 grant scope 选策略，确认框留在 main。守卫测试要求每一条都有记录 |
| D3 | `chooseFolder`、`recentFolders`、`removeRecentFolder` 改判为 `split`：main 留选择框，持久化交给 daemon op。四个 `workspace:*Known` 的已知项目集合标为 `daemon:` 来源。守卫测试覆盖这两点 |
| D4 | §13.2 补上了 secret 生命周期、重新入网（按 `daemon.lock` 重验身份后 SIGTERM，daemon 重启后生成新 secret）和单实例规则，守卫测试检查这三节存在 |

## 小缺口（B4-L1 开工时修）

**G1 有 5 条「不同」只写了差异，没写处理方式。** 涉及 `agent:loadSession`、`agent:loadSessionOlder`、`agent:listSessions`、`agent:providerDescriptors`、`agent:detect`。

前三条最要紧：远程历史投影会裁掉工具原文和文件足迹，分页也更小、不含归档会话。如果直接转发，本机 App 会丢失证据（CLAUDE.md 第 1 条）。

修法：

- 这 5 条都写明「按 grant scope 选投影/上限/detail」，`scope: local` 沿用当前 App 的完整结果；
- 守卫测试加一条：凡以「不同」开头的差异，必须写明处理方式（例如出现 `scope` 或新 op 名），否则失败。

**G2 §13.2 有两处说法需要澄清。**

1. **「本机确认」由谁完成，没有写清楚。** 文中说“secret 只能走到『等待本机确认』那一步，grant 仍由 pairing 状态机签发”。但本机入网时，能做确认的只有 App 自己，而 App 还没有 grant，它无法调用 `localPairing:confirm`。需要明确二选一：
   - (a) secret 加上 unix socket 加上同一 uid 本身就是证明，daemon 直接签发 `scope: local` grant，没有额外确认；
   - (b) 首次入网时，App 弹出一次用户确认，确认结果随 proof 一起提交。

   建议 (a)，并把“拿到 secret 只能走到等待确认”这句改掉，免得读者以为还有第二道关。
2. **secret 过期的处理会把用户逼进重启流程。** 文中让 secret 沿用 pairing 的过期窗口，过期后“要求重新入网”。可是 daemon 可能由模板在登录时拉起，而用户几小时后才打开 App。这时 secret 已过期，只能走 SIGTERM 加重启的流程。

   建议：在不存在有效 local grant 时，secret 不按时间过期，只在被使用、或 daemon 下次启动时轮换。或者在过期时由 daemon 自行生成新 secret，不要求重启。

## 维护者决策点（核验方建议）

1. **本机入网**：接受，按 G2 的 (a) 方案，secret 在无 grant 时不过期。
2. **新 op 的远程开放**：本批一个都不开放。
3. **按 scope 选策略**：接受，并按 G1 扩展到历史、会话列表、descriptors 和 detect，`scope: local` 完全沿用当前 App 的结果。
4. **trace 预算**：接受，P95 相对进程内不超过 +10 ms，同一 fake provider、同机串行、≥30 样本、记录负载。

## 维护者答复（2026-11-07）

四项都按核验方的建议确认：

| 决策点 | 答复 |
|---|---|
| 1 本机入网 | 接受方案 (a)：secret 加上 unix socket 加上同一 uid 即为证明，daemon 直接签发仅限 unix socket 的 `scope: local` grant，没有额外的确认步骤；不存在有效 grant 时，secret 不按时间过期，只在被使用或 daemon 重启时轮换 |
| 2 新 op 的远程开放 | 本批一个都不开放；`daemon-ipc-remote-approvals.json` 保持为空 |
| 3 按 scope 选策略 | 接受。`scope: local` 完全沿用当前 App 的行为，包括用户选择的权限模式（含 `full_access`）、空 cwd 会话、经确认框可删除未归档会话、完整的历史证据、完整的 descriptors 与 detect 结果；远程设备保持现状 |
| 4 trace 预算 | 接受：P95 相对进程内不超过 +10 ms，使用同一个 fake provider，同机串行测量，样本 ≥30，记录机器负载；超出预算时，再单独提出 push 订阅 |

B4-L1 开工前，先按 G1、G2 和上面的答复更新 §13.2、差异数据与守卫测试，并把 `STATUS-BATCH4.md` 的「需要决定」改为「已决定」。
