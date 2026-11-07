# Batch 4 状态

分支 `claude/remote-runtime-v2`。任务书：[EXECUTION-BATCH4.md](EXECUTION-BATCH4.md)；起点 `66225f1`（Batch 3 收尾）。
工作约定、停止条件、提交与 STATUS 规则沿用 [EXECUTION.md](EXECUTION.md) 第 0、1 节。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B4-F1 renderer UI 门禁 | 完成 | `见 status` | [b4-f1](status/b4-f1.md)：失败原因是 fixture 控件条自身吞掉点击，非产品遮挡；`test:renderer:ui` 已全绿 |
| B4-F2 supervisor 余项 | 完成 | `见 status` | [b4-f2](status/b4-f2.md)：确定性启动失败改为 exit 4 且不重试；reason 接受 `remote_` 前缀，正文不落盘 |
| B4-F3 macOS 兜底收窄 | 完成 | `见 status` | [b4-f3](status/b4-f3.md)：按「身份格式能否比较」判定，可比较差异直接接管；旧格式仍拒绝 |
| B4-D 设计补全 | 完成（待核验） | `见 status` | [b4-d](status/b4-d.md)：P3 §13 矩阵（119 channel：main 27 / forward 39 / new-op 53，脚本生成 + 7 条守卫测试）、新增 op 清单、生命周期、trace 预算、badge 事件；P3b §8 进度表已细化 |
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

B4-D 已完成，以下两项等维护者核验后才能进 B4-L1：

1. **本机入网与 `scope: local`（P3 §13.2）**：daemon 首启写一次性 secret（`0600`），App 同 uid 读取后经 unix socket 完成 CSR/proof 换 `scope: local` grant；该 grant 只在 unix socket 上有效，可撤销，撤销后不自动重新入网。这会承认「同一 uid 的进程可自证为本机设备」。
2. **trace 推送方式与预算（P3 §13.4）**：先沿用 `watch` 长轮询 + `traceDelta`，main 保持 16 ms 合批与背压；预算为 P95 相对进程内不超过 +10 ms（同机同负载、样本 ≥30）。超预算再单独提 push 订阅 op，不默默加。