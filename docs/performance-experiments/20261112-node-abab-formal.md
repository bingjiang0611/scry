# Formal Node ABAB performance-check migration

状态：已获批准的正式门禁迁移设计。本文不记录新的计时结果，也不替代 CI artifact。

## 合同

正式 Performance Check 保留原有 pull request / workflow_dispatch 触发、`Performance Check` 汇总、Node counter ratchet 与 macOS native lane。Node lane 只运行一轮交替序列：

```text
A1, B1, A2, B2, …, A20, B20
```

A 是冻结的 baseline，B 是候选版本。每个现有场景两侧各保留 20 个原始批次样本。workload、lane、warmup、每批 iterations、场景集合、counter ceilings 和绝对 budgets 不变。缺场景、失败批次、不同环境、不同 harness 或不足 20 个样本都 fail closed。

P95 使用全部原始样本。耗时门限保持：

```text
min(absoluteBudget, baselineP95 + max(10, baselineP95 * 0.5))
```

counter 与耗时仍分别判定，不能互相抵消，也不能通过删除行或投影掉样本来放行。

## 阶段诊断

每个 measured batch 在真实生产路径调用外包裹 benchmark-only API 观测。详细 stage 最多保留 256 条；超出的调用不丢失统计，按固定 kind 写入完整 `stageTotals`：`git-command`、`file-operation`、`process-command`，分别保留 `count`、非独占 `totalMs` 和 `maxMs`。阶段区间可能重叠，不能把 total 相加当成独占 wall time。

覆盖范围明确限于 worker 列出的 sync/async `node:fs`、`node:fs/promises` API 与 `execFile` 调用。它不覆盖 `FileHandle` 方法、native module 内部 syscall、Git 子进程内部 syscall 或完整文件系统审计。详细区间被截断时，`droppedStageCount` 保留证据；`stageTotals` 仍完整。

## 身份与冻结

candidate 的 ABAB harness、固定场景 fixture、Vitest 配置、Codex fixture 和 timing wrapper 显式复制到 baseline；生产源码不会被复制。两侧的 harness hash、环境和场景列表必须一致；revision分别来自各自checkout，可以不同。counter 采集在计时完成后串行执行，L1 counter collector的独立重复数保持原来的5次，不与两侧20个耗时样本混为一谈，native lane 不被这次 Node 迁移替换。

此前实验验证运行过三轮；正式 CI 不重复三轮。原 Node 22 那次失败的根因未查明。该历史事实不被新的形式化合同改写为性能结论。

## 验证命令

```bash
npx vitest run scripts/performance-abab.test.ts scripts/performance-node-workflow.test.ts scripts/performance-feedback.test.ts scripts/performance-ratchet.test.ts
npm run typecheck
node scripts/performance-abab.mjs --baseline /path/to/baseline --candidate /path/to/candidate --output /tmp/scry-formal-abab --batches 20
node scripts/performance-abab-report.mjs /tmp/scry-formal-abab
npm run performance:measure -- --out /tmp/scry-formal-counters
npm run build
```

本机focused回归、TypeScript检查和实际调度负对照见PR；将真正的调度函数改回先全部A、再全部B时，交替执行测试确定失败。worker在普通单测收集时显式跳过，不额外启动benchmark，也不重复注册原单测。完整阶段记录校验在比较前执行，缺文件/Git证据或worker清理失败都不能给出绿色报告。

原Node 22失败的根因仍未查明。新旧总耗时以GitHub实际运行记录填入PR：同时报告整个Performance工作流墙钟（包含排队）和Node计时步骤，避免把不同runner/队列的差异说成严格因果加速。正式CI不复跑三轮；三轮只用于此前独立实验验证。
