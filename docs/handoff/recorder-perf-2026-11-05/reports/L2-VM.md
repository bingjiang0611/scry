# L2 复测：受控 Linux guest（2026-11-05）

状态：**已测，结论比之前更窄**。单测与 L1 计数不受影响；这里只回答「安静的机器上毫秒有没有降」。

## 为什么要换机器

原来那台 macOS 测量机不安静，之前所有的毫秒 A/B 都是在它上面取的（G1.md 有记录：load 5.6 → 11.5、
Spotlight `mdworker_shared` ~55% CPU、Chrome 同跑、空闲页 ~62 MB）。复测前先查了现有可用的机器：

| 机器 | 状态 | 能否用作安静环境 |
|---|---|---|
| `30.7.226.226`（macOS 26.3.2，M1，8 核） | AliEntSafe `CloudShell` 61% CPU、Chrome Helper 38%、WindowServer 25%，load 4.7，4 个登录会话，空闲页 ~148 MB | 不能 |
| `30.7.224.127` | 主机密钥已变更，`Permission denied (publickey)`，我们的 key 不再有效 | 不能（需要新凭据） |
| `30.7.225.156` | 22 端口超时 | 不可达 |
| 本机 Mac（10 核） | load 14.8，16 个 `mdworker_shared`、Chrome 40% | 比 226.226 更吵 |
| colima VM（本机 Lima guest） | Ubuntu 24.04、kernel 6.8.0-117、aarch64、6 vCPU、8 GiB、ext4，guest load 0.1–1.7 | **用它** |

因此本轮 L2 是 **Linux guest 上的受控 A/B**，不是 macOS 复测。跨平台绝对值不可比（git 2.43.0 vs
2.50.1、ext4 vs APFS），只有同一 guest 内的前后差值有意义。

## 方法

- 两棵工作树，都从同一个 bundle 检出：
  - `before` = `02178066`（批内测量工具齐备、任何优化之前的状态）。
  - `after` = `0df7724f`（当前分支 HEAD）。
  - 两棵树的 `scripts/` 都取 `0df7724f`，测量脚本完全相同；差异只在 `src/`。
- 每棵树各自 `npm ci --ignore-scripts` + `npm run build:cli`（bench 导入 `dist`，不是 `src`）。
- 交错跑：before → after → after → before，每次 3 轮/场景（`SCRY_BENCH_ROUNDS=3`），
  共 4 次全量运行、每场景每侧 2 个 p50 样本。运行期间 guest load 0.99 / 1.36 / 1.46 / 1.67（6 核）。
- 原始数据：[20261105-recorder-engine-l2-vm.json](../../../performance-experiments/20261105-recorder-engine-l2-vm.json)
  （两次运行各自的 p50 与 git 总数，未做平均）。

## 结果：git 进程数（结构性，两侧完全一致）

| 场景 | 3 轮合计 | 每轮 |
|---|---|---|
| S1 小仓库 1 文件 | 39 → **33** | 13 → 11 |
| S2 20k 已跟踪 1 文件 | 39 → **33** | 13 → 11 |
| S3 20k dirty 基线 | 54 → **48** | 18 → 16 |
| S4 20k 300 文件 | 45 → **39** | 15 → 13 |
| S5 单个 50 MB 文件 | 39 → **33** | 13 → 11 |
| S6 多仓库 | 324 → **306** | 108 → 102 |
| S7 单会话多工具 | 21 → 21 | 7 → 7（本批未动） |
| S8 长会话 | 45 → **42** | 15 → 14 |
| S12 transcript 大文件 | 45 → **42** | 15 → 14 |
| S10 并发四会话 | 420 → 420 | 未动 |
| S11 恢复 | 12 → 12 | 见下 |

两次独立运行给出的 git 数**逐场景完全相同**，与 macOS 上的旧测量一致。这是本批唯一可以当判决用的
数字。

## 结果：毫秒（每格是 2 次运行 × 3 轮的 p50，单位 ms）

| 场景 | 阶段 | 前 | 后 | 判断 |
|---|---|---|---|---|
| S1 | end | 50.9 / 55.1 | 54.9 / 59.6 | 噪声内，**没有可测改善** |
| S2 | end | 155.0 / 138.2 | 137.7 / 240.4 | 两轮自身散布 100 ms 级，**无法归因** |
| S3 | end | 207.8 / 136.0 | 136.5 / 173.6 | 同上 |
| S4 | end | 712.3 / 693.5 | 734.4 / 700.6 | 少 2 个进程但**时间没降** |
| S5 | end | 13020 / 13708 | 14084 / 14276 | 后续 ABBA 交错复测：11,597 vs 11,430 ms，无差异（见下） |
| S6 | end | 386.7 / 506.4 | 290.7 / 439.3 | 方向正确，但跨 run 差异 150 ms |
| S7 | tool | 272.2 / 248.1 | 173.2 / 219.1 | 本批未改这条路径 → 噪声 |
| S8 | end | 716.2 / 496.6 | 486.9 / 431.4 | 方向正确，同样落在噪声边缘 |
| S11 | recovery | **350.6 / 314.7** | **4.8 / 10.9** | 30–70×，远离噪声 |
| S11 | rebuild | 423.1 / 338.3 | 284.2 / 297.1 | 两者都是 O(已完成会话数)，同阶 |
| S9 | commit | 13.6 / 3.4 / 12.0 / 3.9 / 3.8 / 11.2 | 3.4 / 3.7 / 9.8 / 4.7 / 3.9 / 8.9 | 单次提交，噪声为主 |
| S10 | concurrent | 1043.6 / 1196.8 | 1204.6 / 990.6 | 未改该路径 → 噪声 |

## 结论（收窄后的说法）

1. **已证实的 L2 收益只有一处：恢复路径（R3）。** S11 的恢复阶段 350 / 315 ms → 4.8 / 10.9 ms，
   差额是 30–70 倍，远超同一个 guest 上看到的噪声。hook 路径的 `recorderPendingHealth`
   （80.8 → 1.15 ms @ 1,000 个已完成会话）是同一改动，方向一致。
2. **G1 的进程数减少在当前证据下只是 L1 收益，不是已证实的 L2 收益。** S1–S5 每轮少 2 个 git
   进程，但在安静 guest 上没有可测的毫秒下降；S5 甚至反向。之前 macOS 上 S4 的 4757 → 3540 ms
   在这台机器上**没有复现**（734 vs 712 ms）。旧数字里 S1/S2/S3 的 55–135 ms 差值也不应再当作
   结论。
3. S5 的反向差异（+500~800 ms）**是测量假象，已复测排除**。按 ABBA 顺序交错 4 组（每组
   3 轮、每侧共 12 轮）：before 11,517 / 11,848 / 11,676 / 10,222 ms（中位 11,597），
   after 12,239 / 11,957 / 10,903 / 10,576 ms（中位 11,430）。先后顺序被交替后差异消失
   （−167 ms，−1.4%），说明之前那 +500~800 ms 来自连续运行的顺序漂移，不是代码差异。
   RSS 峰值两侧同阶（1,208–1,275 MB），也不是内存路径。
4. 之前的 macOS A/B 数字仍然记录了「进程数和 index 字节的确定性变化」，但报告里那些毫秒结论要按
   本节收窄；[G1](G1.md) 已加一行指向这里。

## 未验证

- 只测了 Linux guest。macOS 上的毫秒行为仍未在安静机器上测过；本机与 `30.7.226.226` 都不可用。
- git 2.43.0（guest）与 2.50.1（旧 macOS 测量机）不同，git 版本本身也会影响 diff/read-tree 的耗时。
- `record-visible` 全部是 0.0–0.1 ms，那是 bench 的轮询分辨率，不是 hook 端到端延迟；真实 App 的
  hook 到记录可见时间本轮没有测。
- S9/S10 的单次毫秒仍在噪声内，R4 的「不需要改」结论没有因本轮改变，也没有被本轮加强。

## 复现

```sh
# 两棵工作树（before = 02178066 的 src + HEAD 的 scripts，after = HEAD）
git bundle create /tmp/scry-perf.bundle perf/recorder-engine
colima start --cpu 6 --memory 8
colima ssh -- sh -c 'cd ~/src/scry && npm ci --ignore-scripts && npm run build:cli'
colima ssh -- sh -c 'cd ~/src/before && npm ci --ignore-scripts && npm run build:cli'
# 交错跑，每侧 3 轮
colima ssh -- sh -c 'cd ~/src/before && SCRY_BENCH_ROUNDS=3 node scripts/recorder-engine-bench.mjs --out=/tmp/before.json'
colima ssh -- sh -c 'cd ~/src/scry   && SCRY_BENCH_ROUNDS=3 node scripts/recorder-engine-bench.mjs --out=/tmp/after.json'
```
