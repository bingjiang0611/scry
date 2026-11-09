# Batch 4 状态

分支 `claude/remote-runtime-v2`。任务书：[EXECUTION-BATCH4.md](EXECUTION-BATCH4.md)；起点 `66225f1`（Batch 3 收尾）。
工作约定、停止条件、提交与 STATUS 规则沿用 [EXECUTION.md](EXECUTION.md) 第 0、1 节。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B4-F1 renderer UI 门禁 | 完成 | `见 status` | [b4-f1](status/b4-f1.md)：失败原因是 fixture 控件条自身吞掉点击，非产品遮挡；`test:renderer:ui` 已全绿 |
| B4-F2 supervisor 余项 | 完成 | `见 status` | [b4-f2](status/b4-f2.md)：确定性启动失败改为 exit 4 且不重试；reason 接受 `remote_` 前缀，正文不落盘 |
| B4-F3 macOS 兜底收窄 | 完成 | `见 status` | [b4-f3](status/b4-f3.md)：按「身份格式能否比较」判定，可比较差异直接接管；旧格式仍拒绝 |
| B4-D 设计补全 | 完成（含 D1–D4 补审） | `见 status` | [b4-d](status/b4-d.md)：P3 §13 移到 [P3-batch4-design](P3-batch4-design.md)；矩阵 119 channel：main 24 / split 3 / forward 39 / new-op 53；D1 `scopes` 默认 `local`、D2 每条 forward 写明语义差异、D3 `chooseFolder`/`recentFolders` 改判 split、D4 secret 生命周期与重新入网 |
| B4-L1 本机入网与 `scope: local` | 完成 | `见 status` | [b4-l1](status/b4-l1.md)：grant 带 `scope`，local grant 只在 unix socket 传输有效；一次性 0600 secret 不按时间过期；首次入网/复用拒绝/撤销不重入均有测试 |
| B4-L2 main 侧 daemon 客户端与 supervisor | 完成 | `见 status` | [b4-l2](status/b4-l2.md)：`DaemonClient` 入网/探活/版本硬失败/撤销不重入、`ensureDaemon` 探活→接入→拉起→就绪；新 op `daemonInfo` 仅 local |
| B4-L3 run 经 daemon | 进行中（L3E 复审的 E1/E2 已修；等 daemon 侧分段计时后由维护者选 A/B/C） | `04a208fc` `298eff50` | [b4-l3](status/b4-l3.md)：语义层 + 接线层 + run controls + 执行归属；M1 只重放可证明未发送的请求，M2 分类表逐条判定，M3 真实 App 端到端全绿；S1 首 token P95 超出 +10 ms 预算（+78.4 ms），流式粒度已与进程内一致（20 事件/样本、间隔 152 ms）；同一 daemon 连续 30 次 start 的上限已修。首 token 的推送订阅提案等维护者选择（A/B/C）。撤销后重连入口按维护者答复放在 B4-S 设置页 |
| B4-L4 其余能力经 daemon | 未开始 | — | |
| B4-S 切换与删除 | 未开始 | — | |
| B4-V 验收 | 未开始 | — | |

## 执行顺序

1. **B4-F1 → F2 → F3**：每项先写失败测试、单独提交；每段通过门禁后更新本文件并推送。
2. **B4-D**：已完成，停在这里等维护者核验。
3. B4-L1 及之后不在本轮范围；未获核验前不开始。

## 阻塞

无。

## 已决定（维护者 2026-11-07，见 [REVIEW-BATCH4-D2](REVIEW-BATCH4-D2.md)）

| 决策 | 结论 | 落地 |
|---|---|---|
| 本机入网与 `scope: local` | 接受「同一 uid 的进程凭 `0600` secret 自证为本机设备」。secret + unix socket + 同 uid 就是证明，**不再有额外确认步骤**；无有效 local grant 期间 secret **不按时间过期**，只按「被使用」和「daemon 重启」轮换。撤销后走「重验 `daemon.lock` 身份 → SIGTERM → 重启生成新 secret → 重新入网」，不自动重入 | [§13.2](P3-batch4-design.md)、B4-L1 |
| 新 op 的远程开放 | 本批一个都不向远程开放；`scripts/daemon-ipc-remote-approvals.json` 保持空。要开具体 op 时再单独批准 | [§13.1](P3-batch4-design.md)、D1 |
| 按 grant scope 选策略 | 接受。除 `agent:start`、`agent:deleteSession` 外，扩到历史、列表、descriptors、detect：本机拿完整结果，远程拿裁剪投影。确认框仍留在 main | [§13.6](P3-batch4-design.md)、D2/G1 |
| 本机 grant 的空 cwd 会话 | 允许。`scope: local` 完全沿用当前 App 行为，包括空 cwd 会话；`scope: remote` 仍拒绝。方案 (a) 不采用：B4-S 删除进程内路径后该能力会永久消失 | 维护者 2026-11-07 答复第 3 条（[REVIEW-BATCH4-D2](REVIEW-BATCH4-D2.md)）、[REVIEW-BATCH4-L3A](REVIEW-BATCH4-L3A.md) P2；实现见 [b4-l3](status/b4-l3.md) |
| trace 推送与预算 | 接受 `watch` 长轮询 + `traceDelta`，P95 相对进程内 ≤ +10 ms（同机同负载、≥30 样本、同一 fake provider、串行测量并记录负载）；超预算再单独提 push op。**实测未达成**（30 样本：daemon 首 token P95 198.6 ms，进程内 120.2 ms；流式粒度已一致，20 事件/样本）。分段显示约 40 ms 是两次必要往返，其余落在首段文本的唤醒读取，因此按「超预算再单独提 push op」改为推送订阅提案 [P3e](P3e-first-token-push-proposal.md)，等维护者选择 | [§13.4](P3-batch4-design.md)、[b4-l3 §S1](status/b4-l3.md) |

G1（5 条差异补处理方式 + 守卫断言）与 G2（secret 生命周期改口径）已按评审修正，见提交 `5f4d050f` 与本节。

## 需要决定

无。
