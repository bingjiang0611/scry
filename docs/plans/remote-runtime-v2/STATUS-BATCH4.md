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
| B4-L1 本机入网与 `scope: local` | 未开始 | — | B4-D 核验通过后才开始 |
| B4-L2 main 侧 daemon 客户端与 supervisor | 未开始 | — | |
| B4-L3 run 经 daemon | 未开始 | — | |
| B4-L4 其余能力经 daemon | 未开始 | — | |
| B4-S 切换与删除 | 未开始 | — | |
| B4-V 验收 | 未开始 | — | |

## 执行顺序

1. **B4-F1 → F2 → F3**：每项先写失败测试、单独提交；每段通过门禁后更新本文件并推送。
2. **B4-D**：已完成，停在这里等维护者核验。
3. B4-L1 及之后不在本轮范围；未获核验前不开始。

## 阻塞

无。

## 需要决定

B4-D 的 D1–D4 已按 [REVIEW-BATCH4-FD](REVIEW-BATCH4-FD.md) 补完，以下四个决策点等维护者确认后才能开始 B4-L1。

1. **本机入网与 `scope: local`（[§13.2](P3-batch4-design.md)）**：daemon 在无有效 local grant 时生成一次性 secret（`0600`），App 同 uid 读取后经 unix socket 完成 CSR/proof 换 grant；grant 只对 unix socket 有效，可撤销，撤销后不自动重新入网。核验方认为按现有信任模型（同 uid 并发攻击者不在保证范围）可以接受，前提是补齐 D4 的 secret 生命周期、重新入网与单实例规则——已补齐。
   - 需要确认：是否接受「同一 uid 的进程凭 `0600` secret 自证为本机设备」；撤销后的重新入网走「重验 `daemon.lock` 身份 → SIGTERM → daemon 重启生成新 secret → 重新入网」是否可以。
2. **新 op 的远程开放（[§13.1](P3-batch4-design.md)、D1）**：17 个新 op 全部 `scopes: ["local"]`，`scripts/daemon-ipc-remote-approvals.json` 为空。任何含 `remote` 却没进批准清单的 op 会让守卫测试失败。
   - 需要确认：本批一个都不向远程开放。要开哪个，请指出 op 名，我再改清单。
3. **按 grant scope 选择策略（[§13.6](P3-batch4-design.md)、D2）**：`agent:start` → `submit` 与 `agent:deleteSession` → `sessionDelete` 与远程语义不等价。方案是 daemon 内按 grant scope 选策略：`scope: local` 完全沿用当前 App 语义（用户权限模式含 `full_access`、允许空 cwd 会话、原生确认框可删未归档），远程设备维持现状（`SCRY_REMOTE_PERMISSION_MODE`、只删已归档、`confirm: false`）。需要确认框的操作确认框留在 main，daemon 只对 `scope: local` 接受已确认的请求。
   - 需要确认：这个「按 scope 分策略」的授权语义。
4. **trace 推送方式与预算（[§13.4](P3-batch4-design.md)）**：先沿用 `watch` 长轮询 + `traceDelta`，main 保持 16 ms 合批与背压；预算为 P95 相对进程内不超过 +10 ms（同机同负载、样本 ≥30、两侧同一 fake provider、串行测量并记录负载）。超预算再单独提 push 订阅 op，不默默加。
   - 需要确认：预算数值与测量条件。
