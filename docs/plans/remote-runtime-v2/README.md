# Remote Runtime V2

远程延迟与运行架构改造。维护者 bob 于 2026-11-03 批准技术方案，采用 Orchestration V2 式路线。

| 文件 | 内容 | 谁写 |
|---|---|---|
| [PLAN.md](PLAN.md) | 已批准的技术方案：目标架构、不变量、组件、阶段、已定决策 | 核验方（Claude 评审线程） |
| [REVIEW.md](REVIEW.md) | 方案前的代码证据核对，执行时的事实基础 | 核验方 |
| [STATUS.md](STATUS.md)、[STATUS-BATCH2.md](STATUS-BATCH2.md)、[STATUS-BATCH3.md](STATUS-BATCH3.md) | 早期三批交付记录：提交、验证证据与限制 | 执行方 |
| [STATUS-BATCH4.md](STATUS-BATCH4.md) · [任务队列](handoff/QUEUE.md) | Batch 4 与后续任务、进度和核验门槛 | 执行方和核验方 |
| [P4-orchestration-design.md](P4-orchestration-design.md) 及 `P4-orchestration-*.md` | 编排事件日志设计稿（按 daemon 现状重写，取代 Batch 1 旧契约） | 设计方 |
| [P5-headless-host.md](P5-headless-host.md)、[P5-host-cli.md](P5-host-cli.md)、[P5-host-security.md](P5-host-security.md) | 无界面执行端设计稿：登录时启动、执行端命令行批准新设备、安全与拆分（维护者 2026-11-18 决定，同日评审后修订） | 设计方 |
| [P6-multi-agent-draft.md](P6-multi-agent-draft.md) 及 `P6-multi-agent-*.md` | 多 Agent 编排草案（未批准）：Scry 自有编排 MCP、委派子任务、权限上限、安全模型；依赖 P4 core §2.10 的预留 | 设计方 |
| [P7-antigravity-provider.md](P7-antigravity-provider.md) 及 `P7-antigravity-*.md` | Antigravity CLI（`agy`）Provider 设计稿（未实现）：ACP over stdio、沿用 CLI 已有登录、能力矩阵、集成点与安全、测试与拆分、待决定（维护者 2026-11-19 三项决定） | 设计方 |

## 历史任务书

Batch 1–3 的旧执行步骤已退出工作树，可从 Git 历史查阅：[Batch 1](https://github.com/bingjiang0611/scry/blob/77dd5a26135350a478e153a06f39f1464b3393f5/docs/plans/remote-runtime-v2/EXECUTION.md)、[Batch 2](https://github.com/bingjiang0611/scry/blob/77dd5a26135350a478e153a06f39f1464b3393f5/docs/plans/remote-runtime-v2/EXECUTION-BATCH2.md)、[Batch 3](https://github.com/bingjiang0611/scry/blob/77dd5a26135350a478e153a06f39f1464b3393f5/docs/plans/remote-runtime-v2/EXECUTION-BATCH3.md)。已核验的结论和未验证项仍在各批状态与评审中；旧分支和执行顺序不作为现行工作指令。
