# Batch 3 核验（V1、F1、F2、D、db 拆分、M1）

核验对象：`67827e7..ee2c933`。提交身份全部正确。

## 结论

V1、F2、D、db 拆分接受。M1 方向正确，但漏了两个直接调用 `initDb()` 的脚本，必须先修再进 M2。F1 有三处问题，同样在进 M2 前修。

## db 拆分（`01bca85`）：接受
把拆分前的 `db.ts` 与七个新模块去掉 import/export 后逐行比对（多重集合），代码行完全一致，只有两处差别：`statsCache`、`billingStateCache` 改成槽对象，`RecordTurnArgs` 移到 `db-types.ts`。跨模块不能给导入的 `let` 赋值，所以这两处是必要的机械改写。可以认定为纯搬移。

## M1（`ee2c933`）：需要修

`storage-paths.ts` 未注入时抛 `storage_not_configured`，不回落到相对路径，这是对的；`app-lifecycle.ts` 在 `initDb()` 之前注入，main 里也没有更早的 db 调用。

**M1-1 必修：两个脚本直接调用 `initDb()`，没有注入。**
- `scripts/performance-counters/sqlite.electron.counters.test.ts` 通过 mock `electron.app.getPath` 指定临时 userData，M1 之后 db 不再读 electron，`initDb()` 报 `storage_not_configured` 并降级（本机复跑能看到 `sqlite 初始化失败，观测分析降级: storage_not_configured`）。这个测试遇到降级会返回 `null` 并写 `unavailable`，所以**测试本身是绿的**，但在装了 Electron 的 Mac 上，`analytics.sqlite` 的三个指标会从实测变成 unavailable。性能门禁会把它当成指标消失。
- `scripts/analytics-credits-ui-smoke.mjs`（在 `test:renderer:ui` 里，属于 macOS 门禁）把 `db.ts` 打包成 `db.mjs`，然后直接 `initDb()`，同样没有注入，会走降级路径。由于是打包产物，注入函数必须和 db 在同一个打包模块里：从 `db.ts` 重新导出 `configureStorage`，或者把它加进同一个 entry 的导出。

修法：两处都在 `initDb()` 前调用 `configureStorage({ userDataDir, appPath })`。验证：counters 测试在 Electron 下 `analytics.sqlite` 三个指标是 measured 而不是 unavailable；`node scripts/analytics-credits-ui-smoke.mjs` exit 0；`npm run performance:measure -- --compare 01bca85` 无 `worse`，也没有指标变成 unavailable。counters 测试属于测量代码，修复单独提交。
另外，在 `initDb()` 的 catch 里，`storage_not_configured` 是编程错误，不是 SQLite 不可用：建议让它直接抛出，不走「观测分析降级」，这样以后漏注入会立刻失败，而不是悄悄变成 unavailable。

## F1（`9f776d4`）：需要修

尾沿补读的思路和实现基本正确，版本闸门拆成 `packaged-artifact-guard.mjs` 也合理。三处问题：

**F1-1 被跟随的 run 前 15 s 没有内容读取。** `scheduler.setLive(followed ? live.scryRunId : undefined)` 里，`followed` 是本轮请求**之前**的 `foreignRunRef.current`。第一次发现别处发起的 run 时 `followed` 为空，于是 `setLive(undefined)`；下一轮的 `liveRun` 会在宿主上停最多 15 s，之后才会走到 `setLive(runId)`。这正是 F1 要修的场景。应改为：只要屏幕上有 live 的外部 run 就 `setLive(live.scryRunId)`。测试：首次发现外部 run 后，在 `liveRun` 长轮询停住期间，≤ 1.2 s 内发生第二次内容读取。

**F1-2 读取没有单飞。** tail/live 读取在 poll 之外调用 `followTrace`，节流只按**开始时间**计算。一次读取超过 1 s（慢网络、大 delta）时，下一次 live 读取会在上一次还没返回时发出，两次读取都以同一个旧的 `traceViewRef` 为基础合并。scheduler 里应只允许一个在途读取：有读取在途时把请求记为 pending，等它返回后再按节流补一次。测试：`read` 回调挂起 3 s，期间 tick 不产生第二次调用。

**F1-3 换 run 不再立即读取。** S1 保留了「不是屏幕上那个 run 就立即读」，`decide()` 丢了这一条。同一会话里一个 run 刚结束、下一个 run 开始时，新 run 的首次内容会被推迟到节流窗口结束。`decide(runId)` 在 runId 不等于上次读的 run 时应直接返回 `read-now`。

## 下一步

先修 M1-1、F1-1、F1-2、F1-3（测量代码修复单独提交），然后进入 M2。M2 按设计 §8 第 2 步，可以拆成几次，每次单独过门禁。
