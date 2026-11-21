# Remote Runtime V2

远程延迟与运行架构改造。维护者 bob 于 2026-11-03 批准技术方案，采用 Orchestration V2 式路线。

| 文件 | 内容 | 谁写 |
|---|---|---|
| [PLAN.md](PLAN.md) | 已批准的技术方案：目标架构、不变量、组件、阶段、已定决策 | 核验方（Claude 评审线程） |
| [REVIEW.md](REVIEW.md) | 方案前的代码证据核对，执行时的事实基础 | 核验方 |
| [EXECUTION.md](EXECUTION.md) | 执行 agent 的任务书（Batch 1） | 核验方 |
| [STATUS.md](STATUS.md) | 执行进度、证据、阻塞、需要决定的问题 | 执行 agent |
| [P4-orchestration-design.md](P4-orchestration-design.md) 及 `P4-orchestration-*.md` | 编排事件日志设计稿（按 daemon 现状重写，取代 P4-event-log-contract.md） | 设计方 |
| [P5-headless-host.md](P5-headless-host.md)、[P5-host-cli.md](P5-host-cli.md)、[P5-host-security.md](P5-host-security.md) | 无界面执行端设计稿：登录时启动、执行端命令行批准新设备、安全与拆分（维护者 2026-11-18 决定，同日评审后修订） | 设计方 |
| [P6-multi-agent-draft.md](P6-multi-agent-draft.md) 及 `P6-multi-agent-*.md` | 多 Agent 编排草案（未批准）：Scry 自有编排 MCP、委派子任务、权限上限、安全模型；依赖 P4 core §2.10 的预留 | 设计方 |
| [P7-antigravity-provider.md](P7-antigravity-provider.md) 及 `P7-antigravity-*.md` | Antigravity CLI（`agy`）Provider 设计稿（未实现）：ACP over stdio、沿用 CLI 已有登录、能力矩阵、集成点与安全、测试与拆分、待决定（维护者 2026-11-19 三项决定） | 设计方 |

## 协作方式

1. 分支固定为 `claude/remote-runtime-v2`，执行方和核验方都只往这里推。不开 PR、不合入 main。
2. 执行 agent 按 EXECUTION.md 一次性做完 Batch 1 的全部任务，自行验证，期间不需要等待核验方。
3. 遇到阻塞不停工：写进 STATUS.md 的「阻塞」，继续做其他独立任务。只有 EXECUTION.md「停止条件」列出的情况才停下，写进「需要决定」。
4. 全部完成后更新 STATUS.md 并 push，由 bob 通知核验方。核验方只看 STATUS.md、提交历史和 diff。
5. 核验结论写在 `REVIEW-BATCH1.md`；通过后再发 Batch 2（P3 daemon、P4 事件日志的代码实现）。
