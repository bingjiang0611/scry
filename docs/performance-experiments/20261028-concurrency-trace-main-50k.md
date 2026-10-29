# 2026-10-28 main-only 50k：单 run projection／revision 计时 lane

## 状态

- **只是主进程组件测量**：一次固定 50k 单 run 的 main 侧 projection／revision 工作。不是 client 50k、不是 UI、不是完整 App、不是日常路径，也不含 TLS／renderer／Provider。
- **P0 已正式冻结**（baseline 冻结，不是改善结论）：最终副本 `/tmp/scry-p0-accepted-baseline.zYksRe/` 已保存并回放通过。副本内容、身份、验收与历史首败见 [P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §5。P1 未开始。
- 最终冻结之前修了两处入口／证据缺陷，不改变计时窗口：launcher 的 alias 入口判定（`6c363cc3`，改为真实文件身份比较，否则 `/tmp`→`/private/tmp` 别名会静默 exit 0 且无 report）；live lane summary 的 seed 计数（`7eac041d`，改读 `oracle.views[0].seedCount`）。本 lane 的毫秒／CPU 样本与负控不受影响，冻结身份的 bundle 仍为 `c8eed5c2…` / 63496 B。
- 没有优化 claim：本 lane 的 baseline 与 candidate 还没有任何候选实现；下面所有毫秒／CPU 都是**描述性**样本加一次 pilot 噪声估计，不是改善结论。
- `DesktopRemoteClient` 的 `MAX_ITEMS=10_000` 上限未放宽，也没有把 50k 伪装成聚合成小任务：50k 在这里是 **host 侧** projection／revision 的 scale case。

## 1. 测的是什么，边界在哪

固定 7 个 workload 阶段（`seed`／`quiet`／`replace-stream`／`append`／`coalesce`／`backfill`／`done`），每阶段：

1. 写：真实 `applyWorkloadStep`
2. 读：一次 `runtime.boundedLiveRun` + 一次 `createTraceRevisions().observe`
3. 序列化：真实 JSON 往返（`transmit`）
4. 合并：真实 `mergeRemoteTrace`
5. 核对：与**独立字面 policy oracle** 做深比较（`toolOutput: 'full'`、字段 8 KiB、turn 128 KiB）

五个相位各自是一个独立窗口，所以 `serialize`／`merge`／`oracle` 不会被算进 `reader`。计数 consumer 把后三者映射回原来的 `other` 桶，旧 counts 窗口不变。

明确不属于本 lane 的证据：

- 一次 `observe` 的 `reader` 窗口**只**含 projection + revision，不含对象解构、序列化与 merge。
- `overall`（整段 sample）、`phaseSum`（五相位求和）与 `unobservedMs`（`overall - phaseSum`）分开报；`unobservedMs` 不是"observer 成本"，它还含窗口外工作，每个窗口自身也含读时钟与记账开销，因此不是纯算法纳秒。
- CPU 是**整个 Electron 进程**的 `process.cpuUsage()` 增量（含所有线程），**不能**标成 JS 主线程 CPU。
- 内存只有 sample 前／后的 `process.memoryUsage()` 两点（after 在报告组装之前采样），不是峰值、不是 post-GC 常驻、不是 L3。

## 2. 实现位置

| 文件 | 职责 |
| --- | --- |
| `scripts/fixtures/concurrency-trace-main-trial.ts` | 共享七步 sample、五相位 observer、阶段计数合同、字面 policy oracle、唯一固定 `corrupt-body` 控制 |
| `scripts/fixtures/concurrency-trace-main-50k-sample.ts` | 计时 observer（最多 7×5 条 scalar）、失败时保留 partial、纯 report 组装（`phaseSum`／`overall`／`unobservedMs`） |
| `scripts/fixtures/concurrency-trace-main-50k.ts` | Electron entry：ready 前 `setPath(userData/sessionData/temp/logs)`、darwin `setActivationPolicy('prohibited')`、无窗口 guard（记录不外退）、真实 runtime 字段、写报告后**保持存活** |
| `scripts/fixtures/concurrency-trace-main-artifact.mjs` | 固定 entry 的 Vite SSR 构建（`noExternal`、`electron` external）、build-time selected 身份、严格 bundle 校验、drift 只报告不阻断 |
| `scripts/fixtures/concurrency-trace-main-cell-report.mjs` | 报告验收：measured 必须 7 步／7 observes／7 merges／counts 对／oracle checked／timing／runtime 齐全 |
| `scripts/concurrency-trace-main-50k.mjs` | 薄 launcher：只消费已构建 artifact、单 owner stop、120 s 工作 deadline、身份 before/after、fresh work 目录检查 |

生命周期契约：entry 写一份小报告、发**恰好一条**固定 schema 通知，然后不退出；只有 owner 的 `SIGTERM` 让它 `app.exit(0)`，这样 `stopOwnedApp` 能在进程树还活着时登记身份并收敛。登记不到（例如 config 非法导致 entry 提前 `exit(1)`）属于 **unknown cleanup**，不是"正常 stop"的证据，必须当失败读。

## 3. 重现

```bash
# 每次都用新目录：构建目标不能复用固定路径，否则会覆盖已冻结的 artifact
ART=$(mktemp -d /tmp/scry-main50k-build.XXXXXX)
WORK1=$(mktemp -d /tmp/scry-main50k-sample1.XXXXXX)
WORK2=$(mktemp -d /tmp/scry-main50k-corrupt.XXXXXX)

# 1) 构建（唯一入口，entry 固定，不能传别的入口）
SCRY_MAIN50K_OUT="$ART" node --input-type=module -e \
  "const { buildArtifact } = await import('./scripts/fixtures/concurrency-trace-main-artifact.mjs'); await buildArtifact({ outDir: process.env.SCRY_MAIN50K_OUT })"

# 2) 一次采样（work 必须是全新的空目录：报告、result、electron.log、home/userData/sessionData/tmp/logs 任一已存在都会被拒）
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs main50k-sample-1 -- \
  node scripts/concurrency-trace-main-50k.mjs --artifact "$ART" --work "$WORK1"

# 3) 固定负控（exit 1 是预期；cleanup 仍必须是 stopped / close 0）
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs main50k-negative -- \
  node scripts/concurrency-trace-main-50k.mjs --artifact "$ART" --work "$WORK2" --negative-control corrupt-body
```

一次 cell 就是一个样本：无 `--repeats`、无 `--items`。重复由 owner 在外层做，每次是新进程、新身份、新 stop、新报告。计时必须在 `timing-run.mjs` 锁内串行执行；`highLoad` 只影响该次样本的可信度。

## 4. 证据

### 4.1 计数（抽取前后完全一致）

`/tmp/scry-p0-main50k-extracted-counts.LIRtrf/observations.json`（`comparison.json` 同目录保留）：32 observations × 5 runs，在 `workload`／`layer`／`unit`／`availability`／`runs` 上逐项**精确等于**已接受的 `/tmp/scry-p0-trace-counts-complete.wT9Ehs/observations.json` 的 10k／50k 两组。也就是说，把 sample 从 collector 抽到共享模块**没有改变任何旧计数**。计数口径见[计数与试点篇](./20261028-concurrency-trace-counts-pilot.md)。

### 4.2 最终 artifact 与 5 次 pilot

- artifact：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-p0-main50k-final-build-ENh6Xh`
- bundle：`main.cjs` 63496 B，SHA-256 `c8eed5c2fb9a146fa4da6646c779cb17c93e4e4b5375e387b5026d3b060da08f`
- pilot：`/tmp/scry-p0-main50k-final-pilot.DbrEGF/{protocol.json,analysis.json,sample-1..5/report.json,corrupt-body/report.json}`

5 个样本全部：`highLoad=false`、7 步完成、35 条 phase timing、完整 oracle 核对、identity issues 为空、登记 3 个 process 均 stopped 且 `close 0`。

| 指标（都是七次 reader 窗口的合计） | median | CV |
| --- | --- | --- |
| 七次 reader 窗口的 wall 合计 | 851.623708 ms | 1.82713% |
| 七次 reader 窗口的进程 CPU 合计（整进程线程，**不是**整 trial overall CPU） | 1117.465 ms | 3.34287% |

这两个数都只覆盖**七次 reader 窗口**，不是整个 trial 的 `overall`：`overall`、`phaseSum`、`unobservedMs` 在 report 里另列，不能与本表相加。

预先在 `protocol.json` 固定的 MDE 规则是 `max(10%, 3×CV)` 向上取整到 5pp（wall 与 CPU 统一 floor 10%）：wall 得 10%，CPU 得 15%。这是**工程噪声阈值**，不是功效或显著性保证，也不能反推"更快"。

负控（`corrupt-body`）：exit 1，oracle 真实拒绝同字节正文改动并保留原始 oracle 错误文本，cleanup 仍是登记 3 个 process、`close 0`。

### 4.3 冻结旧 artifact 重放

`/tmp/scry-p0-main50k-frozen-replay.EKVwuD`：跑的是**旧**构建 `/var/folders/.../scry-p0-main50k-build-WrEROx` 的 bundle（`bebc8c727a727b07e59490432267c2bec26752ac8fa89432f5e9c18e718cc4d9`，63183 B），`sourceDrift=[scripts/fixtures/concurrency-trace-main-50k-sample.ts]`，身份 before/after 稳定，build-time 身份原样保留，登记 3 个 process `close 0`。

它的意义只有一条：**旧 source 的 bundle 能跑，但绝不冒充当前 source**。报告里 build-time 身份与 current 身份分列，drift 是披露项而不是替换项；任何比较都必须把 pair 两侧的 bundle／launcher／source 身份一起记录。

早期的第一版 functional／negative（`/tmp/scry-p0-main50k-functional.THoeDz`、`/tmp/scry-p0-main50k-corrupt.zqR9nu`）保留为历史，不作最终 pilot 的替补。

### 4.4 测试与修正过程

最终：75 tests／8 files 全过（main-trial、main50k-artifact、main50k-report、main counters、revisions、workload、performance-measure、ratchet），完整 `typecheck` 与 `git diff --check` 通过。

首轮失败与真实原因（既有测试／类型问题，也有计量实现缺陷；首败全部保留，没有重跑抹掉，也没有为迁就实现放宽负载或断言）：

- 50k 第三步（`replace-stream`）的读是 **snapshot**，不是 delta：该步的 changed indices 跨过 `MAX_TRACKED_CHANGES`（`src/main/remote/desktop-trace-delta.ts:15`），store 修剪最旧 revision（`:47`），client 的 base 失效，合同用 reset 回答（`:57`）。这是**合法 re-snapshot**，所以把测试改成带理由的精确期待，而不是放宽断言。
- TS 收窄丢失：`read.answer` 的 reset 联合在被闭包使用后失去收窄 → 在读取窗口外先落成 `reply`／`changeIndices`／`nextCursor` 三个 const；`merged.view` 同理改用 const。
- 未使用的 `type TraceDeltaAnswer` 导入。
- 负控测试的坏输入（`rejected: false`）在 `Partial<TrialReport>` 下类型不合法 → 只放宽**测试 fixture** 为 `Record<string, unknown>`，生产报告合同不动。
- 计量实现缺陷（不是测试错）：`runtime` 曾缺失；entry 曾没有 `setPath`／activation／无窗口 guard；失败时曾丢掉 partial phases 与 failure 位置；`verifyArtifact` 曾把 source drift 当错误直接拒绝，导致冻结 baseline 在后续源码变更后无法重放。这些按合同修好，并各补了回归。

## 5. 不声称

- 不升级 client 上限，不把 50k 说成 client／UI 路径。
- 不把 CPU 说成 JS 主线程，不把 `unobservedMs` 说成 observer 成本，不把 phase 求和再与 overall 相加。
- 不把缺失证据写成 0；没有毫秒或 CPU 证据就写 `unavailable` 加原因。
- 本 lane 是 main 侧组件，可作为该 scope 的受控 L2 计时来源；但当前只有 baseline、没有 candidate，因此不宣称任何改善，也不冒充 L3／日常 App／WAN／paint。
- 不宣称内存改善（只有 before／after 有界样本），也不宣称优化。
- 不宣称最终副本等同于 OS 隔离环境：`node_modules` 是链接、fixtures 只读使用，后续 A/B 仍需核对 runtime 一致（见[P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §5.1）。P1 未开始。
