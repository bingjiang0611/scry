# 批次 D：多仓库工作区的覆盖可见性

分支：`reliability/collection`，C 核验后开始。

场景：一个工作区下有十几个子仓库。record 本身不会丢，但**某些仓库的改动可能不在记录里，而且看不出来**。

## D1 发现深度之外的仓库静默缺席

- `discoverRepositories`（`config.ts:218-244`）默认 `maxDepth: 2`，上限 5；更深的仓库、符号链接目录、`exclude` 中的目录都不采集。
- **先证实**：构造 `root/a/b/c/.git`（深度 3），默认配置下发现结果不含它，record 中也没有任何提示。

**改法方向**
- 发现阶段统计「因深度上限未继续下探的目录数」（不必真的扫完全部，只需知道截断发生过），写进 record 的 diff 证据或 runtime metadata，标明 `partial` 并写原因。
- `doctor` 增加一项：列出 depth+1 层是否还有 `.git`，提示调大 `maxDepth` 或加 `exclude`。
- 不要默认把 `maxDepth` 调大：发现成本在 UserPromptSubmit 热路径上，调整默认值需要测量证据和用户同意。

## D2 每轮的仓库清单与快照结果如实可见

- 日常数据：6,691 份快照中 353 份 timeout、67 份 failed（`docs/performance-experiments/20261021-cli-multirepo-concurrency.md`）。
- 确认 record 中能看出「本轮发现了几个仓库、每个仓库的快照状态（captured / timeout / failed）」。如果已有，写明字段位置即可，不改；如果缺失或只在聚合层可见，补到 record 中。
- 并发值调整**不在本批范围**（上一轮实验结论是证据不足），不要改。

## 测试

`npm run test:unit -- src/core/turn-recorder/config.test.ts src/core/turn-recorder/recorder.test.ts`，`npm run typecheck`。如改到 `git.ts` 热路径，按 CLAUDE.md 跑 `npm run performance:measure` 并解释每个 `worse`。
