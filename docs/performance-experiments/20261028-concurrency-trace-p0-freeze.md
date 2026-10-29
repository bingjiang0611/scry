# 2026-10-28 P0 冻结与比较预注册（并发 trace 读者／main-only 50k）

## 状态

**比较预注册已定；P0 待父保存并回放最终 baseline 副本后正式冻结，P1 未开始。**

也就是说：预注册内容从本篇起算数，candidate 实现尚未开始；P0 的"冻结"要等父会话把最终 baseline 副本保存下来并回放成功之后才成立。本篇不声称 baseline 副本已经保存。

## 1. 已完成的部分（只链接，不复制历史）

| 阶段 | 内容 | 记录 |
| --- | --- | --- |
| C1 | 真实隔离 native App 内 16 个固定离线会话（进程／阶段归因与冻结 workload） | [会话并发 P0 篇](./20261028-session-concurrency-p0.md) |
| R1–R5 | **组件**口径：in-main 受限 fixture、trial report、Electron cell 与 timing 接线 | [并发 trace 读者篇](./20261028-concurrency-trace-readers.md) |
| 计数 | 真实 `createHash`／`Hash.update`／`JSON.stringify` 工作计数与 pilot（10k／50k） | [计数与试点篇](./20261028-concurrency-trace-counts-pilot.md) |
| R6 | 真实 App 受限回环链路的功能矩阵与噪声 pilot（工具与功能） | [R6 live lane](./20261028-concurrency-trace-live.md) |
| 50k | main-only 单 run projection／revision 计时 lane（5 次 pilot、负控、冻结重放） | [main-only 50k 篇](./20261028-concurrency-trace-main-50k.md) |
| 总览 | 并发会话 P0 的范围与开放项 | [会话并发 P0 篇](./20261028-session-concurrency-p0.md) |

## 2. P0 现有证据的边界

- 当前三个 lane 全是功能／计数／**baseline 试采**：没有 candidate 实现，因此没有任何改善比较或改善结论。
- 计数不是 CPU 成本；毫秒只能来自 `timing-run.mjs` 锁内的测量。
- R6 与 50k 都能作为**各自 scope 的受控 L2 计时**：R6 是真实 App 内受限回环链路的计时，50k 是 main 侧组件计时。当前只有 baseline、没有 candidate，所以不能声称 L2 改善，更不能冒充 L3／日常 App／WAN／paint。
- 任何清理登记不到的情形（例如非法 config 让 entry 提前退出）是 **unknown cleanup**，不是正常 stop 证据。

## 3. R6 噪声 pilot（已采，无排除）

`/tmp/scry-p0-live-noise-pilot.E0tnhE/{protocol.json,analysis.json}`：limit 4 与 16 各采 reader=1、n=5，**没有任何样本被排除**。

下表每一行都是 **16 个互不重叠 visit 窗口的合计**（rounds／client-main／renderer 各自按自己的 scope 求和），不是整 trial 的 overall CPU。

| 指标（16 visit 窗口和） | limit 4 median／CV | limit 16 median／CV |
| --- | --- | --- |
| host rounds CPU（主 endpoint） | 1176.501 ms ／ 4.51152% | 1537.910 ms ／ 2.01719% |
| client main CPU | 494.386 ms ／ 0.19355% | 536.390 ms ／ 4.58264% |
| renderer pid CPU | 475.935 ms ／ 0.60225% | 482.380 ms ／ 1.11748% |
| visitWall（16 visit 窗口和） | 3341.8 ms ／ 1.53263% | 3686.9 ms ／ 1.13075% |

visitWall 只跨 **16 个互不重叠 visit** 汇总；不同 scope 或嵌套 phase **不能相加**。

## 4. 比较预注册

### 4.1 endpoint 与 MDE

| lane | endpoint | MDE |
| --- | --- | --- |
| R6 | 每个 limit **单独**的 host rounds CPU（16 个非重叠 visit 的 rounds 窗口 CPU 和） | 15% |
| R6 | client main CPU（16 visit 窗口和，非回归） | 15% |
| R6 | renderer pid CPU（16 visit 窗口和，非回归／改善） | 5% |
| R6 | visitWall（16 visit 窗口和，非回归／改善） | 5% |
| 50k | 七次 reader 窗口的 wall 合计（**不是**整 trial `overall`） | 10% |
| 50k | 七次 reader 窗口的进程 CPU 合计（**不是**整 trial overall CPU） | 15% |

MDE 推导（两部分，阈值与顺序不变）：

- R6：对每个 endpoint 取**两个 limit 中较大的那个 CV** × 3，向上取整到 5pp，再套各自 floor（CPU 10%、renderer／wall 5%）→ host rounds CPU 15%、client main 15%、renderer 5%、visitWall 5%。
- 50k：用**自身** pilot CV × 3，wall 与 CPU **统一 floor 10%**，向上取整到 5pp → wall 10%（1.82713×3=5.48，低于 floor）、CPU 15%（3.34287×3=10.03，越过 10% 后向上取整到 15%）。

这是**工程噪声阈值**，不是功效计算、不是显著性保证，也不允许事后调整。

### 4.2 P1 每个候选的采样设计

R6（limit 4 与 limit 16 各 8 对，A = 冻结 baseline，B = candidate）：

```
块顺序：(4 ABBA), (16 BAAB), (16 ABBA), (4 BAAB)，整体重复两次 → 32 cell
块内相邻的 AB 或 BA 构成一个配对；每个 limit 8 对
```

50k（A/B 同一含义）：

```
四块：ABBA, BAAB, ABBA, BAAB → 8 对 / 16 samples
```

约束：全部在 `timing-run.mjs` 锁内串行、每 cell 全新私有目录、记录实际 bundle／launcher／源码身份。

### 4.3 排除与停止

- `highLoad=true` 只排除**该配对**，不补采、不替换；有效配对少于 6 对时该 scope 判为 **L2 未验证**。
- 任何功能、oracle、identity、cleanup 错误**立即停止**该候选，不得当噪声排掉。
- 每项非回归单独判，不能互相抵消，也不能把工作挪到另一个 scope。

### 4.4 判定与后续

- 用配对相对下降的**中位数**；至少 3/4 有效对方向一致且达到 MDE 时，才报告对应 scope 的改善。
- CPU 改善 ≠ 交互 wall 更快；memory 只有 before／after 有界样本，不是峰值、不是 post-GC、不是 L3，**不宣称内存改善**。
- 最多 3 轮候选；失败的候选保留记录。未达门槛就停止扩大；保留或撤回都要写明理由。
- 不启动 P2 架构、不自动升 gate、不自动安装、不 push。

## 5. 下一步（父会话）

1. 保存最终 baseline 副本（artifact + launcher/helper 身份 + 5 次 pilot 报告与负控）并做一次回放验证。
2. 回放成功后才把 P0 标为正式冻结；本篇状态行随之更新。
3. 之后才开始 P1 的候选实现与上述 32 + 16 采样。

## 6. 不声称

- 不声称已冻结、不声称已保存 baseline 副本、不声称已有改善。
- 不把 R6 当日常 App 路径，不把 50k 当 client／UI 路径。
- 不把计数当 CPU，不把无证据项写成 0，不把 unknown cleanup 当正常 stop。
