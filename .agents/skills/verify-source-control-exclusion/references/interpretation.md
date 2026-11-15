# Results and counterexamples

## Current code

At sync commit `efc650597ae694fcd83f9346c7a8bd1725176512`, TLC checked **432 reachable states** with no violation of `NoWriteDuringUnsettled`. The real-code baseline and restored copy each passed **11/11** witnesses on macOS arm64, Node 24.18.0, Java 26.0.1. Linux execution was not performed. No current-code defect was established within this scope.

The accepted cached-tool run recorded 23.16 seconds of cumulative child-command time on this host; load was not characterized. This is not a performance guarantee or total wall time. First download, machine load and platform affect the run.

The two failures below are **deliberately broken scratch copies**, not bugs reported in the current product. The checker restores those copies and leaves production files unchanged.

## Removed admission guard

Broken real code: remove the final `active.has(identity.commonDir)` rejection in `SourceControlService.admitRun`.

Harm: a newly registered Agent can overlap a panel Git mutation in the same repository.

Shortest path (six transitions):
1. `exclusive` acquires the repository gate.
2. `admitRun` starts and waits for Git identity.
3. `busy` captures an empty unsettled-directory snapshot.
4. Identity resolves; the missing guard lets `register()` run.
5. `busy` finishes checking its previously captured empty snapshot.
6. `executeMutation` dispatches while the registered run is unsettled.

The real-code test **replays shortest BrokenAdmission path** reproduces this ordering using controlled dependency promises. The unmodified guard rejects registration instead. The broader same-root and linked-worktree witnesses also fail on this mutation.

## Removed local-finalization ownership

Broken real code: remove `|| state.localFinalizing === true` from `RunRegistry.unsettledStates`.

Harm: Git writes may start while recorder/diff work still owns the repository, even though Provider transport has ended.

Shortest path (six transitions):
1. `admitRun` registers a running Agent.
2. `exclusive` acquires the repository gate.
3. Provider settles, but `localFinalizing` remains true.
4. The broken `unsettledStates` drops that run from the snapshot.
5. `busy` sees no owner.
6. `executeMutation` dispatches before local finalization ends.

The real-code test **replays shortest BrokenFinalization path** changes those real registry fields after gate acquisition, before the snapshot. It must fail with the property assertion on the mutated source and pass on the restored source.

## Reading the charts

These are the Mermaid outputs from `/statechart`, not hand-drawn proof claims. Labels intentionally combine identity waits, preflight steps and release bookkeeping. The reports retain all six numbered counterexample steps even when several share a chart label. No transition is filtered out; transitions remaining in one projected state are normally omitted except when needed for a bug path.

**An arrow from Agent occupancy to Git execution in a passing chart is possible for a different repository.** The projection does not show repository identity. It never means same-repository overlap is allowed. Every state marked as breaking the property is separated from safe states.

TLC also reports no deadlock for this finite model, which explicitly stutters at completed states. That is not a product liveness/fairness or crash-recovery claim.

### Passing baseline

TLC reached 432 states and 987 steps. The chart draws 5 states and 13 arrows.
The chart does not draw 621 steps that stay in one chart state.

```mermaid
---
title: "Scry repository ownership"
---
stateDiagram-v2
  s0: 无已登记占用
  s1: Agent 已登记并占用仓库
  s2: Git 门闩已持有
  s3: Provider 结束 本地仍在收尾
  s4: Git 操作执行中
  [*] --> s0
  s0 --> s1: 请求启动 Agent or 核对门闩后登记或拒绝
  s0 --> s2: 取得 Git 门闩
  s1 --> s3: Provider 结束
  s2 --> s0: 释放 Git 门闩
  s3 --> s0: 完成本地收尾
  s2 --> s1: 核对门闩后登记或拒绝
  s3 --> s2: 完成本地收尾
  s2 --> s4: 执行 Git 写入
  s1 --> s4: 执行 Git 写入
  s4 --> s2: Git 操作返回
  s3 --> s4: 执行 Git 写入
  s4 --> s1: Git 操作返回
  s4 --> s3: Git 操作返回
```

### Broken admission control

TLC reached 460 states and 1101 steps. The chart draws 6 states and 21 arrows.
The chart does not draw 668 steps that stay in one chart state.

```mermaid
---
title: "Scry repository ownership"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: Breaks NoWriteDuringUnsettled
    lg1: Path to the NoWriteDuringUnsettled bug
  }
  class lg0 breaks
  class lg1 bugPath
  s0: 无已登记占用
  s1: Agent 已登记并占用仓库
  s2: Git 门闩已持有
  s3: Provider 结束 本地仍在收尾
  s4: Git 操作执行中
  s5: 错误 同仓库写入重叠
  [*] --> s0
  s0 --> s1: 请求启动 Agent or 核对门闩后登记或拒绝
  s0 --> s2: 取得 Git 门闩
  s1 --> s3: Provider 结束
  s2 --> s2: 请求启动 Agent or 记录占用快照
  s2 --> s0: 释放 Git 门闩
  s3 --> s0: 完成本地收尾
  s2 --> s1: 核对门闩后登记或拒绝
  s3 --> s2: 完成本地收尾
  s2 --> s4: 执行 Git 写入
  s1 --> s1: 核对占用者身份
  s1 --> s4: 执行 Git 写入
  s4 --> s2: Git 操作返回
  s3 --> s4: 执行 Git 写入
  s1 --> s5: 执行 Git 写入
  s4 --> s1: Git 操作返回
  s4 --> s5: 核对门闩后登记或拒绝
  s3 --> s5: 执行 Git 写入
  s4 --> s3: Git 操作返回
  s5 --> s1: Git 操作返回
  s5 --> s4: 完成本地收尾
  s5 --> s3: Git 操作返回
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  class s0 bugPath
  class s1 bugPath
  class s2 bugPath
  class s5 breaks
  class s5 bugPath
```

### Broken finalization control

TLC reached 448 states and 1031 steps. The chart draws 6 states and 18 arrows.
The chart does not draw 638 steps that stay in one chart state.

```mermaid
---
title: "Scry repository ownership"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: Breaks NoWriteDuringUnsettled
    lg1: Path to the NoWriteDuringUnsettled bug
  }
  class lg0 breaks
  class lg1 bugPath
  s0: 无已登记占用
  s1: Agent 已登记并占用仓库
  s2: Git 门闩已持有
  s3: Provider 结束 本地仍在收尾
  s4: Git 操作执行中
  s5: 错误 同仓库写入重叠
  [*] --> s0
  s0 --> s1: 请求启动 Agent or 核对门闩后登记或拒绝
  s0 --> s2: 取得 Git 门闩
  s1 --> s3: Provider 结束
  s1 --> s1: 取得 Git 门闩
  s2 --> s0: 释放 Git 门闩
  s3 --> s0: 完成本地收尾
  s2 --> s1: 核对门闩后登记或拒绝
  s3 --> s2: 完成本地收尾
  s3 --> s3: 记录占用快照 or 核对占用者身份
  s2 --> s4: 执行 Git 写入
  s1 --> s4: 执行 Git 写入
  s4 --> s2: Git 操作返回
  s3 --> s5: 执行 Git 写入
  s3 --> s4: 执行 Git 写入
  s4 --> s1: Git 操作返回
  s5 --> s3: Git 操作返回
  s5 --> s4: 完成本地收尾
  s4 --> s3: Git 操作返回
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  class s0 bugPath
  class s1 bugPath
  class s3 bugPath
  class s5 breaks
  class s5 bugPath
```
