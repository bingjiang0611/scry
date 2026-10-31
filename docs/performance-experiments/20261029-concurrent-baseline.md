# 多会话并发基线（2026-10-29，mac2）

## 结论与交付范围

本记录的初始阶段只增加测量，未做生产优化、改视觉、安装 App、推送或调用真实 Provider。L1 工作量与 L2 离线受控资源/耗时已有数据；初始阶段没有优化前后对照，不宣称提速，L3 未验证。

后续 managed Claude 工具 Hook 优化、修正后的 CPU 精度、最新 Side Chat 基线 A/B 与 0.2.232 交付状态，统一见 [Hook 优化收口](20261029-managed-hook-skip.md)。历史基线数据保留，不与后续样本混算。

5 会话下，Hook CLI 累计 CPU 中位数 31.6 秒，约占已统计 CPU 的 66%。统计范围是 Browser、Tab、GPU 和 Hook Node 进程，不含真实 Provider/MCP、git、shell 内部及其他独立 utility/worker 进程 CPU；同一进程内的线程 CPU 仍归属该进程。因此它是**当前测到的最大单项机会**，不是整台机器 CPU 的完整归因。

原方案需修正两点：

- 同一 Provider、同一工作目录的并行统一对话被生产 admission 拒绝；本基线使用独立工作区，不绕过该保护。同仓库多会话复用 diff 的收益不由本场景证明。
- 活动侧栏实际测得 2/6/10 个扫光标题，而非 1/3/5。`sidebarActivity` 分别枚举统一对话与原生会话，两类条目均可能在列表中。只记录现状，不去重、不修改样式。没有单独关闭扫光的对照，不能把全部绘制或 renderer CPU 归因于扫光。

## 环境与身份

- mac2：Apple M1，8 核，16 GiB，macOS 26.3.2，arm64。
- 控制器 Node v24.18.0；App 与 Hook CLI 使用 Electron 42.10.1。
- 生产源码基线：`b7f1b43f`。Git archive 加本次测量文件，在独立临时目录构建。远端原有 `/Users/test/vibecoding/scry` 保持 `205521e9`、工作区干净。
- 实际测量的 `harnessHash`：`2c5b48ee6a38b30b46c495a8bc6bbae9ce01d2edd03ee5efc1a90922eabd09db`，原始测量源码另存 `measured-harness.tgz`。
- 测量后为满足仓库单文件 20KB 提交门限，将 CDP 通信原样提取为 `concurrent-performance-cdp.mjs`，样本按 N 分组。函数正文逐字节等价检查通过；当前驱动指纹为 `4d8927e7168ccb9a086f4feec29ee6c2c0a29d3d27ccd74a2d2731c07ada840e`。下表保留实际测量身份，不将旧结果改标为新驱动的结果。
- App/CLI 产物 SHA-256：`1953ef2997938eb382d828ea438ebc1eb5b44d97b28b0c37edc92fcf681d558e`。
- lockfile SHA-256：`1ad471b93ab4b1c767c15783af6ba2126fd844b2469607739539826d0f0cfb20`。
- 串行计时锁：`concurrent-baseline-pointer-3x135`，329469 ms，起止 load 2.85/3.53，`highLoad: false`。9 个样本各自起止 load 范围 2.06–3.53，均未超过 8 核阈值；这不是全程系统负载采样。

## 固定负载与观测合同

每轮启动一个独立隐藏 Electron App，使用临时 HOME、userData 和 N 个独立 Git 工作区。N=1/3/5，各重复 3 次，顺序为 `(1,3,5) × 3`，不并发计时。正常生产构建配置未修改；测量配置仅给已有、显式 smoke-gated adapter 注入离线负载。

每个会话完成 20 次工具调用、20 次实际文件写入、400 条文本 delta。目标节奏为每秒一次工具、每 50 ms 一条文本；Hook/IO 变慢时拉长时间，不丢工作。每会话真实执行 UserPromptSubmit、40 个工具 Hook 和 Stop，共 42 次 CLI 启动。使用生产 `providerHookSource()`、原样 `build/scry-cli` 包装器、同一 Electron 二进制和独立 CLI 编译产物。

活动侧栏保持开启。通过已有 `nativeUiPointer` 等待有限布局动画及几何稳定，发送原生输入并核验 trusted/targetMatched receipt，再验证目标统一对话已打开。无限扫光不暂停。为覆盖 `document.hidden` 条件下会被暂停的轮询，隐藏测试窗口设置 `backgroundThrottling=false`，并断言 `visibilityState === visible`；GPU 未禁用。这不等于可见桌面窗口验收。

- 主进程每 250 ms 保存资源、fsync/git/IPC 累计计数和 event-loop delay。CPU 用前后包围样本的累计 CPU 差，最多各多覆盖一个采样间隔；CPU 百分比使用该资源窗口，不混用业务耗时。
- Hook 退出时记录实际 CPU 和 maxRSS。125–151 ms/次是完整 Hook CLI 的 CPU，包括模块加载、CLI 工作和探针，不是纯 Electron 冷启动耗时。Hook 峰值内存是单个进程峰值，不能累加成同时内存占用。
- fsync/git 只统计被探针覆盖的 main 与 Hook Node 调用；不声称覆盖 worker、shell 内部或所有内核 IO。
- `activeRuns` 字节是实际请求返回值的 UTF-8 JSON 大小，不是 Electron 线上字节。探针额外序列化一次，`handlerAndProbeMs` 包含这一观测成本。没有为计数额外发起轮询。
- CDP Paint/Layout 必须等到 `Tracing.tracingComplete` 才收口；事件数不是显示帧数，paint duration 不是 GPU 总成本。
- 前后各有固定 3 秒空闲观察窗口。后置内存选取终态后 2.0–2.8 秒、退出前的样本，不使用 will-quit 样本。没有强制 GC；基线空闲页尚未挂载目标正文，前后差值不能证明泄漏。

## 结果

下表各单元为 3 次的中位数；CPU 秒是进程累计 CPU，不是用户等待时间。逐次值、边界窗口、内存、paint、负载和指纹见 [样本索引](20261029-concurrent-baseline.samples.json)及 [N=1](20261029-concurrent-baseline.n1.json)、[N=3](20261029-concurrent-baseline.n3.json)、[N=5](20261029-concurrent-baseline.n5.json) 数据。

| 指标 | 1 会话 | 3 会话 | 5 会话 |
|---|---:|---:|---:|
| 启动至 DOM 终态并过两帧（秒） | 23.57 | 26.04 | 33.11 |
| 耗时范围（秒） | 23.52–24.61 | 26.02–26.57 | 31.22–34.25 |
| Hook CLI 启动数 | 42 | 126 | 210 |
| Hook CPU（秒） | 5.24 | 16.64 | 31.62 |
| main CPU（秒） | 1.45 | 3.27 | 5.32 |
| renderer CPU（秒） | 4.37 | 4.62 | 5.65 |
| GPU 进程 CPU（秒） | 3.27 | 3.92 | 5.36 |
| main 峰值 RSS（MiB） | 253.3 | 286.4 | 299.3 |
| renderer 峰值 working set（MiB） | 279.0 | 293.2 | 306.9 |
| 单个 Hook 峰值 RSS（MiB） | 76.2 | 76.4 | 76.4 |
| main fsync | 1704 | 5112 | 8520 |
| Hook fsync 合计 | 96 | 288 | 480 |
| main git 子进程数 | 100 | 203 | 327 |
| activeRuns 请求数 | 27 | 31 | 35 |
| activeRuns 累计 JSON（MiB） | 4.14 | 12.37 | 19.67 |
| 扫光标题数（运行初段 DOM 检查） | 2 | 6 | 10 |
| Paint 事件数 | 4364 | 11005 | 19738 |
| Paint 累计（ms） | 360.3 | 431.6 | 675.4 |
| 单轮最大 event-loop delay（ms） | 40.6 | 60.5 | 88.7 |

main/Hook fsync 计数在三次重复中均完全相同；git 子进程数分别为 100、193–208、318–337，会受预览/终态调度影响。5 会话单轮最大 event-loop delay 范围为 86.2–123.4 ms，不能当成 renderer 帧延迟。

## 验证与保留的失败

表格使用的 9/9 样本通过，均有相同的实际测量 harness 和产物指纹、真实 N 路活动快照、终态正文标记和完整 trace 收口。App 退出后独立读取归档与 `.scry/records`：共 27 个 completed canonical records，逐轮核对 20 个工具结果、400 个文本 delta 和 20 个实际文件内容，共 540 次工具、10800 条 delta、1134 次 Hook CLI。额外的退出后只读核对逐字节比较了全部 540 个文件，并确认 10800 条预期完整 delta 均在 canonical assistant 文本中。这 9 次基准的进程按登记身份收敛，对应计时锁已释放；不包含下述后来追加的拆分验证。

通信模块拆分前的检查均在 mac2 的隔离源码目录执行：

- `npx electron-vite build --config scripts/concurrent-performance.config.ts`、`npm run build:cli`：通过。
- `npm run typecheck`，以及显式包含测量配置和 Provider 夹具的 strict `tsc --noEmit`：通过。
- `npm run test:unit -- scripts/performance-feedback.test.ts scripts/concurrent-performance.test.ts scripts/performance-native.test.ts scripts/native-ui-pointer.test.mjs`：4 文件、26 测试通过，包含路径地图的合同检查。
- 新探针检查真实 fsync/git 调用，零工作对照为 0，执行工作后为 fsync=2、git=1；CPU 汇总与缺失边界拒绝测试通过。后置内存测试保留了一个进程列表为空的退出样本，证明汇总不会误用它。

预检失败没有被后续通过覆盖：

1. 未建立临时项目 authority 时被拒绝；补齐隔离 recent-folders，与现有 native fixture 相同，不放宽生产校验。
2. Codex 请求不携带本夹具所需的 managed identity；改测主路径的离线 Claude adapter，不给生产 Codex 补造能力。
3. 初版探针漏计同步 git，测试首次为 1 failed / 2 passed；补计同步入口后原断言通过，未弱化预期。
4. 已挂载页面外直接 IPC send 不触发组件自身刷新；手动 focusRun 还会切到旧聊天视图。修正为 dispatch 后原生打开统一对话，并强制验证实际全量轮询，早期遗漏轮询的样本不使用。
5. 同工作目录 N=3 被 production admission 拒绝；改为独立工作区，未重试或绕过同 cwd 保护。
6. 一组鼠标驱动在第三轮 N=3 未打开目标对话，停止该组；键盘方案在隐藏窗口未收到 click receipt，也停止。最终复用已有稳定几何/可信命中 helper，不增加超时、不加点击重试、不暂停动画。最终表格只使用此固定驱动的完整 9 样本。
7. 评审指出 trace 结束回执不代表 trace 数据收完，以及 will-quit 内存不等于空闲内存；两项均在最终系列前修正。

### 提交门限调整后的验证状态

提交检查按文件完整大小拒绝了原始大样本 JSON、驱动及既有的大机会日志。未跳过 Hook：样本按并发数分组，通信代码按职责提取；撤回机会日志的重复条目，实验结论仍保存在本报告及路径地图。

- 本地已验证：旧测量源码指纹保持一致、通信函数正文逐字节等价、3 个 cohort 共 9 样本及原始数据 SHA-256 一致、全部 JS 语法检查。提取后的 CDP 模块另用离线 stub 运行，消息路由、Paint/Layout 汇总、等待明确 trace completion、关闭时拒绝未完成请求四项通过。
- 原追加任务 PID `80895` 在 SSH 断开时状态未知。恢复后先取回原日志：`modular-verification.exit` 为 **75**，被另一项计时任务 `workflow-timeout-policy-full` 拦下，实际未启动 App，unit 未执行。原控制进程已退出；没有重放结果未知的任务。
- 确认原任务没有启动 App、计时锁已释放后，仅补跑当前拆分版本的 N=1/3/5 各一次：**3/3 通过**。代码指纹与上述当前驱动一致，App/CLI 产物指纹与原基准一致；trace 完整收口，9 条 canonical records 和归档均在退出后通过检查，实际 Hook CLI 共 378 次。此组只验证拆分后的入口，不合并到原来的九次基准，也不用于宣称提速。
- 补验计时锁标签 `concurrent-modular-recovery`：104345 ms，起止 load 2.11/4.46，`highLoad: false`。随后同一组 focused unit 为 **4 文件、26 测试通过**。日志见远端保留目录内 `modular-recovery-verification.log`、`modular-recovery-tests.log`，两者退出码均为 0。
- 每个 App 均由既有 ownership helper 确认登记进程退出（每实例登记 5 个）；再次检查 main PID `87160`、`87870`、`89733` 和控制 PID `87143` 均已不存在，计时锁已释放。远端日常仓库仍为干净的 `205521e9`，未停止或修改日常 App。追加验证的 unknown 已解除。

## 解释与下一步

- **优先候选是减少不必要的独立 Hook CLI 启动**。先证明生命周期、恢复、健康证据仍正确，再做 A/B。当前没有测量任何优化收益。
- 全量轮询确实产生可观的重复数据搬运；建议作为第二个独立实验。不得直接把焦点接口当作按会话查询，也不移除丢事件后的恢复路径。
- fsync 与 git 的工作量随并发明显增加，但调用次数不能证明可以删除持久化保护，也没有给出它们各自占用等待时间的比例。
- 动画只测现状，不改变颜色、速度、亮度、扫光形态或帧率。后续优化须保持视觉效果，另做实际渲染与等价性验证。

真实 Provider/MCP、同仓库旧会话并行、长会话、手机远程输出、停止、焦点切换、可见正文首段延迟、视觉等价及发布后日常使用未验证。原因是本场景只覆盖独立工作区的离线完成路径；相应结论需要各自固定负载或明确授权的真实探针，不能外推。

本场景是探索性基线，尚未接入 `performance:measure` collector/ledger，也不是 CI 门禁。稳定性、敏感性和用户相关性证据齐全并经维护者确认后，才考虑升级。

## 复现与原始证据

先在独立源码目录安装匹配依赖与 Electron 原生 ABI，再运行：

```sh
npx electron-builder install-app-deps
npx electron-vite build --config scripts/concurrent-performance.config.ts
npm run build:cli
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs concurrent-baseline -- sh -c '
  for round in 1 2 3; do
    for n in 1 3 5; do
      node scripts/concurrent-performance.mjs "$n" || exit $?
    done
  done
'
node scripts/concurrent-performance-summary.mjs <result.json> ...
```

- 远端保留目录：`/private/tmp/scry-concurrent-b7f1b43f.ZcWCQl`，约 987 MiB，含隔离源码/依赖、日志与 `raw-results`；现有 App 与仓库未改动。各次临时 workspace/userData 位置在原始 result 中。
- 本地证据：`/tmp/scry-concurrent-results.ta3gUg/results.tgz`，含最终逐次资源数据、App 日志、检查结果及关键预检失败日志。同目录另存 `final-metadata-checks.log`（拆分前最终 26 测试）、`payload-verification.log`（退出后完整内容核对）和 `measured-harness.tgz`（实际测量代码）。
- 原基准证据包 SHA-256：`993b46daac9ca617147ee970c462303986aec54c269bc0ff42f73efba58aedb7`。
- SSH 恢复后的补验证据：同一本地目录内 `modular-recovery.tgz`、`modular-recovery-summary.json`，包含三个场景的原始结果、App 日志、26 测试日志及原任务被锁拦下的记录；远端保留目录有同名副本。补验证据包 SHA-256：`d6f1b0cfcec74a426b045261fb91f1a8c6ca42fc0f0655944354b414000b811d`。
- 原始数据均为本次生成的离线内容；不包含真实用户会话。无需重启日常 App；没有安装新版本。
