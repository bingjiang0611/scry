# Native 门禁波动分析（2026-11-13）

状态：只读分析。分析期间没有改 App source、预算、阈值、workload、比较器或 workflow，没有重跑任何 PR 来刷新失败状态。本文补充 `fix/native-performance-measurement` 分支上的工作区索引归因，不替代其结论，也不把任何一次绿灯当作修复。

## 范围与数据来源

- `performance.yml` 最近 36 次已完成运行：#347–#382，2026-11-12 16:29Z 至 2026-11-13 06:01Z。
- 每次运行的 native job 步骤结论：主比较为 `Compare native evidence and budgets`，同产物对照为 `Compare diagnostic control in both directions`。
- 19 份 native job 日志里的 `SCRY_TIMING_RUN` 行：lane、wallMs、cores、loadBefore/After、highLoad。
- 10 个 PR 的 `<!-- scry-performance -->` 评论中的 Native 表，每表 132 行。评论只反映该 PR 最新一次运行。
- 拿不到的数据：
  - A/A 每个方向具体哪几行回归：只在 artifact 和 step summary 中，API 与日志里没有，本次也无法下载 artifact。
  - 有 11 次运行的日志没有抓取。
  - 旧运行的逐行表：PR 评论已被后续运行覆盖。

## 已测量事实

### 失败率

| 项 | 结果 |
| --- | --- |
| 有效 native 主比较 | 29 次，失败 23 次（79%） |
| 同产物 A/A 对照 | 只在主比较失败后运行；运行了 23 次，失败 23 次 |
| 主比较失败但 A/A 通过 | 0 次 |
| Node compare | 35 次中失败 4 次 |
| `highLoad` | 已抓取的 208 个计时 lane 全部为 `true`；3 核 runner 的 loadBefore 范围约为 4.8–47 |

主比较通过的 6 次运行（351、357、363、365、373、379），loadBefore 并不比失败的低：

- 失败运行里负载最低的 381（4.8–11.3）照样失败。
- 同一 PR 相邻提交会交替通过与失败：#81 依次为失败（370）、通过（373）、失败（375）；#63 在 362、372 两次失败之间的 365 通过。

### 与是否改动 App 无关

| PR | 回归行 | cand < 0.8×base | cand > 1.25×base | 改动 App 运行代码 |
| --- | --- | --- | --- | --- |
| 63 | 5 | 63 | 28 | 是 |
| 73 | 20 | 28 | 66 | 是；评论来自旧的非交替 harness |
| 76 | 1 | 47 | 19 | 少量 recorder |
| 77 | 0 | 45 | 25 | 否 |
| 78 | 2 | 34 | 28 | 仅 recorder core |
| 79 | 0 | 36 | 24 | 仅 recorder core |
| 80 | 1 | 44 | 26 | 仅 recorder core |
| 81 | 2 | 33 | 44 | 仅 recorder core |
| 82 | 1 | 54 | 29 | 否（workflow / docs / CI 测试） |
| 83 | 7 | 20 | 52 | 否（两个 UI smoke 脚本） |

每个 PR 都有 15%–48% 的行变快超过 20%，同时有 14%–50% 的行变慢超过 25%。

### 首个 lane 冷启动偏差

每轮第一个计时 lane 固定是 `native-baseline-markdown`，紧跟在两侧构建之后。10 个 PR 中有 9 个的 markdown baseline 明显慢于 candidate：

| PR | nativeOpenMs p95 base→cand | scriptMs p95 base→cand | startup.driverReady base→cand |
| --- | --- | --- | --- |
| 63 | 778.5→251.9 | 601.78→175.34 | 7137→4105 |
| 76 | 607.1→236.2 | 462.00→180.49 | 7302→4178 |
| 81 | 936.3→331.9 | 681.68→225.52 | 8451→3818 |
| 82 | 701.2→240.7 | 420.77→153.17 | 5865→2864 |
| 83 | 448.7→361.7 | 220.78→259.49 | 4668→4591 |

其余 PR 的方向相同（#79 的 startup 例外）。偏慢的 baseline 会抬高该场景基于 base 的相对上限，让 markdown 候选看起来更快。按场景交替只改变了两侧的先后，没有改变“第一个 lane 永远是 baseline”这一点。

### 同产物单次墙钟波动

| 运行 | 同一 candidate 的两次 lane wall | 差异 |
| --- | --- | --- |
| 381 | markdown：20.8 s 与 control 9.7 s | 约 2.1× |
| 374 | paged：11.0 s 与 control 19.9 s | 约 1.8× |

## 机制与推测

1. **11-06 至 11-12 期间 native 比较没有执行（已核实）**：
   - a616561（#31，2026-11-06）把 CLI 入口从 `scripts/performance-native.mjs` 移到 `scripts/performance-native-run.mjs`，workflow 仍调用前者。前者只是函数库，导入后以 0 退出，不做预算比较。
   - 73c1cd9（#72，2026-11-12）修正了调用。此后的失败不是新出现的回归，而是门禁恢复后暴露出原有的噪声。
2. **多重比较（推测，粗估）**：
   - 每次比较约 132 行，每行用一次 base 测量与一次 candidate 测量比较，上限为 `min(absolute, base + max(noise, base × 0.5))`，任一行超限即整体失败。
   - 用观测到的约 21% 全通过率反推，若各行独立，单行误报率约 1.2%。各行实际相关，所以这只是量级估计，不是可直接引用的统计值。
3. **冷启动偏差（已测量现象，原因未证实）**：数据见上节。偏差可能来自构建后的磁盘缓存、编译缓存或 runner 初始化；本文没有区分这些因素。
4. **单样本墙钟波动大（已测量）**：同一产物两次 lane 墙钟相差约 2 倍，`highLoad` 恒为真，所以它不能用来区分好坏运行。

## 可选方向与维护者决定

| 方向 | 内容 | 代价 / 风险 |
| --- | --- | --- |
| A | native 计时行暂改为只报告、不阻塞；Node counter 门禁照旧 | 能解除被卡的 PR；这期间失去 native 计时回退拦截 |
| B | native 改到 main 上定期运行，看趋势 | 回退在合并后才发现；能减少 PR 的 macOS 排队 |
| C | 在第一个计时 lane 前加不计分的预热，或让各场景轮流由 base / candidate 先跑 | 改动测量代码，须单独提交并先在旧代码上证明测量一致；只能处理冷启动偏差 |
| D | 每个场景做多轮 ABAB；或要求某行在 A/A 中未超限时才判为回归 | 最接近根因；macOS 运行时间与排队成倍增加 |
| E | 可隔离的 macOS 测量容量（self-hosted 或付费 runner） | 有费用；不能预先承诺换机就通过 |

2026-11-13 维护者选择：先实施 A，同时做 C，之后在 D 与 E 中选定长期方案。A 的合同见 [performance-native.md](../performance-native.md) 的“计时行暂不阻塞”一节。工作量行、证据、lane 失败仍然阻塞。

## 未验证项

- A/A 失败的具体方向与行。
- 冷启动偏差的成因。
- A 与 C 实施后的实际效果。
- 11 次未抓取日志的运行的负载数据。
