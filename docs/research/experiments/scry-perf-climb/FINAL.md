# 爬坡最终报告（rn-shell，recorder + uploader）

本文件收束这一轮爬坡：最初基线 → 最终候选的 `perf-ab` 对比、保留的改动、证据级别、阻碍与建议下一步。数值都在同一台机器（Apple M1 / 8 核 / 16 GiB / macOS 26.3.2 / Node v24.18.0 / git 2.50.1）、同一份 `rn-shell` 工作区副本上测，只与这份基线比较。

## 结论

- 保留 1 项代码改动，在 recorder：轮次结束复用启动快照的隔离 index。安静窗口重跑的最终对比判 **IMPROVED**：变好 49（计数 32、耗时 17），变差 0，计数不稳定 0。计数是 L1，耗时是 L2。
- 2 项 uploader 改动实测不成立或未验证，已回退（`hooks` 空闲唤醒跳过、跨进程复用契约探测）。
- 相对最初基线：结束 git 调用 −11/轮（47 → 36，每个仓库一次 `read-tree --reset`）；轮次结束耗时 −14.3%（1161.7 → 996.2 ms），脏工作区 −10.6%，包装路径的节点内 `plain.stop` −15.7% ~ −17%。

## 最初基线 → 最终候选

`results/final-rerun-20261104/AB-2026-11-04T18-30-29-638Z.md`（`perf-ab`，基线 2 份、候选 2 份，`--phases recorder,hookwrap --pairs 2 --rounds 7`，A/A 校准 `results/aa-20261104/AB-2026-11-04T07-30-40-178Z.json`）。

| 指标 | 最初基线 | 最终候选 | 变化 | 级别 |
| --- | --- | --- | --- | --- |
| recorder / daemon fast path / clean, 0 tools / gitCalls.stop | 47 | 36 | −11（每个仓库一次） | L1 |
| 同上 `gitCalls.total` | 75 | 64 | −11 | L1 |
| recorder / daemon fast path / dirty / gitCalls.stop | 68 | 57 | −11 | L1 |
| 同上 `gitCalls.total` | 96 | 85 | −11 | L1 |
| recorder / daemon fast path / clean, 0 tools / stop | 1161.7 ms | 996.2 ms | −165.5（−14.3%，p ≈ 1.6e-5） | L2 |
| recorder / daemon fast path / clean, 5 tools / stop | 1174.1 ms | 1009.4 ms | −164.7（−14%） | L2 |
| recorder / daemon fast path / dirty, 5 tools / stop | 1506.7 ms | 1347.7 ms | −159（−10.6%） | L2 |
| recorder / CLI fallback / clean, 0 tools / stop | 1653.9 ms | 1479.2 ms | −174.7（−10.6%） | L2 |
| hookwrap / daemon fast path / clean, 0 tools / plain.stop | 1187.1 ms | 985.8 ms | −201.3（−17%） | L2 |
| hookwrap / daemon fast path / clean, 0 tools / wrapped.hookTotalPerTurn | 4765.0 ms | 4477.4 ms | −287.6（−6%） | 未过门槛（方向一致，不算数） |
| hookwrap / daemon fast path / clean, 5 tools / wrapped.hookTotalPerTurn | 3908.7 ms | 3754.6 ms | −154（−3.9%） | 未过门槛 |

包装路径每轮的 3.8–4.8 s 里，结束段只占约 1.0–1.8 s；本次省下的是结束段的一部分，所以 `wrapped.hookTotalPerTurn` 的变化低于 10% 门槛。不宣称包装路径的整体提速。

## 候选身份（为什么 `cand ea2` 就是 `38686164`）

| 检查 | 输出 |
| --- | --- |
| 候选提交 | `386861644022de73e9e97cafc4617da5be9b3287` |
| 复现构建 | 在该提交的干净 worktree 里 `npm run build:cli`，`dist` 105 个文件与远端候选二进制 sha256 全等；入口 `dist/cli/scry.js` = `0293acfceebe44afbd828ed37b7ded9a7723bbfdc59dee1992fdbaaae1fa0f1c` |
| `git diff 38686164 <本轮 HEAD> -- src` | 空（`src` 侧没有更新的改动参与测量） |
| 交付头（PR `#25`，`50e73fe6`）的计数复核 | 单次 `--phases recorder` 运行：stop 36、total 64，脏工作区 57 / 85 —— 与 `38686164` 一致，说明后续的 sparse 守卫修正不改变这条工作负载上的计数 |

## 保留的改动

| 改动 | 提交 | 作用 | 级别 | 实验 |
| --- | --- | --- | --- | --- |
| 轮次结束复用启动快照的隔离 index | `38686164`（首次 `55a3d9c1`；PR `#25` 合入前追加 sparse 守卫修正，头 `50e73fe6`） | 结束 git 调用 47 → 36；`stop` 1161.7 → 996.2 ms | L1 + L2 | `experiments/20261104-recorder-end-index-reuse.md` |
| 测量基础设施：`perf-bench` 拆成入口 + `bench-*.mjs`；修掉“恢复副本时删掉 985 个跟踪文件”和“假传输层到不了 uploader worker”；报告不再写真实传输变量名 | `6af83d22`、`35bdf39b` | 修好后 A/A 才干净（74/74 上传、摘要一致） | – | `results/aa-20261104/README.md` |

`#25` 里的 sparse 守卫修正来自评审：linked worktree 的 `info/sparse-checkout` 在 `<common>/worktrees/<id>/` 下，拼 `commonDir` 会在 linked sparse worktree 里漏判，从而给稀疏仓库发布可复用 index。改用同一次 `rev-parse` 里的 `--git-path info/sparse-checkout`（不增加子进程），并补了 linked worktree 用例；旧实现在该用例上失败。

## 回退的改动

| 改动 | 私有提交 | 结论 | 原因 |
| --- | --- | --- | --- |
| 队列空时跳过唤醒启动 | `07f4c89`（回退 `37a172f`） | 不成立 | 这条路径上记录靠唤醒发现，队列为空等于“还没被发现”；候选运行上传 0/74 |
| 跨进程复用工具参数契约探测 | `7f0118b`（回退 `efb54f2`） | 未验证 | 候选运行同样上传 0/74，原因未定位；即使成立也低于 10% 门槛 |

## 证据级别说明

- L1：git 子进程计数，四次运行完全一致，可复核 `results/final-rerun-20261104/`。
- L2：受控耗时（同一台机器、同一副本、A/A 校准过的门槛、Mann-Whitney p < 1e-4）。不宣称 L3：没有发布后日常使用数据。
- uploader 侧没有保留改动，`uploader` 阶段的 `recordsPerSecond` 与 `transportRequests` 仍为“测不到”（一轮 500 条积压排空要 185–325 s，预算内放不下 4 次运行）。

## 阻碍

| 阻碍 | 需要什么 | 影响 |
| --- | --- | --- |
| 共享测量机的负载多次越过 `ab-session` 门槛：`results/final-20261104/` 那组因此作废（`base 2` 事后补跑、同侧跨度 485 ms），重跑才拿到可用结论 | 一台更安静的机器，或更长的等待窗口 | 多花约 1.5 小时；两次 uploader 候选运行也因此没拿到干净数据 |
| uploader 候选（两份）在 `hookwrap` 阶段上传 0/74，本机最小复现正常 | 一次专门的多仓库时序调试会话 | 两个 uploader 机会停在“未验证” |
| `uploader` 阶段的积压排空（500 条，0 ms 假延迟）初始状态约 2.4–2.7 条/秒 | 允许把该阶段单独跑，或减少积压规模（属于改测量口径，需要批准） | 两个 uploader 指标仍是测不到 |
| CLI 回退模式每个工具事件约 0.98 s（30 个工具事件 32 s），主要是每次事件重新加载整个 CLI | 需要先补一个“模块加载耗时”的测量口径 | 机会 4 未开始 |
| 交付 PR `#25` 的必需上下文 `Performance Check` 在 GitHub macOS runner 上为红：`native` 任务实测时 loadBefore 29.23 / 20.73（3 核），该工作流自己的同产物对照也判“回退”，说明那次测量不可信；同一任务在不相关分支上同样失败 | 干净 runner，或该任务的重试/专用机策略（属维护者决定，不能靠放宽门限绕过） | PR 无法合入 |

## 建议下一步

1. 结束段还剩两块：`writeTargetedSnapshotTree` 对每个候选仓库仍各做一次 `read-tree`（候选数量决定收益），以及每仓库的 `rev-parse` / `config` 调用合并。
2. CLI 回退模式是下一个量级最大的目标（每个工具事件约 1 s）。先补测量口径（模块加载耗时、每事件 git 调用），再谈懒加载或让工具事件走 daemon。
3. uploader 侧要动，先解决“候选运行上传 0/74”的诊断条件，并优先结构性改动（worker 复用、请求合并），单项 200–400 ms 的微优化够不到 10% 门槛。
4. 需要维护者决定的两处：`uploader` 阶段的测量口径（积压规模/是否单独跑），以及契约探测缓存是否值得以“跨进程状态文件”的形式存在。

## 本轮为什么到此为止

- 预算到点：从确定环境到收束约 19 小时墙上时间，其中约 6 小时花在等负载门槛、一次网络中断后的重连和一次因负载作废后重跑。
- 已做过的两个方向都“见顶”：recorder 结束段的计数 47 → 36 后，剩下约 3.3 次/仓库已逼近“一次快照 + 一次提交”的下限，再降要靠目标化快照（建议 1）；包装路径的单项开销全部量过，加起来不到 10% 门槛，必须做结构性改动才能再降。
- 未开始的最大量级在 CLI 回退模式（每工具事件约 1 s），它缺测量口径，先补口径再动手。
