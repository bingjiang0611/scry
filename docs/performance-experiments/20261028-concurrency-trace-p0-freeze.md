# 2026-10-28 P0 冻结与比较预注册（并发 trace 读者／main-only 50k）

## 状态

**P0 已正式冻结（这是 baseline 冻结，不是改善结论）；P1 尚未开始。**

冻结的含义只有一条：最终 baseline 副本已保存并回放通过，candidate 实现尚未开始。预注册（§4）的 endpoint、MDE、块顺序、排除与停止规则从本篇起算数，**阈值与顺序一律不变**。副本内容、身份、验收与历史首败见 §5。

本篇不声称任何改善，也不声称已具备稳定噪声匹配或 L3 证据；P1 的第一批 A/B 尚未开始。

**后续记录（2026-10-29）**：P1 已在实施。第一步 P1a（有界 live 投影缓存）已实现，并通过 focused 59/59（10 files）、完整 typecheck、`npm run build`、`git diff --check` 与 L1 计数；真实 App／50k 功能随后在锁释放后完成检查点（[P1a 篇](./20261029-concurrency-trace-p1a.md) §5），P1b 也已实现并通过功能与 L1 验证（[P1b 篇](./20261029-concurrency-trace-p1b.md)）。完整预注册 A/B 第一轮随后执行完毕（候选 `517e4f6d`），结果按 scope 分别判定，见[结果篇](./20261029-concurrency-trace-p1-results.md)。本篇冻结当时的"P1 尚未开始"保留为历史口径，冻结副本与预注册（§3／§4，含本节阈值与顺序）未改动。

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

## 5. 冻结落定（父会话已完成）

### 5.1 保留的最终 baseline 副本

`/tmp/scry-p0-accepted-baseline.zYksRe/`（保留，不写入）：

- `source.tar`、`repo/`（Git archive `7eac041d`）、`repo/out`：冻结源码与已构建 App 产物
- `liveOut/`、`main50k/`：两个 lane 的构建输出
- `evidence/{r6Pilot,main50kPilot}/`：两个 pilot 的全部报告与负控
- `manifest.json`：`status = "saved and replay verified"`
- `replay-r6/report.json`、`replay-main50k/report.json`：最终回放报告

`source.tar` 的 sha256 是 `a124fc08b96651bd0610b6cd0c19ad405e7bcab7922695abe83f8cddbf038302`。

**副本边界**：`node_modules` 是指向原安装的链接，fixtures 只读使用。这**不是** OS 隔离，也**不是**依赖私有副本；后续 A/B 必须核对实际 runtime（Electron／Node／V8／Chrome／平台）一致，不能把"同一目录"当成"同一环境"。

### 5.2 身份

| 对象 | 身份 |
| --- | --- |
| 冻结源码 | `7eac041d`（`git archive`） |
| R6 harness | `228aeb8f…` |
| App `out` | `59c241bb…` |
| `liveOut` | `540bb0c0…` |
| main50k bundle | `c8eed5c2…` / 63496 B |
| runtime | Electron 42.10.1、Node 24.18.1、V8 14.8.178.38-electron.0、Chrome 148.0.7778.280、darwin arm64 |

R6 harness 身份由 `48160a…`（旧 pilot）变为 `228aeb8f…`，原因只有一个：计时与 cleanup 之后修正 summary 的 seed 字段读取（`7eac041d`）。旧 pilot 记录保留，不改写。

### 5.3 冻结验收（原始 oracle + 身份 + cleanup）

父验收脚本 `/tmp/scry-p0-freeze-verify.GVpXcO/check.mjs` 通过：

- R6（limit 16、peers 1）：16 个正常回答、16 个真实 archives、112 rounds／112 full-view checks，每 view 1000 seed，`summary.seedsChecked = expectedSeeds = 16000`；host 登记 6 个、client 登记 3 个进程全部 stopped 且 close0。
- 50k：35 phases、7 observe + 7 merge、oracle 全过、stage counts 固定；登记 3 个进程 stopped 且 close0；报告带 `reportedAt`，无旧 `startedAt`。
- 所有 before／after 身份稳定。

### 5.4 回放与噪声的边界

两次最终回放都是 `highLoad=true`（19.53→25.66、25.66→25.44）。它们只作**功能与可重放性**证据：不进噪声 pilot、不参与任何改善比较，也不补采替代。§3 的噪声数字仍来自无排除的 reader=1 n=5 pilot。

### 5.5 首败 chronology（保留失败记录，不掩盖）

1. 第一副本 `/tmp/scry-p0-frozen-baseline.9RJciY`：R6 真回放通过，但 main50k 的 alias CLI 静默 `exit 0` 且无 report。根因是入口判定用路径字符串比较，`/tmp` 与 `/private/tmp` 别名不等 → 模块被当成库导入。
2. 对照 `/tmp/scry-p0-main50k-cli-control.iDMPd7`：同脚本、同 `--invalid` 参数下，alias 入口 exit 0 空输出，canonical 入口 exit 1 并明确拒绝 `unknown flag`——bug 可判别。`6c363cc3` 改为按真实文件身份（`realpathSync`）判定；存在文件的 realpath 失败保留原始错误，不再静默当成"不是 CLI"。24 tests／3 files 加完整 typecheck 通过。
3. 第二副本 `/tmp/scry-p0-frozen-final.4IkgoQ`：raw R6 与 50k 的功能／身份／cleanup 全部通过，但父校验脚本真实报 `0 !== 16000`：summary 读了从未存在的 `visit.oracle.seedCount`，而原始 112 个 full-view oracle 实际全过。`7eac041d` 改为读权威的 `oracle.views[0].seedCount`，每 completed visit 只计一次（不把 7 个 view 相加），不改 schema、工作量与计时；29 tests 通过。
4. 因此：旧 matrix／pilot 报告的该 summary 字段错误，需要该字段时只信原始 `oracle.views`；旧毫秒窗口未受影响，§3 的噪声阈值继续有效。

## 6. P1 下一步

**后续记录（2026-10-29）**：P1a 已实现并验证 focused／typecheck／build／L1（[P1a 篇](./20261029-concurrency-trace-p1a.md)）；本节的采样已按原文执行一轮（候选 `517e4f6d`；limit4 6 对／limit16 7 对／main50k 8 对，48/48 检查通过，`highLoad` 整对排除后未补采），结果见[结果篇](./20261029-concurrency-trace-p1-results.md)；16 并发 host CPU 未达 15%，按本节停止扩大。

（冻结时的原文，保留）P1 **尚未开始**。开始后按 §4.2 执行：R6 每个候选用 `(4 ABBA),(16 BAAB),(16 ABBA),(4 BAAB)` 重复两次的 32 cell（每个 limit 8 对），50k 用 `ABBA,BAAB,ABBA,BAAB` 的 8 对／16 samples；全部在 `timing-run.mjs` 锁内串行，每 cell 全新私有目录，并记录实际 bundle／launcher／源码身份。

## 7. 不声称

- 不声称已有改善：P0 冻结的是 baseline，P1 还没有任何候选结果。
- 不把冻结当成稳定匹配：C1 quiet n=2 仍不稳定，真实日常 App／WAN／paint／L3 仍未验证，内存只有 before／after 有界样本。
- 不把 R6 当日常 App 路径，不把 50k 当 client／UI 路径。
- 不把计数当 CPU，不把无证据项写成 0，不把 unknown cleanup 当正常 stop。
