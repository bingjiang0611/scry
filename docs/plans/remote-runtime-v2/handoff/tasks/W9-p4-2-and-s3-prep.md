# W9 · P4-2 实现（开关后）与 S3 准备

执行方 C。维护者 2026-11-20：开始准备 P4-2 与 S3。

## 为什么分两种做法

- **P4-2 可以直接写代码**：它只在 `SCRY_ORCHESTRATION=on` 时生效，默认值不变（`off`，P4-1 期间 `on` 被拒绝的逻辑改为在本任务里放开），共享分支上的其他执行方不受影响。
- **S3（删除进程内路径）这一轮只做准备、不删代码**：执行方 A 正在用本分支跑 W1，其中「`SCRY_HOST_DAEMON=0` 对照」等项依赖进程内路径；`main` 合入前的逃生开关也是它。真正的删除等 W1 通过、核验方补任务单后再做。

## 第一部分：P4-2（日志成为 run 与 turn 投递的权威）

依据：[P4-orchestration-plan](../../P4-orchestration-plan.md) §9 的 P4-2 行、§8（性能）、§10（测试）；[-core](../../P4-orchestration-core.md) §2.1–§2.10；[-data](../../P4-orchestration-data.md)；[-decisions](../../P4-orchestration-decisions.md)。按设计实现，不重新设计。

| 项 | 内容 |
|---|---|
| 命令 | submit、send、stop、answer、`resolveIntent` 改为命令；黏性与可重试拒绝；回执永久 |
| 派发 | intent 与领取同一事务、派发栅栏、派发前复核（realpath、工作区授权、operation gate、trust gate、提交者授权）、pending TTL ≤ 60 s、`stop_requested` 视为不活跃 |
| 恢复 | 已领取未派发记 `not_sent`；已派发无终态先查 recorder 证据，无证据记 `unavailable(host_restarted)`，不记失败；同一恢复事务关闭未答提问 |
| 两本账 | 按 core §2.8（决定 G）只合并 run 与轮次投递生命周期；启动时对账 |
| 旧台账镜像 | 提交后由可重放 effect 异步写出，不在首 token 路径上，写明不是严格回退保证 |
| P4-1 遗留必须关闭 | 大正文「先落盘再被事件引用」（data §4.7），含与 `deleteSession` 的协调；WAL 检查点移出提交关键路径；台账解析移到工作线程或分段让出（见 [W5-review-2](../reports/W5-review-2.md) 的 Linux 数据） |
| 门禁 | 把「首 token 前提交合计 P95 ≤ 8 ms（绝对值）」写进 `scripts/performance-budgets.json` 并有对应测量；不放宽任何已有门限 |
| fullfsync | H1 退出关键路径、检查点移出提交路径后，按 plan §8.3 规则两轮重测，结果作为「需要维护者决定」写进报告 |
| 多 Agent 预留 | core §2.10 R1–R12 只占位，不实现行为 |

验收：plan §10 的测试矩阵（幂等重放、提交与副作用之间崩溃、乱序、证据可追溯、projection 与重放一致、权限复核、取消与停止在 fence 时仍可用）；`SCRY_ORCHESTRATION=on` 下的 daemon 集成测试与 CI 矩阵加回 `on`；按 S1 流程重测首 token（同构建、paced fixture、计时锁、负载/核 > 0.5 作废）。`npm run check:cli-runtime` 证明没碰 scry CLI。

## 第二部分：S3 准备（不删代码）

依据：[P3-s1s3-plan](../../P3-s1s3-plan.md)（写于 S0 之前，已过时）、[P3-b4s-plan](../../P3-b4s-plan.md)。

1. 对照当前代码重写 S3 执行清单（可写成新文件 `P3-s3-plan.md`，旧文件顶部加一行指向）：main 现在还会加载哪些进程内运行模块、哪些 `child_process` 导入、哪些 IPC 通道仍有进程内实现、哪些测试和 smoke 依赖 `SCRY_HOST_DAEMON=0`、开发构建与 `SCRY_TEST_APP=1` 默认走进程内的处理、P4 的 `off` 模式与 S3 的先后（S3 须先于删除 `off`）。
2. 列出删除的提交顺序、每步的静态检查与验证、回退方式。
3. 只加不改行为的东西：可以先补「daemon 模式下必须成立」的测试和静态检查（如 main 不可达的模块清单），前提是不影响进程内路径的现有行为。
4. 「需要维护者决定」：开发构建与测试实例是否也改为默认 daemon；逃生开关 `SCRY_HOST_DAEMON=0` 在 S3 后是否保留一个版本。

## 约束

不碰 Antigravity 相关文件（执行方 B 在返修 W8）；`src/daemon/host-process.ts` 若要改，改动尽量小并先合并他人提交；不改 scry CLI、协议版本；测量遵守互斥规则。每完成一个单元就提交并推送；报告写 `reports/W9.md`（第一行写状态）。全部能做的做完、或只剩需要维护者决定的事项时停下总结。
