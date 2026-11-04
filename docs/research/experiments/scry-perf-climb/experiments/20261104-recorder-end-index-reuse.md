# 轮次结束复用启动快照的隔离 index（recorder）

- 目标指标：`recorder / daemon fast path / clean, 0 tools / gitCalls.stop`（基线 47）与 `stop` 耗时（基线 1285.3 ms），预期计数 ≤ 36、耗时至少降 10%
- 假设：结束时候选发现先用 `read-tree --reset <beforeTree>` 重建隔离 index，这会丢掉 stat cache，紧跟的 `update-index --really-refresh` 只能对整个工作树重新 stat 一遍；而启动快照本来就有内容等于 `beforeTree` 的 index（工作区脏时是 `before.index`，干净时是没被改写的真实 index）。沿用它、只在无法证明时重建 → 每个仓库每次轮次结束少一次 `read-tree`，且 refresh 走 stat cache。没做的事：候选集合的口径不变，仍是“工作树 vs `beforeTree`”。
- 改动：recorder 本仓库 `38686164`（首次提交 `55a3d9c1` 把发布条件写反，只有 sparse checkout 仓库复用，已修）；uploader 无；测量改动：无（沿用 A/A 校准）
- 自查：
  - `npx vitest run src/core/turn-recorder`：39 个文件 / 477 项通过
  - `npm run typecheck`：node 与 web 两套均通过
  - 新增断言“只在非 sparse checkout 时发布可复用 index”，把发布条件写反时该断言失败（`expected undefined to be defined`）；原有两条行为用例在写反时仍通过，因为重建路径给出相同候选——计数是唯一能区分的证据
  - 记录摘要：`ed4ea3…`，四次运行相同
- 测量：`results/index-reuse-20261104/AB-2026-11-04T09-14-25-737Z.md`，结论 **IMPROVED**（变好 28，其中计数 16、耗时 12；变差 0；计数不稳定 0）
  - 目标指标：`gitCalls.stop` 47 → 36（−11，任何变化即算数）；`stop` 1285.3 → 1021.9 ms（−20.5%，需要超过 128.5 ms，p ≈ 6.7e-6）
  - L1 计数变化：`gitCalls.stop` 47 → 36、`gitCalls.total` 75 → 64，8 个场景全部相同幅度（每个仓库少一次）；脏工作区场景 68 → 57、96 → 85
  - 耗时连带变化：`daemon fast path / clean, 5 tools / hookTotalPerTurn` 3679.3 → 2172.1 ms（−41%）；`clean, 30 tools / stop` 1343.4 → 1034.6 ms；`CLI fallback / clean, 30 tools / stop` 1897.0 → 1530.8 ms（−19.3%）
  - 变差项：无
- 结论：成立并保留
- 证据级别：L1（计数）；受控耗时下降另有 L2 支持，但公开结论以计数的 L1 为准
- 下一步：同一条“别丢 stat cache”的思路可以继续看结束时的 `writeTargetedSnapshotTree`（候选仓库仍各做一次 `read-tree`）；收益取决于候选仓库数量，见台账机会排名
