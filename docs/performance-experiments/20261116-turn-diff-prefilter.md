# 每轮仓库扫描的便宜预筛

## 范围与数据来源

- 现场数据：`~/IdeaProjects/rate-native/.scry/records` 的 2780 条记录（recorder 0.2.73），其中 2726 条带 diff，共 30810 次仓库采集。
- 基准对象：该工作区的只读副本（`rsync -a --exclude='.scry'`，原目录未改动）。副本是干净的；现场是脏的，两者不可直接比绝对值，只比同一台机器上改前/改后的同一份副本。
- 基准脚本：`scripts/git-turn-diff-workspace.measure.mjs --paired`，对每个仓库在同一轮内交替跑两个构建，取每仓库中位数再求和。测量的机器为 macOS / Apple M2 Pro 10 核，运行期间系统负载 30–90（其他进程造成），因此绝对值偏高，只有配对差值有意义。
- 改前构建：基线提交 `7dd95864` 的 `npm run build:cli` 产物；改后构建：本改动。

## 现场事实：贵的不是 diff，是起点快照

每轮（p50）的分布：

| 项 | p50 | 说明 |
| --- | --- | --- |
| 每轮仓库数 | 12（最大 34） | `discover-nested-git` + `maxDepth=2` 的结果 |
| 基线 `captureMs` 合计 | 48.1s | 轮次开始为每个仓库冻结基线 |
| diff 阶段合计 | 14.5s | `discoveryMs` 11.2s + `targetedMs` 2.9s + `fallbackMs` 0.4s |
| 采集总数 | 30810 | 其中 2528 次以 timeout 结束（8.2%） |
| strategy | `targeted` 20679 / `full_fallback` 6372 / 无 3759 | `fallbackReason` 中 `discovery_failed` 4343 |

也就是说：现场每轮 79.6s 里，起点快照占大头，diff 阶段里最贵的是 discovery（一次 `status` + 索引刷新）而不是补丁生成。`discovery_failed` 占比这么高，说明 discovery 的 `preFallbackBudget / 2` 子预算在脏仓库上不够用，随后整轮退回 `add -A` 全量采集。

## 改动

只有**干净基线**才可能被跳过，且只在收尾侧：

1. 干净基线的基线就是起点提交 `HEAD`，本来就没有写工作树快照。收尾先跑一次
   `git status --porcelain=v2 --branch -z --untracked-files=normal`（`--no-optional-locks`，不写真实索引）。
2. 只有「HEAD 仍是基线那个提交」且「输出里除 `# ` 头之外没有任何记录」才判定未改动，
   返回 `collection.strategy: 'unchanged'`、`evidence: 'git_status'`。
3. 另外检查 `git ls-files -v`：`status` 会跳过 assume-unchanged 条目，被跳过的改动仍然属于本轮，
   因此只要索引里存在这类条目就退回完整采集。
4. 其余一切情况都退回原来的完整流程：非干净基线、HEAD 移动、任何状态记录、本轮工具事件点名了
   该仓库内的路径、`forceFull`、`SCRY_TURN_DIFF_STRATEGY=full`、`status` 超时或报错。
5. 这条路径的 `status` 用整轮 diff 预算，不受 discovery 子预算限制，因此现场那批
   `discovery_failed → full_fallback` 的干净仓库不再进入 fallback。这一条是机制推断，未在现场验证。

起点（`beginGitTurnDiff`）没有改：干净仓库本来就只跑 `rev-parse` + `status`，脏仓库必须冻结快照，
否则无法把本轮改动和轮次开始前就存在的改动分开。

## 基准结果

三次 `--paired` 运行，同一份 22 个仓库的副本，求和口径是每仓库中位数之和（等于「一次只采一个仓库」的每轮耗时）：

| 运行 | 改前 | 改后 | 差值 |
| --- | --- | --- | --- |
| 1（负载 ~87） | 5994.3ms | 4389.4ms | −26.8% |
| 2（负载 ~49） | 6918.3ms | 5788.4ms | −16.3% |
| 3（负载 ~30） | 5685.4ms | 4110.2ms | −27.7% |

单仓库抽样（`min/p50`，改前 → 改后）：`review2` 462/546 → 364/447ms，`rateplatform` 425/479 → 358/437ms，
`ratesearch` 140/159 → 86/94ms，`rp-client` 194/250 → 139/172ms。慢仓库只省一次索引刷新，
快仓库省一次索引刷新加一次索引复制，所以小仓库的相对收益更大。

现场三个真实仓库的单次对照（`rate-native` 与其两个 worktree）：干净仓库 150–185ms → 105–141ms；
轮次开始时已经脏的主仓两次都是完整采集（538ms / 449ms），未受影响。

并行口径（默认模式）下每轮墙钟几乎不变，因为一批仓库的墙钟由最慢的那个决定；只有串行/逐仓库口径
才看得到上面的合计差。

## 不漏的论证

- 跳过只在「基线干净」时发生，此时基线树就是起点提交。任何本轮改动都会让
  `status --porcelain=v2` 至少输出一条非 `# ` 记录（tracked 修改、删除、重命名、未跟踪文件或目录、
  merge 冲突），或者让 HEAD 移动（本轮里提交）。两者任一成立就走完整采集。
- 索引屏蔽（assume-unchanged/skip-worktree）会让 `status` 沉默，因此额外读 `ls-files -v`，
  出现小写标记即退回完整采集。`skip-worktree` 条目本来就不在工作树里，完整流程同样看不到它们。
- 工具事件点名了仓库内路径时不做任何 `status` 猜测，直接完整采集；`forceFull` 与
  `SCRY_TURN_DIFF_STRATEGY=full` 优先于预筛。
- `status` 失败、超时、输出无法解析、`repoRoot` 缺失都当作「无法证明未改动」，走完整采集：
  预筛只能省工，不能改变结论。
- 放弃跳过时不需要额外清理：基线存储本来就是本轮该保留的东西，记录里也不会出现 `unchanged`。

回归测试覆盖四种形状：干净且未改动（一次 `status`，不写快照索引）、开始干净但本轮有修改/新增/提交
（三类改动都在 diff 里，且对着起点提交算）、工具事件点名路径（即使看起来干净也完整采集）、
索引标 assume-unchanged（改动仍在 diff 里）、开始时已经脏（只报本轮改动）。

## 限制

- 脏基线无法跳过：把「本轮改动」和「轮次开始前的改动」分开，必须冻结起点快照。现场 48.1s 的
  起点快照成本基本都在这里，本改动不解决它。
- 一个真正有改动的干净仓库会比以前多付一次 `status`（约 100–600ms），换来的是所有未改动仓库各快一次。
- 基准是副本 + 本机负载下的配对差值，不是现场端到端数字。
