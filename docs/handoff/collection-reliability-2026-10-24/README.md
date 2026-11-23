# 采集可靠性交接（2026-10-24）

这一轮从 [静态审查](review.md) 开始，处理 hook 漏采、恢复中断和投递证据缺失。审查本身没有复现或测量；实施和核验结果见各批报告。需要重做隔离验收时，参见 [USER-VERIFY.md](USER-VERIFY.md)。

| 批次 | 内容 | 报告 |
|---|---|---|
| A | 缺开始事件、hook 跳过留痕、开始和终态的持久化 | [A](reports/A.md) |
| B | inbox 失败隔离、恢复逐会话进行 | [B](reports/B.md) |
| C | 回退链路、长 socket 路径和子目录启动 | [C](reports/C.md) |
| D | 多仓库发现覆盖和每轮快照状态 | [D](reports/D.md) |
| E | 每轮投递环境、正文哈希、重试与死信 | [E](reports/E.md) · [uploader 侧审阅](reports/uploader-review.md) |

## 收尾验收与升级边界（历史）

- **真实 Provider 的验收范围**：2026-10-26 的 [F 批次](reports/F.md)中，OpenCode 实测落 12 条，Pi 限流的轮次仍落 1 条；[Codex 真机验收](reports/F-codex.md)在用户确认 hook trust 后验证了工作区根和普通子目录。Claude 本轮由用户决定不验收，Qoder 刷新凭据后未重跑，均不计通过。F-3 至 F-8 在隔离环境通过；其中通知字节校验、短暂故障后补投和 daemon 退出恢复，不代替真实外部 uploader 端到端或断电验收。
- **已知缺口**：从多仓库工作区的子仓库启动 Codex 时，项目 hook 搜索停在子仓库根，不会加载工作区根的配置。当时没有 record，也没有 skip log，doctor 仍可能显示健康。该轮明确不修；当时的规避方法是从工作区根启动。其他 Provider 的子仓库场景未验证。
- **升级边界**：改动已有 Provider hook 的批次需要在受影响 workspace 执行 `scry integrations repair --yes`；OpenCode idle 去重与 C3 的子目录修复属于此类，C3 还需重启 Provider。C1/C2、D2、E1 的相应旧安装需 repair 并重启 recorder daemon；纯 CLI 修复（例如 A2/V3 的诊断时间分级）升级 CLI 即生效。以 [A](reports/A.md)、[C](reports/C.md)、[D](reports/D.md)、[E](reports/E.md) 的分项说明和实际版本为准。
- **投递边界**：序号复用和投递空洞的修复、人工恢复步骤和未验证范围见[序号报告](reports/sequence-reuse.md)及[空洞报告](reports/delivery-holes.md)。未用本地 receiver 的 ACK 冒充真实 uploader 去重、服务端落地或断电验收。

[原状态表](https://github.com/bingjiang0611/scry/blob/3f4afcab2b2f756aa253b2e6c680d3d483bec55a/docs/handoff/collection-reliability-2026-10-24/STATUS.md)保留逐项核验、红测与提交记录，不作为当前版本验收。

旧分工与任务书可在 [Git 历史](https://github.com/bingjiang0611/scry/tree/ca74055d8f15358156db0d593d186de131caaa0f/docs/handoff/collection-reliability-2026-10-24)查看。
