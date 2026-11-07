# 批次 M：测量工具、正确性对照与基线

分支 `perf/recorder-engine`。先读 [README.md](README.md) 的硬约束和 [review.md](review.md)。

这一批**不改产品行为**。它产出三样东西，后面每个批次都靠它们自我验证：

1. **L1 计数工具**：一次完整轮次（开始 → 若干工具事件 → 结束 → record 可读）里，各类真实工作做了多少次。
2. **正确性对照（oracle）**：新旧 Git 快照实现在同一场景下必须产生完全相同的证据。
3. **基线**：在当前 `main` 代码上跑出的计数表，提交到 `reports/M.md`。

测量代码与后续优化代码必须分开提交（仓库「不骗计数」）。

## M1 L1 计数工具

新建 `scripts/recorder-engine-bench.mjs`（informational，不作门禁，参照 `scripts/git-turn-diff-bench.mjs` 的写法：依赖 `npm run build:cli` 产物，始终 exit 0）。

**要计的东西**（每个场景、每个阶段分开：轮次开始 / 每个工具事件 / 轮次结束 / 恢复）：

| 计数 | 建议实现方式 |
|---|---|
| git 子进程数，按子命令分类（`read-tree`、`add`、`write-tree`、`diff`、`status`、`update-index`、`rev-parse`、`config` …） | 在 `PATH` 最前面放一个 `git` 包装脚本：把 argv 追加写到一个日志文件，再 `exec` 真实 git。不改产品代码。 |
| index 文件读写字节、私有对象目录新增对象数与字节 | 结束后统计 tempDir / 对象目录；必要时用包装脚本记录 `GIT_INDEX_FILE` 的大小。 |
| fsync / 目录同步次数、`readdir` 次数、锁等待与持有时间 | 参照 `scripts/recorder-contention.measurement.test.ts` 的 `vi.mock('node:fs/promises')` 计数方式，写成 vitest measurement 测试。 |
| transcript 解析字节数、缓存命中/未命中 | 已有 `transcriptSnapshotCacheStats()`；需要「解析字节数」时，可以加一个与之同类的进程内诊断计数（零开销、只读），单独提交。 |
| 峰值 RSS | `process.memoryUsage().rss` 采样，或 `/usr/bin/time -v`（Linux）/ `-l`（macOS）。 |
| hook 返回时间、record 可读时间 | 分开记录：hook 进程退出（或 daemon 回 ACK）的时刻，以及 `.scry/records` 出现对应文件的时刻。这两者**必须分开报告**。 |

**场景**：按 [README.md](README.md#使用场景所有批次都要覆盖) 的使用场景组合，至少包括：

- S1 小仓库，干净基线，改 1 个文件
- S2 大仓库（≥20,000 个已跟踪文件，脚本生成），干净基线，改 1 个文件
- S3 大仓库，**dirty 基线**（开始前已有 50 个未提交改动），本轮再改 1 个文件
- S4 大仓库，本轮改 300 个小文件
- S5 单个 50 MB 文本文件改动（测峰值内存）
- S6 18 个小仓库的多仓库工作区，其中 3 个有改动
- S7 30 次工具调用的一轮（60 个前后事件），无文件改动
- S8 长 transcript（≥50 MB）上的轮次结束
- S9 records 已有 0 / 1,000 / 10,000 条时提交一条新 record
- S10 4 个会话并发各跑 5 轮

不要求跑真实 Provider。用临时 workspace + 直接调用 hook 入口（`handleRecorderHook` 或构建后的 `scry recorder hook`），payload 参照现有测试夹具（`src/core/turn-recorder/*.test.ts` 里有大量 Claude/Codex 夹具）。

输出：机器可读 JSON（`--json`）+ 人类可读表。JSON 存到 `docs/performance-experiments/20261105-recorder-engine-baseline.json`，说明写在同名 `.md`。

## M2 Git 快照正确性对照（oracle）

新建 `src/core/turn-recorder/git-snapshot-oracle.test.ts`（进入常规 `npm run test:unit`）。

**做法**：对每个场景，在**同一个工作树状态**上分别用

- 被测实现（当前是 targeted 路径；G 批次之后是新实现），和
- 全量路径（`computeGitTurnDiff` 的 `options.forceFull = true`，等价于 `SCRY_TURN_DIFF_STRATEGY=full`）

计算 afterTree，然后断言：

1. afterTree 的 hash 完全相同；
2. 文件列表（路径、变更类型、增删行数、二进制标记）完全相同；
3. `completePatches: true` 时 patch 正文逐字节相同；
4. **用户真实 index 未被修改**：前后 `.git/index` 的 sha256、size、mtime 不变；
5. **用户真实对象库未被写入**：前后 `.git/objects` 下的松散对象数量不变。

**必须覆盖的场景**（这些是报告里列出的「不能走的捷径」，每个都要有一个用例）：

| # | 场景 |
|---|---|
| O1 | 普通修改、新增、删除 |
| O2 | **同大小、同 mtime 的修改**（racy-clean：改完立刻 `utimes` 回原值） |
| O3 | 文件变目录、目录变文件 |
| O4 | 符号链接：新增、改指向、链接变普通文件 |
| O5 | 可执行位变化 |
| O6 | sparse checkout（`git sparse-checkout set`），包括 skip-worktree 范围外的路径 |
| O7 | 开始后外部改写真实 index（`git add` / `git reset` 一部分文件） |
| O8 | 本轮修改 `.gitignore` / `.gitattributes`（含 `eol=crlf`、`text=auto`） |
| O9 | 配置了 clean/process filter 的仓库（确认不会执行 filter 命令：filter 写一个标记文件，断言标记不存在） |
| O10 | 子仓库与 submodule（gitlink 变化） |
| O11 | 文件名含空格、换行、引号、非 UTF-8 字节 |
| O12 | 二进制文件改动 |
| O13 | assume-unchanged / skip-worktree 标记在真实 index 上 |
| O14 | linked worktree（`git worktree add`） |
| O15 | **两轮之间**外部修改文件（为 G2 准备：第 1 轮结束后改文件，再开始第 2 轮，第 2 轮的 beforeTree 必须包含这次修改） |
| O16 | 两轮之间切换分支 / `git commit` / `git stash` |

在当前 `main` 代码上，这组测试应该**全部通过**（它测的是现有 targeted 与 full 是否一致）。如果某个用例在 main 上就不一致，说明发现了现有缺陷：单独记录在 `reports/M.md`，标 `既有缺陷`，不要在本批修，也不要为了让它通过去改断言；在该用例上加 `it.fails` 并注明原因，后续批次不得让它更糟。

## M3 基线

在**未做任何优化**的代码上跑 M1 和 M2，结果写进 `reports/M.md`：

- 每个场景的 L1 计数表（开始 / 工具事件 / 结束 / 恢复分列）
- oracle 结果
- 你从基线里看到的最大成本来源，按场景排序（这是 G、R 批次的优先级依据）

## 完成条件

- `npm run test:unit -- src/core/turn-recorder/git-snapshot-oracle.test.ts` 通过（含 `it.fails` 说明）
- `npm run build:cli && node scripts/recorder-engine-bench.mjs --json` 能跑完所有场景（大仓库场景允许用环境变量缩小规模做冒烟，但基线必须用完整规模）
- `npm run typecheck`
- `reports/M.md` 与 STATUS 已更新并 push
