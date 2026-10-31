# 并发 Diff 预览与内容目录批处理（2026-10-30）

## 结论与范围

基于主线 `e5b8ebd2`（App 0.2.234、CLI 0.2.53）保留 Pi/Qoder credits 修复及新圆角，再叠加：

- `cc7da355`：同一 run 内，共享同一不可变 storage/before-tree、相同采集策略的**在途** turn/session preview。无完成态缓存，不跨不同基线复用。
- `434d48b1`：同一已持有的 diff snapshot，按内容地址发布 patch；仅合并公共祖先目录准备。不跨操作缓存目录证明，不持有全部 UTF-8 Buffer。
- 发布元数据 `78bd7b9c`：App 0.2.235、CLI 0.2.54。测量用的是升版本前的 234/53 标识，不冒充已安装版本或真实 Provider 的测量。

**L1**：N=1/3/5 的 Git 调用减少 30.0% / 35.7% / 38.2%；main Node sync API attempts 均减少 14.5%。
**L2**：同一离线 Native App fixture，完成时间均值 22.98→22.76、26.12→25.64、30.33→26.93 秒。每格仅两次，不给统计显著性或日常提速承诺。
**不是整体 CPU/内存优化结论**：GPU CPU 时间上升；RSS 和 Renderer CPU 不全面下降。没有关闭动画、降帧或缩减工作负载。L3 未执行。

## 不变的合同

`RunDiffPreviewer` 从 `session-diff.ts` 拆到独立模块，保留原导出。兼容键含 repo/scope/before-tree/requested-root/pathspec/exclusions、patch 排除与完整性策略；structured paths 是发现提示，仍由 Git 完整覆盖交叉核验。每个消费者获得独立 DTO 和自己的 beforeAt；共享读取注明 sharedAfter。完成/失败立即清表；独立封口、disposed、8 秒节流及 trailing 保留。final capture、恢复、canonical record 与 scratch/index 所有权未改。

内容批处理复用原 exclusive publication：**所有祖先目录先持久化，每个文件仍 write + file sync + exclusive link + directory sync；竞争者的 EEXIST 必须比较完整字节并同步链接**。全部成功才返回引用。已有 blob 也验证完整字节并同步父目录；失败后重试重建证明。没有跨轮缓存、全局写队列、延后 fsync 或降低恢复标准。重复 File 对象与等价 UTF-8 字节不打乱引用顺序。

扫光 production CSS/renderer 本轮未修改。早期 contain:paint、will-change 及组合在 36 个深浅色/相位比较中像素相同，但 CPU 没有改善，全部拒绝；暂停动画只作归因控制，从未作为产品候选。当前 234 三个 frozen variant 的六份 renderer 资源逐字节相同。此证据不等于所有真实窗口/前台帧已逐像素验收。

## 方法与样本

同一 mac2（M1、8 核、16 GiB），Node 24.18.0、Electron 42.10.1；两逻辑 UI view。每会话 **20 tools、20 实际文件、400 assistant deltas、42 Hook shell、2 CLI launches**，每会话独立 workspace。所有变体保留 Hook 优化。冻结 main/renderer/CLI，逐次替换自己持有的产物，无真实账号/Provider 调用。

每个 N 顺序 A/B/C/C/B/A：A=234 基线（`c17411ff`，只多测量代码）；B=preview；C=preview+batch。以 timing-run.mjs 串行加锁。

- 原 18 次 controller：665864 ms，load 4.11→9.67/8，highLoad=true。N=5 六次中五次标高负载，**整组六次排除 L2**，不只挑慢点。
- 冻结产物不变，单独重做整个 N=5 六次：233369 ms，load 3.42→5.06/8，highLoad=false。
- 接受的 N=1/3 原 12 次和 N=5 新 6 次，每次 highLoad=false。按 N 独立比较，不把两块当作连续同负载测量。
- 原 233 的 18 次、早期 232 的 12 次及高负载本机 N=1 诊断保留，不混入本表。

原始 accepted 样本：[N=1](20261030-preview-and-content-batch.n1.json)、[N=3](20261030-preview-and-content-batch.n3.json)、[N=5](20261030-preview-and-content-batch.n5.json)。

| N | variant | 完成 s | Git 次 | main sync attempts | Main CPU ms | Renderer CPU ms | GPU CPU ms | Main RSS MiB | Renderer working set MiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | baseline | 22.980 | 100 | 1704 | 1716.5 | 16740.8 | 2485.2 | 228.37 | 302.63 |
| 1 | preview | 23.204 | 70 | 1704 | 1713.0 | 16963.0 | 3101.7 | 238.54 | 305.47 |
| 1 | batch | 22.760 | 70 | 1457 | 1568.4 | 16672.5 | 3099.7 | 220.19 | 319.37 |
| 3 | baseline | 26.121 | 252 | 5112 | 3675.7 | 16411.6 | 3697.9 | 259.29 | 293.09 |
| 3 | preview | 26.168 | 162 | 5112 | 3569.9 | 17004.4 | 4311.2 | 261.69 | 300.65 |
| 3 | batch | 25.639 | 162 | 4371 | 3467.4 | 16589.6 | 4453.9 | 254.18 | 290.66 |
| 5 | baseline | 30.329 | 411 | 8520 | 5395.8 | 15808.7 | 4860.0 | 261.07 | 291.21 |
| 5 | preview | 29.079 | 262 | 8520 | 5275.2 | 15723.7 | 5425.0 | 266.23 | 283.03 |
| 5 | batch | 26.927 | 254 | 7285 | 4943.4 | 14990.0 | 5057.2 | 265.17 | 280.16 |

sync 数量是有界 probe 记录的 **API attempts**，不是 kernel/SQLite/Git 子进程 syscall 成功计数。每 N 减少 247×N；本机归因样本恰好为 13 个公共祖先各少 19 次。每文件数据与发布屏障没有减少。Git/CPU/ACK 会随真实预览时序变化，不能把少子进程等同于整机 CPU 节省；全 Git 子进程 CPU unavailable。

## 完整性与可追溯证据

18 个 accepted main PID 已退出；cleanup receipt、timing lock 释放、harness/lockfile 一致、按 variant 的 artifact hash 稳定；没有截断。

- **54 records、1080 文件、1080 canonical footprints、1080 完整工具输出、21600 个有序 delta**；provider activity 只报告实际两个生命周期事件，最后为 Stop。
- 进程退出后读取 **4320 份工具 input/output 双 authority blob**，完整字节、SHA、长度均匹配；54 个 App archive 的 **3240 个 patch 引用**均读取真实 blob，并匹配完整 canonical Git patch。
- bundle 含原始 reports、records、文件、两 authority 内容、App archives、collector、校验器、两块 timing/index receipts。
- bundle：`/private/tmp/scry-step45-v234.15yvLE/step45-v234-evidence.tgz`；本机副本在本轮 `/tmp/scry-step4-sweep.HXVHxQ/`。
- SHA-256：`d12b58065198c0c55463919a505c2d01b7fce5080d8cb21dd9c38ce742d74459`。
- 当前发布源码树 `78bd7b9c` 的 tree 是 `64e0d35f2f97bdf0c43e03fab5566439a399590c`，远程隔离验证树完全一致；local/remote main SHA 均 `a7a68a67167c33798ff6c13d1c2d21d1449fb64847cde75b02b06def2a3074dc`，preload SHA 均 `21c2e11bf3b254644e7482c7d245a3cff8ae8bfc394d786765e28b077c0221f5`。

## 检查、失败与限制

- 原 preview 实现的负对照 5 fail/10 pass；新 sharing 16 项覆盖兼容性、独立 DTO/时戳、封口/释放/失败、真实 Git 修改/删除/untracked 与再次写入。
- 原逐 patch 目录准备的回归失败（公共根同步 3 而非 1）；batch 新 10 项覆盖 alias、UTF-8、祖先/文件/链接同步失败及重试、EEXIST 竞争/腐坏和复用屏障。故意移除 file sync 时目标测试失败；源码逐字节恢复。
- 最终 Node 22 全量普通 unit：**504 files / 5095 pass、4 原有 opt-in skip**；类型检查、shell 通过。
- CLI 54 release：Node 22 **59 files / 807 pass**及 package smoke；Node 20.20.2 **52 files / 632 pass**（含 batch），20/24 package smoke 通过。
- 当前 235 隔离 App 全套 renderer UI 在 mac2 通过，含 Credits、workspace/source-control、Side Chat、conversation IPC、Pi history；包检查与 packaged security/recovery/remote smokes 本机通过。没有真实手机、真实 Provider、OS 前台焦点或日常 L3 验收。
- 当前源码完整 performance collector：**135 observations、141 ratchet rows，passed**。四个非门禁 worse 为 workspace Git 10/ledger9、readdir20/18、archive bytes10558/10536、content-cold stat44/36；先前主线控制组已得相同四值，不归于本轮；本机 read payload 小幅波动属于 fixture 路径/文本长度，远程未 worse。未改 ledger、放宽门禁或升 candidate。
- 首轮 full coverage：5093 pass、2 fail、4 skip。遗漏的 RECORDER_VERSION 53→54 已修；TLS fixture 一次 5 秒超时，未改期限。两文件 focused coverage 59 pass，随后全量普通 unit 5095 pass。**不宣称全量 coverage 通过，也不引用 focused 百分比作为全仓覆盖率。**
- 本机 load 曾到 82/10 核，UI 首个 late-layout 检查超时；archive baseline 控制进程 90 秒工具截止被杀，无结果，不算 baseline pass/fail。mac2 首次全 UI 在 Side Chat receipt click 未观察到 read；独立 234 baseline 与带仅失败诊断的当前专项均通过，恢复原脚本后全套通过。原失败保留、未归因，不称修复或通过重跑抹除；未改 UI、断言、期限或 dispatch 替代品。
- 首次 benchmark build 缺专用 Hook asset、空格路径 preload 及验收器 turns envelope 的错误均已单独保留/修正；不是成功样本。远程 archive 没有 .git，首次 performance collector 因此未执行；按原源码 manifest 初始化隔离临时仓库、确认 tree 与 78bd7b9c 完全相同后才采集，未修改测量或产品代码。

## 已交付产物

[安装与门禁侧车](20261030-preview-and-content-batch.delivery.json)：App **0.2.235 / CLI 0.2.54** 已通过既有原子安装器安装到 `/Applications/Scry.app`；安装前重验批准的 234/hash，安装后读回版本、ASAR、main、CLI 完整 dist 与严格签名。保留 234 于 `/Applications/.Scry.app.backup`。逐项执行完整 pack 等价门禁、`pack:artifact` 后调用原安装器，没有跳过 bundle/安装校验，也没有手工覆盖。未停止或重启日常实例，其已加载版本未知；用户需自行重启。未 push，未发布 npm。安装后再与批准的 234 比较六份 renderer 资源：CSS 逐字节相同，JS/HTML 只差 App 版本及已对应的 chunk 文件引用；这不是完整窗口逐帧像素证明。

## 明确边界与升级条件

preview 主要覆盖可共享首轮基线，不是隐藏 run 全面停采；后台/前台切换、最终证据与现有节流不变。若后续多轮的双 preview 仍是实际主瓶颈，先补不同 before-tree 的混合负载，再单独设计 after-tree 所有权，不能跨基线复用旧结果。

batch 只覆盖同一已持有 snapshot；不宣称跨轮读缓存或同工作区多会话写争用已解决。只有重复读取/争用在真实样本中成为主瓶颈时才扩展，仍要求每 authority 的字节验证、错误传播及恢复证明。动画新架构及真实 Provider/L3 需另行授权。
