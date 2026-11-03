# 爬坡台账

执行 Agent 维护。核验方以这里和 `experiments/`、`results/` 为准。

## 当前基线

- 机器：<芯片 / 内存 / macOS / Node / git>
- 工作区：`rn-shell`（<跟踪文件数> 个跟踪文件，<n> 个子仓库）
- 二进制：scry `<commit>`，uploader `<版本或私有提交>`
- A/A 校准：`results/<目录>/AB-*.md`（结论应为 NO CLEAR CHANGE）
- 合成基线：`results/<目录>/BASELINE-*.md`

| 指标 | 基线 | 最新 | 变化 | 证据级别 |
| --- | --- | --- | --- | --- |
| hookwrap / daemon fast path / clean, 0 tools / wrapped.hookTotalPerTurn | | | | |
| hookwrap / daemon fast path / clean, 5 tools / wrapped.hookTotalPerTurn | | | | |
| recorder / daemon fast path / clean, 0 tools / gitCalls.turnStart | | | | |
| recorder / daemon fast path / clean, 0 tools / gitCalls.stop | | | | |
| hookwrap / wakeup launcher | | | | |
| uploader / backlog 500, fake latency 0ms / recordsPerSecond | | | | |
| uploader / backlog 500, fake latency 0ms / transportRequests | | | | |

## 机会排名

按“收益 × 置信度 ÷ 成本风险”。状态：待做 / 进行中 / 已保留 / 不成立 / 见顶 / 阻碍 / 否决。

| # | 机会 | 指标 | 预期 | 置信度 | 状态 | 实验 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | 待做 | |

## 见顶记录

| 目标 | 连续未成立次数 | 下限实验 | 结论 |
| --- | --- | --- | --- |

## 阻碍

| 日期 | 阻碍 | 需要什么才能继续 | 影响的机会 |
| --- | --- | --- | --- |

## 实验索引

| 日期 | 实验 | 结论 | 级别 | 提交 |
| --- | --- | --- | --- | --- |
