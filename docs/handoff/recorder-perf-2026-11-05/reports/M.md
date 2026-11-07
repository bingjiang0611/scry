# 批次 M：测量工具、正确性对照与基线

状态：**待核验**。全部条目已提交，未 push（等本批报告写完统一 push）。

## 条目

| # | 条目 | 结论 | 提交 |
|---|---|---|---|
| M1 | L1 计数工具 | 已做 | `668befdd`、`8ac6d7d9`、`58373984`、`02178066` |
| M2 | Git 快照正确性对照（oracle） | 已做 | `8deaa6f1` |
| M3 | 基线 | 已做 | `1ff8bc5c` |

## 工具

- `scripts/recorder-engine-bench.mjs`（+ `-fixtures.mjs`、`-report.mjs`）：11 个场景的 L1 计数。
  Git 子进程数来自放在 `PATH` 最前面的计数包装脚本（只记录 argv 后 exec 真实 git），不是估算。
  `idx≈` 是「每次重写 index 前的 index 大小」之和，不是 Git 内部写入字节。
- `scripts/recorder-engine.measurement.test.ts`：fsync / readdir / readFile / 锁持有时间 /
  content-store 哈希与读回计数，直接 mock `node:fs/promises`。
- `scripts/recorder-repo-concurrency.measure.mjs`：多仓库并发上限的 L2 毫秒探针（G1-3 用）。
- `scripts/git-turn-diff-bench.mjs`：单次 git 调用的毫秒与 index 字节（前期探索用）。

报告拆分（`-report.mjs`）是为了让每个文件低于仓库 20 KB 门禁；跟踪的 JSON 只存每场景聚合
（Git 计数在每轮是确定值，存全部轮次只会把文件撑过门禁），逐轮明细用 `--detail=` 输出到仓库外。

## M2：oracle

`src/core/turn-recorder/git-snapshot-oracle*.test.ts`：同一场景分别跑 targeted 新路径与
`SCRY_TURN_DIFF_STRATEGY=full` 全量路径，比较 afterTree、逐文件 patch 字节、状态与原因。
覆盖 O1–O16（sparse checkout、.gitattributes、符号链接、子仓库、特殊文件名、二进制、
同大小同 mtime、轮次之间的提交/切分支/stash 等）。

运行：`npx vitest run src/core/turn-recorder/git-snapshot-oracle*.test.ts` → 3 个文件、21 个场景
（11 + 6 + 4）全部一致。`git-raw-numstat.test.ts` 是 G1-2 的解析器单测，不属于 oracle。

## M3：基线

见 `docs/performance-experiments/20261105-recorder-engine-baseline.md` 与同名 `.json`。
机器 macOS（darwin 27.2.0 / Node v24.18.0 / Apple M2 Pro 10 核），运行期间 1 分钟负载 12.5–21
（同机其他 agent 在工作，毫秒只能作参考，L1 计数不受影响）。

主要数字：

| 场景 | start git | end git | 备注 |
|---|---|---|---|
| S1 小仓库 1 文件 | 4 | 9 | |
| S2 20k 已跟踪 1 文件 | 4 | 9 | index≈4.8 MB |
| S3 20k dirty 基线 | 9 | 9 | 开始阶段 index≈6.4 MB |
| S4 20k 300 文件 | 4 | 11 | diff:5 |
| S5 单个 50 MB 文件 | 4 | 9 | 结束 15.1–17.6 s，峰值 RSS +1.74 GB |
| S6 18 仓库 | 36 | 72 | |
| S7 30 次工具调用 | 4 | 3 | 工具阶段 0 个 git |
| S8 50 MB transcript | 9 | 6 | parse 52.4 MB + anchor 52.4 MB |
| S9 提交 0/1k/10k | — | — | 22 / 28 / 41 ms |
| S10 4 会话 × 5 轮 | 140/轮 | | 4.9–5.9 s/轮 |
| S11 恢复 1000 会话目录 | 4 | — | 221–254 ms |

## 未验证 / 交给用户

- 只在 macOS 上测过毫秒；Linux 未测（L1 计数与平台无关）。
- 基线里的 hook 是进程内直接调用（direct 路径），不含 Provider 延迟和 daemon 调度。
- `SCRY_BENCH_ROUNDS` 默认 3 轮：S5/S9 这类单次就十几秒的场景靠 3 轮取中位数，噪声仍明显。
