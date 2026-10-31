# 2026-10-29 P1 预注册 A/B 第一轮结果（P1a 投影缓存 ＋ P1b 增量 hash）

## 状态

**完整预注册第一轮已执行完毕（R6 32 cells ＋ main50k 16 samples）。结论按 scope 分别判定：不整体宣称 P1 改善了所有 endpoint。**

- 候选 B ＝ P1a＋P1b（源码 `517e4f6d`），基线 A ＝ P0 冻结副本（源码 `7eac041d`）。预注册（P0 冻结篇 §3／§4）未改：阈值、块顺序、排除与停止规则原样执行。
- 执行决定：**保留 P1**。依据是完整功能／负控、L1 确证的真实工作消除、main50k 明确的 L2、4 并发 hostCPU 与两个 limit 的 visitWall 在各自 scope 达门槛、未把工作移到 client、各 endpoint 配对中位数未越非回归界。
- 但 16 并发 hostCPU 未达 15%：按预注册**停止扩大**，不换阈值、不为过关追加同候选、不补采，不启动 P2，不做 gate 晋升。最多 3 候选是上限不是必须跑满，本轮只跑一轮。
- 边界：这里的 L2 只覆盖受控 loopback 的 R6 与 main50k。不推日常 App／WAN／paint／内存／L3；客户端两个 CPU 指标不称改善；单 pair 离群保留。

## 1. 资产与身份

| 角色 | 目录 | 源码 | App `out` | main50k bundle | liveOut |
| --- | --- | --- | --- | --- | --- |
| A（baseline） | `/tmp/scry-p0-accepted-baseline.zYksRe` | `7eac041d` | `59c241bb…` | `c8eed5c2…`／63 496 B | `540bb0c0…` |
| B（候选） | `/tmp/scry-p1-candidate.OprOds` | `517e4f6d` | `9204c10278d31583b0f273d4d1c5b10ed0602c04c26e3f6ac85d58982523ae2a` | `4aa4169318eab3aaf529e2099efafa35e49550cc306586cc26c158b8bec8c5f2`／67 993 B | `540bb0c0…` |

- 候选目录里 `out` 实际位于 `repo/out`（不是候选根目录），`main50k` 与 `liveOut` 同级；完整 hash 与源码 archive SHA 以 `protocol.json` 为准。
- 权威结果：`/tmp/scry-p1-ab.YBRkpd/{protocol.json,analysis.json,independent-check.json,run.mjs,analyze.mjs}`。
- 共享只读：`node_modules` 用 symlink 共享，**不是** OS 只读，也不是依赖的私有复制；两侧实际共同使用的 Electron binary 起止 SHA 一致。
- 运行时：main samples 报 Electron 42.10.1／Node 24.18.1／V8 14.8.x／Chrome 148.x／darwin arm64；driver Node 24.18.0；机器 M2 Pro，10 核。

## 2. 执行

- 严格按预注册：R6 为 `(4 ABBA),(16 BAAB),(16 ABBA),(4 BAAB)` 重复两次 ＝ 32 cells；main50k 为 `ABBA,BAAB,ABBA,BAAB` ＝ 16 samples。每 cell 使用全新私有目录，全部在 `timing-run.mjs` 锁内串行。
- 48/48 个 cells／samples 的功能、oracle、身份与登记进程 cleanup 检查通过；R6 合计 512 个回答、512 archives、3 584 rounds；main50k 16 × 35 phases。
- 这些**不是**重复的独立功能样本：此前的 functional 检查点样本没有并入本轮分析。
- 背景加载区间 3.53–11.59；`highLoad` 按整对排除：limit4 cells 28/29、30/31，limit16 cells 6/7（0-based 编号）。未补采，无重试或替换。有效 pair：limit4 6 对、limit16 7 对、main50k 8 对（均 ≥ 6）。

## 3. 分析校验

- 先用全部 10 个冻结 pilot 重现 4 个 CPU／wall 聚合值，精度在 1e-8 内。
- 分析阶段后，再用独立 Python 从 48 份 raw reports ＋ timing logs 重新提取所有 pair medians、方向与实际 limit，与 Node 分析完全一致（不是只读 accepted 摘要）。
- 下文所有数字都是**配对相对下降的中位数**，不是两组中位数的比值。

## 4. 结果

| scope（有效对） | metric | 配对下降中位数 | MDE／界 | 同方向 | 判定 |
| --- | --- | --- | --- | --- | --- |
| R6 limit4（6） | host CPU | 15.0861655% | 15% | 6/6 | **达到** |
| R6 limit4（6） | visit wall | 7.3632099% | 5% | 6/6 | **达到** |
| R6 limit4（6） | client CPU | −1.1055142%（即增加 1.11%） | 非回归 15% | 2/6 改善 | 未达改善 |
| R6 limit4（6） | renderer CPU | 3.1949586% | 5% | 5/6 | 未达改善 |
| R6 limit16（7） | host CPU | 13.7887612% | 15% | 7/7 | **未达**（不宣称该主 endpoint 改善） |
| R6 limit16（7） | visit wall | 5.1478612% | 5% | 7/7 | **达到** |
| R6 limit16（7） | client CPU | 0.6887338% | 15% | 4/7 | 未达 |
| R6 limit16（7） | renderer CPU | −0.3907244%（即增加 0.39%） | 5% | 3/7 改善 | 未达 |
| main50k（8） | reader wall | 57.116424% | 10% | 8/8 | **达到** |
| main50k（8） | CPU | 56.154961% | 15% | 8/8 | **达到** |

- 逐 endpoint 的中位数没有超过阈值回归。
- **必须保留的离群样本**：renderer 有一对（cells 24/25）**增加 15.4091%**，属有效样本、不是 `highLoad`、也没有被排除。按预注册的中位数规则它不构成超 5% 的回归判定，但这**不等于每对都没有回归**，也不作统计 noninferiority 保证；未定位原因。进一步核对原始记录后，两侧每个 visit 的 `intents/liveRun/traceDelta` 均为 7 次，14/16 个 visit 的 renderer CPU 增加，最大单个增加 29.994 ms，见 `renderer-outlier-inspection.json`。现有采样没有 renderer CPU profile，不能据此作因果归因；本轮接受这一限制，不追加样本覆盖它。

## 5. 判定与不声称

- **不声称** limit16 的 host CPU 改善（13.79% < 15%），也不为了过关改阈值或追加采样；据此停止扩大，不启动 P2、不做 gate 晋升。
- main50k 的 57%／56% 只覆盖**七个 reader 窗口之和**（`boundedLiveRun` ＋ `observe`），不是整轮 overall，更不是日常 App 路径。
- 客户端两个 CPU 指标（limit4 −1.11%、limit16 0.69%／renderer −0.39%）不称改善。

## 6. 未验证

- 完整 `npm run test:unit` 仍被父 runner 的 180 秒截断、没有完成 summary；focused 77 项分两次命令（74 项／12 文件 ＋ 3 项／1 文件）、typecheck／build／diff-check 通过，见 [P1b 篇](./20261029-concurrency-trace-p1b.md) §2。**不可写成 full tests pass**。
- 已登记进程均 stopped／close0；退出后的后代进程未追认（unknown），不作更强保证。
- 未 install、未 push；产物未交付安装，当前用户 App 不受影响。
- 日志与冻结资产留在 `/tmp` 路径，不保证跨清理长期保存；复现请从 `protocol.json` 读取完整 hash 与源码 archive SHA。

## 7. 下一步

- 本次 P0/P1 实现与预注册评估结束。不再扩大采样，也不追加同候选的补采。若要 P2、专项调查 renderer 离群值或 gate 晋升，由性能维护者另行确定任务与证据方案；不得改写本轮结果。
- 核对路径：`/tmp/scry-p1-ab.YBRkpd/run.mjs`（固定执行参数与顺序）、`analyze.mjs`（分析）、`independent-check.json`（独立复核）；候选 `repo/out` ＋ `main50k`，基线 `/tmp/scry-p0-accepted-baseline.zYksRe`。runner 拒绝重放已有 cell；未来复现必须另建目录、独立登记，不能覆盖本轮样本。
