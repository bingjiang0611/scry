# Batch 3 状态

分支 `claude/remote-runtime-v2`。任务书：[EXECUTION-BATCH3.md](EXECUTION-BATCH3.md)；核验结论：[REVIEW-BATCH2.md](REVIEW-BATCH2.md)。
起点 `577995b`。

## 总览

| 任务 | 状态 | 提交 | 说明 |
|---|---|---|---|
| B3-F1 trace 尾沿补读 | **未开始** | — | 见「未开始」原因 |
| B3-F2 Mac run 绑定发信号 | 完成 | `见下` | [b3-f2](status/b3-f2.md) |
| B3-D 设计稿三处更正 | **未开始** | — | |
| B3-M1 存储注入化 | **未开始** | — | |
| B3-M2 运行管线去 Electron 化 | **未开始** | — | |
| B3-P1 daemon 承载宿主 | **未开始** | — | |
| B3-V1 security smoke 归属 | **未开始** | — | |
| 交付前全局验证 | **未执行** | — | |

## 未开始的原因（如实记录）

本批剩余任务的规模与依赖关系要求连续多轮改代码并反复跑全量门禁（B3-M2 一项就要改 `run-*.ts`、`trace-runtime.ts`、`conversation.ts`、`app-agent.ts`、`agent-runner.ts`、`source-control`、`desktop-workbench` 的 6 类 Electron 依赖注入，且必须保持行为不变；B3-P1 依赖 M1、M2 完成）。本次会话的上下文预算在 F2 之后不足以完成任何一个后续任务并留下可验证的证据，因此没有开工，而不是先写一半再放弃。

下一步的执行顺序（不得跳序）：

1. **B3-V1** —— 与其他任务无依赖，可先做，用临时 worktree 在 `a0b2355` 与 `aada148` 复跑 security smoke，确定失败归属。
2. **B3-F1** —— 独立于 M1/M2；修 S1 的尾沿与跟随 run 的内容读取。
3. **B3-D** —— 纯文档，按 REVIEW-BATCH2 三处更正改 `P3b-local-runtime-design.md`。
4. **B3-M1** → **B3-M2** → **B3-P1** —— 严格串行。
5. 交付前全局验证 + `npm run test:renderer:ui`。

## 阻塞

无。

## 需要决定

无。
