状态：待核验

# W21 · 独立评审记录

评审方：只读子 agent（fresh context，未改文件、未提交、未推送）。
本文件由执行方按评审方最后一条消息逐字转录并标注处理结果；评审方原文未写入仓库。

评审范围：`git diff 52fe66c4..31a31aa6`（10 个提交）、`reports/W21.md`、任务单、设计 P8 §2–§9、设计稿。

环境限制：本次评审在 macOS 上做（核验方原定在 Linux 复跑，本机没有 Linux 环境）。评审方只能跑只读检查与部分测试；`better-sqlite3` 在评审期间是 Electron ABI，依赖 SQLite 投影的用例评审方无法独立复跑。

## 评审结论

需修改（3 条阻塞项）+ 1 项需要维护者操作（mac2/mac3 真机对照）。
代码本体、提交身份、文件大小、门限、脱敏、能力位、W20 边界均无问题；测试与冒烟未被削弱。

## 阻塞项与处理

| # | 阻塞项 | 位置 | 处理 |
|---|---|---|---|
| 1 | `runs.queued` 写死为 0，把未测量的值当测量值展示（设计 §3、§「采不到记 null」） | `src/daemon/host-process.ts:256` | 已修（`3ddc420d`）：类型改 `number \| null`，daemon 报 `null`，卡片写「排队 不可用」。排队数在编排投影里，第一版没接，写进报告「与设计的出入」 |
| 2 | 执行目标卡片缺 §2 要求的「Scry 占用」一行 | `src/renderer/components/TargetMetrics.tsx` | 已修（`3ddc420d`）：复用 `ScryUsageLine`；同时把手写状态文案改为复用 `targetNotice`。冒烟加断言 `.machine-target-metrics .machine-usage` |
| 3 | 报告首行状态与验收表自相矛盾 | `reports/W21.md` | 已修：报告重写，逐项给命令与证据，未验证项单列；首行改为 `状态：待核验` |

## 非阻塞项与处理

| 项 | 处理 |
|---|---|
| `ps` 未设 `LC_ALL=C`，逗号小数点语言环境下 `%cpu` 解析失败 | 已修（`402404a0`）：所有外部命令带 `LC_ALL=C`，并加断言 |
| `hostMetricsWithinBound` 无人调用，8 KiB 上限只写在常量里 | 已修（`402404a0`）：补最坏情况测试（40 个 Provider 行、4 个盘、上限字段全填）断言远程快照 ≤ 8 KiB |
| 5 秒缓存让 2 秒最小间隔分支永远跑不到 | 已修（`402404a0`）：合成一个 `Math.max` 阈值，删掉假分支 |
| 「请升级」靠错误串包含判断 | 已修（`402404a0`）：改成与错误码等值比较；`e434b793` 补反例测试（`desktop_host_metrics_unsupported_timeout` 不算能力缺失） |
| 「x 秒前更新」冻结在打开页面那一刻 | 已修（`402404a0`）：1 秒标签时钟，登记进 `protocol-v3-retirement` 的定时器允许清单（不读数据） |
| 关闭按钮（×）这条路在搬迁后没人测 | 已修（`e434b793`）：冒烟补 × 关窗与焦点归还 |
| `.machines-section .remote-access-section > h3` 是死选择器 | 已修（`b638d09a`） |
| `machinesSnapshot` 用途不明 | 已修（`b638d09a`）：注明是测试读 store 的入口 |
| p95 余量偏小（评审方测到 49.95 ms） | 未改实现；补跑第三次：24 样本 p95 46.5 ms，p50 41.8 ms。三次结果与 load 一起写进报告，不当作「远超门限」 |
| Linux 用 `ps` 而不是设计的 `/proc/*/stat` | 未改（口径等价）；写进报告「与设计的出入」 |
| `load1` 未除以核数，界面写「4.10 / 10 核」 | 未改；写进报告「与设计的出入」，由维护者定是否要改成归一化值 |
| `daemon.pid` 传进 renderer 但界面没用到 | 未改：它在 local scope 里是设计允许的字段（remote scope 已剥离）；写进报告 |
| 动了 `inner-mtls-dispatch.ts`（+6 行）与 `host-process.ts`（不止一行） | 未改：新 op 必须进分发器，采样器必须挂载；写进报告「与设计的出入」 |
| 与设计稿的小差异（停止态圆点是否需要、本机副本文字等） | 未改：布局以设计稿为准的部分已对齐，剩余差异是文案取舍，写进报告 |

## 评审方复跑的命令与结果

| 命令 | 结果 |
|---|---|
| `npx vitest run <本次新增/改动的 12 个测试文件>` | 退出码 0，`97 passed / 1 skipped` |
| `SCRY_HOST_METRICS_P95=1 SCRY_HOST_METRICS_P95_SAMPLES=8 npx vitest run src/daemon/host-metrics-p95.test.ts --maxWorkers=1` | 通过：`coldMs 570.9`、`p50 46.67`、`p95 49.95`（load 3.8） |
| 全量 `npx vitest run` | 大量 SQLite ABI 失败（Electron ABI 146 vs Node 137），评审方判定为环境问题：执行方的 `vitest-full.log` 在同一天跑出 712/5607 全绿 |
| `ls ~/.scry` / `stat ~/.scry/grants` | 评审期间未写入真实记录（测试用 `mkdtemp` 隔离） |

## 复验

阻塞项修完后由执行方复验一次：见 `reports/W21.md`「复验」一节（全量 vitest、门限、冒烟、打包布局）。
