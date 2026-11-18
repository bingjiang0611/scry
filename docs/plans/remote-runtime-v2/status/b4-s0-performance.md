# B4-S S0-6 · 性能对比（2026-11-12）

## 计数（L1）：`performance:measure -- --compare 66225f1`

B4 起点 `66225f1`（Batch 3 收尾），候选 `f5024e0`。Linux 容器（x86_64，测量开始时负载 0.22），各 5 次重复，候选版本的 collector 同时测两边。

- 135 项指标：129 项两边都测到，6 项 **unavailable**（SQLite：本容器 better-sqlite3 的 ABI 与 Electron 不符），不记为 0。
- 129 项中 125 项不变，2 项更高、2 项更低，都在 `trace.r4-cell` 的 `other` 分桶：

| 指标 | 起点 | 候选 | 同一版本 5 次之间的波动 |
|---|---:|---:|---|
| `other.stringify-bytes` | 121,984,477 | 121,984,489 | 两边都在 121,983,5xx–121,984,4xx 之间，跨度约 920 字节 |
| `total.stringify-bytes` | 177,021,617 | 177,021,629 | 同上（`reader` 分桶两边每次都完全相同） |
| `other.hash-update-bytes` | 3,728 | 3,722 | 3,704–3,728 |
| `total.hash-update-bytes` | 33,797,676 | 33,797,670 | 同上 |

结论：这 4 项的差（+12、−6 字节）在同一版本自身的运行间波动之内，来自这个并发场景的调度顺序，不是回归，也不是改进。`Ratchet: passed`，没有 `worse`。

测量工具顺带修了一处：两边都 unavailable 的行让对比表格打印时报 `value.toFixed is not a function`（测量结果已写出，只是表格中断）。单独提交，与产品代码分开。

## 毫秒（L2）：macOS，计时锁下

| 项 | 结果 | 来源 |
|---|---|---|
| App 启动（runSurfaceReady P50） | daemon 冷启动 1034.3 ms，已在运行 666.7 ms，开关关闭 678.8 ms | [b4-s0-macos-2](b4-s0-macos-2.md) C |
| S1 首 token（daemon 热启动） | P95 145.2 / 166.2 ms，P50 125.4 / 134.1 ms，满足门禁 | 同上 F |

daemon 已在运行时，App 启动与开关关闭持平；冷启动多约 350 ms，是拉起 daemon 的代价，只在 daemon 未运行时发生（开机后第一次打开，或升级后重启）。

## 未测

- 会话打开在 daemon 模式下的毫秒数。入口是 `scripts/session-open-bench.mjs`（`session-open-timing.mjs` 只是它引用的计时函数，单独运行不测任何东西）。先 `npm run build`，better-sqlite3 用 Electron ABI；在计时锁下逐个场景（`markdown`、`short`、`short-heavy`、`paged`）跑两种模式：
  `node .agents/skills/scry-performance-climb/scripts/timing-run.mjs open-<场景>-daemon -- node scripts/session-open-bench.mjs <场景> --daemon`，
  对照把标签改成 `open-<场景>-in-process` 并去掉 `--daemon`。输出 JSON 的 `mode` 字段标明模式；`performance-native.mjs` 门禁只收 `in-process`。
- Linux 毫秒（目标机不可用）；
- L3 日常记录：维护者决定一步到位、没有观察期，切换后的日常记录才能提供。
