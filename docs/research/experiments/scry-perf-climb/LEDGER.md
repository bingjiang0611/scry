# 爬坡台账

执行 Agent 维护。核验方以这里和 `experiments/`、`results/` 为准。

## 当前基线

- 机器：Apple M1 / 8 核 / 16 GiB / macOS 26.3.2 / Node v24.18.0 / git 2.50.1
- 工作区：`rn-shell`（1564 个跟踪文件，10 个子仓库；副本在 `~/scry-perf/climb/workload/rn`）
- 二进制：scry `0ae5cf95`（0.2.56），uploader `0.2.8`（私有仓 `271ab07`）
- A/A 校准：`results/aa-20261104/AB-2026-11-04T07-30-40-178Z.md`（NO CLEAR CHANGE）
- 合成基线：`results/aa-20261104/BASELINE-2026-11-04.md`

| 指标 | 基线 | 最新 | 变化 | 证据级别 |
| --- | --- | --- | --- | --- |
| hookwrap / daemon fast path / clean, 0 tools / wrapped.hookTotalPerTurn | 4764.3 ms | 4764.3 ms | – | 基线 |
| hookwrap / daemon fast path / clean, 5 tools / wrapped.hookTotalPerTurn | 3970.5 ms | 3970.5 ms | – | 基线 |
| recorder / daemon fast path / clean, 0 tools / gitCalls.turnStart | 28 | 28 | – | 基线 |
| recorder / daemon fast path / clean, 0 tools / gitCalls.stop | 47 | 36 | −11（每个仓库一次） | L1 |
| hookwrap / wakeup launcher | 178.6 ms | 178.6 ms | – | 基线 |
| recorder / CLI fallback / clean, 30 tools / hookTotalPerTurn | 32073.8 ms | 32073.8 ms | 受 recorder 改动影响的是结束段：`stop` 1897.0 → 1530.8 ms | L2（局部） |
| uploader / backlog 500, fake latency 0ms / recordsPerSecond | 测不到 | 测不到 | A/A 未跑 `uploader` 阶段；由 uploader 实验的基线侧补齐 | – |
| uploader / backlog 500, fake latency 0ms / transportRequests | 测不到 | 测不到 | 同上 | – |

## 机会排名

按“收益 × 置信度 ÷ 成本风险”。状态：待做 / 进行中 / 已保留 / 不成立 / 见顶 / 阻碍 / 否决。

| # | 机会 | 指标 | 预期 | 置信度 | 状态 | 实验 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 轮次结束候选发现重建隔离 index（每个改动仓库一次 `read-tree --reset` 并丢掉 stat cache） | `gitCalls.stop`、结束耗时 | 结束 git 调用 −1/仓库 | 高 | 已保留 | `20261104-recorder-end-index-reuse` |
| 2 | uploader 包装的 hook 在队列空时仍启动一次 Node 唤醒 | `hookwrap / wakeup launcher`、`wrapped.turnStart` | 每轮省掉 0–2 次启动（约 180 ms/次） | 曾经为高，实测后否 | 不成立 | `20261104-uploader-idle-wakeup` |
| 3 | 每次上传都重新问一遍工具参数契约（每轮一个新进程，进程内缓存活不过一轮） | `wrapped.stop`、`transportRequests` | 每轮省 1 次传输调用（约 200–400 ms，低于 10% 门槛） | 中→低 | 未验证，已回退 | `20261104-uploader-contract-probe` |
| 4 | CLI 回退模式下每个工具事件重新加载整个 CLI（30 个工具事件 ~29.4 s，约 0.98 s/事件） | `recorder / CLI fallback` 的 `toolEvent`、`hookTotalPerTurn` | 每事件降到 0.5 s 以内 | 中 | 待做 | – |
| 5 | uploader 每条记录一次请求，且每个 worker 重查一次内容能力 | `uploader / capabilityCalls`、`recordsPerRequest` | 合并能力查询与请求 | 中 | 待做 | – |
| 6 | 轮次开始/结束每仓库的 `rev-parse` / `config` 调用 | `gitCalls.turnStart` | 每仓库 −1–2 次 | 低 | 待做 | – |

## 见顶记录

| 目标 | 连续未成立次数 | 下限实验 | 结论 |
| --- | --- | --- | --- |

## 阻碍

| 日期 | 阻碍 | 需要什么才能继续 | 影响的机会 |
| --- | --- | --- | --- |

## 实验索引

| 日期 | 实验 | 结论 | 级别 | 提交 |
| --- | --- | --- | --- | --- |
| 2026-11-04 | A/A 校准 | NO CLEAR CHANGE（变好 0、变差 0、计数全部相同、摘要相同） | – | `7922f511` 及之前的测量修复 |
| 2026-11-04 | recorder 结束复用启动 index | IMPROVED（计数 47 → 36，结束耗时 −20.5%，变差 0） | L1 | `38686164` |
| 2026-11-04 | uploader 空闲唤醒跳过 | 不成立：候选运行上传 0/74（队列为空=尚未发现），已回退 | – | `8487a382`（记录） |
| 2026-11-04 | uploader 跨进程复用契约探测 | 未验证：候选运行上传 0/74，原因未定位；收益低于门槛，已回退 | – | `05ca6e67`（记录） |
