# 2026-10-28 R6：真实 App 的并发 trace live lane（工具与功能矩阵）

## 状态

- **只有 R6 测量工具已验收**：本篇记录 18 个测试文件 / 108 项、完整 `typecheck`、`git diff --check` 通过的采集工具，不改变 R1–R5 的 in-main 口径（见 [readers 篇](./20261028-concurrency-trace-readers.md)）。
- **本篇采集当时 P0 未冻结**：50k Electron 耗时与噪声／MDE 预注册当时都还没做；每格只采一次功能样本，只有描述性毫秒／CPU 样本，**没有**毫秒结论。**后续记录（已落定）**：50k 组件计时与 reader=1 的 noise pilot 已完成、比较预注册已定（[main-only 50k 篇](./20261028-concurrency-trace-main-50k.md)、[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md)）；P0 已正式冻结（baseline 冻结，不是改善结论），最终副本、身份与父验收见[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §5；本篇每格仍是一次功能样本，P1 仍未开始。
- 最终冻结之前修了两处缺陷，不改变计时窗口：main50k launcher 的 alias 入口判定按真实文件身份比较（`6c363cc3`，此前 `/tmp`→`/private/tmp` 别名会静默 exit 0 且无 report）；summary 的 seed 计数改读权威的 `oracle.views[0].seedCount`（`7eac041d`）。因此**旧 raw／matrix 报告的 `summary.seedsChecked` 字段有误（曾为 0）**：涉及该字段时只信每个 completed visit 的 7 个原始 `oracle.views`（每 view 1000 seed），不要引用旧 summary 值。旧毫秒窗口与噪声阈值不变。
- 没有速度提升 claim。未安装、未推送。阶段记录不是门禁，门禁仍以[性能闭环](../performance-loop.md)为准。
- 本篇先以 `631e07ea`（40 files）落在本地提交；**提交之后**才运行完整单测：`env -u P0_PROBE -u P1_PROBE -u BILLING_ADMIN_REAL npm run test:unit` → 429 files pass + 4 skip，4565 tests pass + 4 skip，411.58 s；4 个 skip 是 `performance-correlation`、`billing-admin-real`、`p0-integration`、`p1-integration` 各自的默认显式门控。

## 1. 这条 lane 是什么

请求方向：临时 userData／HOME 下 client 窗口里的**生产 `RemoteChat`**（profiling build，`<Profiler>` 采 commit duration）→ **受限 fixture IPC**（每次调用都校验 sender、`senderFrame === sender.mainFrame` 与 exact trusted URL）→ client main 内**真实 `DesktopRemoteClient`** → loopback TLS → **已构建 App**（`out/main`，hidden 窗口）的私有 host。响应沿同一路径反向返回。

计量面分成四个 scope，互不合并：renderer commit／mount 与 round 的布局窗口、client 进程树、host 进程树、launcher Node。

**不是**：SSH／WAN／外网、paint 或 GPU、真实 Provider（走离线 `concurrency trace live` smoke 分支，无凭据、不调用真实 Provider）、手机端，也不是日常 App 使用路径。TLS 确实是真实网络：它只跑在**回环**端口上，因此本篇不对“整个进程没有任何网络连接”作未观测的保证。

## 2. 固定工作量

- 16 任务；每 run 1000 seed + 1 个 marker（`concurrency trace ready`）；每 visit 7 轮。
- `--limit 4|16`（wave 容量）、`--peers 0|1|4`；`--seed/--tasks/--rounds` 之类按名拒绝，避免出现“同名不同量”的测量。
- peer-major / run-minor 固定串行序。访问目标不是“全部来自 catalog”：cwd 是 `seedWorkspaces` 返回的 canonical realpath，`nativeRunId` 来自 `startRun` 回执，`externalSessionId` 来自真实 session 事件；host catalog 只用于校验生产侧的 sessionActive 匹配（`/tmp` 与 `/private/tmp` 的别名会让它为 false，所以 cwd 一律取 canonical 路径）。
- **不是** R5 的 LRU／reader 压测：那条 lane 的 resets／eviction 结论不能套到这里。

## 3. 计量口径

- **CPU**：per-pid cumulative delta，按 `pid + creationTime` 验身份；窗口嵌套、重叠，**从不求和**。
- **renderer 专属 scope**：`mainProcessCpu` 投影为 `unavailable / outside_filtered_scope`（client main 的 CPU 不是 renderer 证据，也不记 0）；launcher Node 只有当过滤真的选中自己的 pid 时才 `measured`。
- **bytes**：`ipcBytes: unavailable`——没有生产计数器，不发明数字。
- **setup 与 visit 分离**：client counters reset-on-read，在配对／confirm／finish／窗口加载与 fixture driver 安装之后读一次存 `setupCounters`。这里的 setup 是 client 窗口加载，不是 `RemoteChat` 的 visit mount——后者仍计入 visit 的 mount 窗口。于是每 peer `pairRequests=2`，每个 visit `pairRequests=0`。
- **两帧 rAF** 只是 DOM settlement，不声称 paint。
- **独立 oracle**：1000 seed 逐条比对 + 精确 marker（id/kind/stage/text）+ 已知 extras（`runtime:controls` / `runtime:steer_capability` / `runtime:input_receipt` 各 1/1/2）+ 每 visit 7 份视图的完整内容与顺序逐项一致（逐项字段对照，不声称用了哈希）；归档在 `trace-archive-turns-v1` 与 `trace-archives-v2` **两根 provenance** 下验证，缺失的根记 `rootPresent:false`，不是空成功。
- **question 证据**用全局 attention 的 `pendingCount`（focused-only 的 detail 不能当就绪证据）。
- **清理**：owner 视角登记进程 → stop → `close 0`；未登记的后代仍是 unknown，不声称审计了全部后代。

## 4. 六格功能矩阵（`/tmp/scry-p0-live-final-matrix.XkqxCe/acceptance.json`）

| cell | peers | limit | 正常回答 | 验证归档 | visits | round replies | traceDelta/visit | visit pairRequests | setup/peer | host tracked | client tracked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0-p4 | 0 | 4 | 16 | 16 | 0 | 0 | — | — | — | 6 | — |
| 0-p16 | 0 | 16 | 16 | 16 | 0 | 0 | — | — | — | 21 | — |
| 1-p4 | 1 | 4 | 16 | 16 | 16 | 112 | 7 | 0 | 2 | 6 | 3 |
| 1-p16 | 1 | 16 | 16 | 16 | 16 | 112 | 7 | 0 | 2 | 4 | 3 |
| 4-p4 | 4 | 4 | 16 | 16 | 64 | 448 | 7 | 0 | 2 | 5 | 3 |
| 4-p16 | 4 | 16 | 16 | 16 | 64 | 448 | 7 | 0 | 2 | 4 | 3 |

合计 96 个任务、160 visits、1120 次 round reply；每 visit 7 个完整视图；renderer scope 的 main CPU 全部 unavailable、launcher Node 的 main CPU measured；6 个 cell 全部 `owned stopped / close 0`。`--peers 0` 不启动 client，所以两格没有 client 清理证据。

全部 6 个 case 的 `highLoad=false`，但每格只有**一次功能样本**：这是功能与描述性证据，**不是**稳定 timing，也不是噪声估计。**后续记录**：reader=1、limit 4/16 各 n=5 的 noise pilot 已采且无排除，数字见 [P0 冻结与比较预注册](./20261028-concurrency-trace-p0-freeze.md) §3。

## 5. 身份

- 依赖 manifest 现为 **28 项** runtime import 闭包（含 `-question.mjs`、`-pairing.mjs`、`-client.ts` 与 archive 读取链路），另有 `out` 与 `liveOut` 两棵树的 hash；每份 report 的 before/after 全部 stable。
- 最终矩阵：harness `48160a8756ccdc332c669e57ced68b980e54cdc8fa8688919627d20cfeded6d8`，out `59c241bb1e5288dc8eb65e959320b2daad800842cafad10033b78f94f4667f4c`，liveOut `540bb0c02b6eb4f3b4eb7030644d842abd180b02a388c9b3cf3839208472047f`；fixture 构建目录 `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-p0-live-matrix-build-YVLWx9`。
- `/tmp/scry-p0-live-functional-matrix.kjVRbs` 与 `/tmp/scry-p0-live-fail3.Q2gkgr` 采自**旧的 22 项清单**，缺这两个文件，**不能**替代最终 28 项身份证据。

## 6. 负控

`--peers 1 --fail-after-round 3`：退出码 1，report 保留原始 `injected_fail_after_round`，round replies 3，`status: failed`；host tracked 9、client 3，全部 stopped、`close 0`。这条负控证明的是：最后窗口被 `abandon` 销毁后，owner 仍捕获到 client 进程树并正常 stop／`close 0`；它没有单独验证销毁后其它命令的可用性。

## 7. 历史失败索引

| 现场 | 现象 | 结论 |
| --- | --- | --- |
| `/tmp/scry-p0-live-peer0.DDqGSY` | 首轮 peer-0 超时 | question 证据只订阅 focused-only 的 detail；改为全局 attention 后修好 |
| `/tmp/scry-p0-live-peer0-attention.XsTwgL` | oracle 拒绝合法归档 | 已知 extras 漏了 `runtime:` 前缀（`controls`/`steer_capability`/`input_receipt`） |
| `/tmp/scry-p0-live-peer1.u4NxU2` | 首轮只有 intents、无 liveRun/traceDelta | cwd 别名（`/tmp` vs `/private/tmp`）使 sessionActive=false；同时 client 提前退出留下 `cleanup unknown`。后者随后靠保持进程存活修好，**旧现场不擦除** |
| `/tmp/scry-p0-live-functional-matrix.kjVRbs` | 22 项清单的旧矩阵 | 功能通过，但身份覆盖不全（缺 `-question`/`-pairing` 等），不能当最终证据 |
| `/tmp/scry-p0-live-fail3.Q2gkgr` | 旧清单的负控 | 负控行为有效，但身份覆盖不全（缺 `-question`/`-pairing` 等），不能替代最终 28 项 |

## 8. 两次测试首败（修的是 fixture）

- Node 边界样本漏 `snapshot.pid`：补上真实 `process.pid`，没有改测试期待。
- wrapper URL 负例传的 `senderFrame` 不是 `sender.mainFrame`，先命中 `untrusted_frame`：改成同一个 frame 对象专测 URL guard，仍期望 `untrusted_frame_url`。
两次都是**修 fixture**，没有放宽预期或跳过断言。

## 9. 复现

```
# 前置：App 的 out/ 必须由当前源码生成（命令记录，不在文档里执行）
npm run build

WORK=$(mktemp -d)      # report 写到 $WORK/report.json
LIVE_OUT=$(mktemp -d)  # fixture 输出（launcher 发现不全时会自己调用 buildLiveFixture）

node --input-type=module -e '
import { buildLiveFixture } from "./scripts/concurrency-trace-live-build.mjs"
const root = process.cwd()
console.log(await buildLiveFixture({ outDir: process.argv[1], root,
  mainEntry: `${root}/scripts/fixtures/concurrency-trace-live-electron.ts` }))
' "$LIVE_OUT"

# 单格：整个 launcher 在 timing lock 内跑一次（退出 75 = 锁被占用，稍后重试）
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs \
  concurrency-trace-live-peers1-limit4 -- \
  node scripts/concurrency-trace-live-bench.mjs \
    --work "$WORK" --live-out "$LIVE_OUT" --limit 4 --peers 1
```

六个 cell 各用**自己的** `mktemp` 目录：换 `--peers 0|1|4` 与 `--limit 4|16`，负控再加 `--fail-after-round 3`（必须 `--peers ≥ 1`）；同一个 `--work` 不复用，也不在锁外跑一遍再放到锁内跑一遍。`--app-root` 默认当前目录；`--work`、`--live-out` 必填，launcher 不往仓库里写。

验证命令：

```
npm run test:unit -- scripts/concurrency-trace-live-*.test.ts \
  src/main/providers/smoke-concurrency-trace.test.ts src/main/user-question.test.ts \
  src/main/live-trace-ingestion.test.ts src/main/fake-provider-integration.test.ts
npm run typecheck && git diff --check
```

## 10. 不声称

- 不是日常 App 的运行时审计；失败注入只做了 `--fail-after-round` 一种。
- 有描述性的毫秒与 CPU 样本，但没有稳定噪声估计、没有对照 L2，50k 也未测，因此**不能**说更快或更稳。**后续记录**：噪声 pilot 与 50k 组件计时已有（[P0 冻结与比较预注册](./20261028-concurrency-trace-p0-freeze.md)、[main-only 50k 篇](./20261028-concurrency-trace-main-50k.md)），但本篇仍无对照 L2，仍不能说更快。
- 不声称覆盖全部后代进程的清理：只证明登记过的进程 stopped 且 `close 0`。
- 未安装、未推送；P0 冻结与 P1 都不在本篇范围。
