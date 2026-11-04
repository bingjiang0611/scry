# B3-M1 核验修复（M1-1）

返回[批量状态](../STATUS-BATCH3.md)。来源：[REVIEW-BATCH3-M1](../REVIEW-BATCH3-M1.md)。**测量代码修复，单独提交。**

## 问题

M1 让 `db.ts` 不再读 Electron。两个直接调 `initDb()` 的地方没有注入 `userDataDir`，于是 `initDb()` 抛 `storage_not_configured` 并被当成「SQLite 不可用」降级：

1. `scripts/performance-counters/sqlite.electron.counters.test.ts`：mock 了 `electron.app.getPath`，M1 之后这个 mock 不再被读。降级后测试自身仍然通过（它把结果写成 `unavailable`），但门禁会把 `analytics.sqlite` 的三个指标当成指标消失。
2. `scripts/analytics-credits-ui-smoke.mjs`（`test:renderer:ui` 的一部分）：把 `db.ts` 打成 `db.mjs` 直接 `initDb()`，同样走降级。

## 修法

- counters 收集器：在 `initDb()` 之前 `configureStorage({ userDataDir: root, appPath: root })`。storage 模块用动态 import + `catch` 读取——这个收集器会被比较基线（更早的提交）复用，那些提交还没有注入模块，此时退回原来的 Electron mock 路径。
- 保留 `vi.mock('electron', …)`：只为让基线提交仍可测量；当前代码不再读它。
- `src/main/db.ts` 重新导出 `configureStorage`：`analytics-credits-ui-smoke.mjs` 只打包 `db.ts` 一个入口，注入函数必须和它在同一个打包模块里。脚本在 `initDb()` 前调用它。
- `src/main/db-connection.ts` 的 `initDb()` catch 里，`storage_not_configured` **直接抛出**，不再降级：那是接线错误，不是 SQLite 不可用。以后漏注入会立刻失败，而不是把每个指标悄悄变成 `unavailable`。

## 失败证据（先写测试）

在 counters 收集器里加断言：数据库必须真的初始化（`statsQuery().status === 'ready'`）。修复前：

```
× data-updated analytics work counters > measures complete refresh bodies without changing the source workload
  → expected 'unavailable' to be 'ready'
× SQLite analytics work counters > counts statements for one cold analytics read, or reports SQLite unavailable
```

修复后，Electron 下收集器输出 `analytics.sqlite` 三个指标为 `measured` 且数值非零：

```
[('sqlite.prepare','measured',[11,11]), ('sqlite.queries','measured',[11,11]), ('sqlite.exec','measured',[0,0])]
```

## 验证

| 命令 | 结果 |
|---|---|
| `node scripts/performance-counters.mjs collect /tmp/ctr.json sqlite`（Electron 收集器） | 6 observations，全部 `measured` |
| `node scripts/analytics-credits-ui-smoke.mjs` | exit 0，`sqliteAndArchiveProjection: true`（真实 SQLite 写入成功） |
| `npm run performance:measure -- --compare 01bca85` | exit 0，`Ratchet: passed`，**0 个 `unavailable`**，`analytics.sqlite` 各指标 0.0% 偏差 |
| `npx tsc -p tsconfig.node.json --noEmit` | 通过 |
| `npx vitest run src/main` | 2849 passed（3 skipped） |

## 一处如实说明

`sqlite.electron.counters.test.ts` 在**普通 Node** 下仍会有 4 个失败：`better-sqlite3` 按 Electron ABI 编译，普通 Node 加载不了，测试自己就报 `unavailable`。这不是本次引入的——把本文件的改动 stash 掉重跑，同样是 4 个失败。收集器本来就只在 Electron（`ELECTRON_RUN_AS_NODE=1`）下跑这个文件。
