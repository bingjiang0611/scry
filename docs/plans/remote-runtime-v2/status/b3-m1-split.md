# B3-M1 前置：`db.ts` 按职责拆分（纯搬移）

返回[批量状态](../STATUS-BATCH3.md)。前置原因见 [b3-m1](b3-m1.md)「提交状态」：`src/main/db.ts` 事前 44,168 B，超过 pre-commit 门禁的 20,000 B，且门禁不豁免既有文件，所以 M1 必须先拆。

## 拆法

| 新模块 | 内容 | 大小 |
|---|---|---|
| `db-connection.ts` | 连接与 `initDb`、模块级缓存槽、`invalidateQueryCaches`、`billingEnvProvider`、session 删除/归属读取 | 4,757 B |
| `db-outbox.ts` | turn outbox 写入、扫描、重放 | 5,480 B |
| `db-turns.ts` | `recordTurn` | 5,762 B |
| `db-billing-state.ts` | 连接/网关配置、ledger 行映射、guardian 状态投影、`UPSERT_BILLING_SYNC_STATE_SQL` | 15,477 B |
| `db-billing-sync.ts` | admin 同步与 fixture 导入 | 9,912 B |
| `db-stats.ts` | `statsQuery` 与 usage analytics | 6,715 B |
| `db-types.ts` | `RecordTurnArgs`（避免 outbox 与 turns 互相导入） | 714 B |
| `db.ts` | 重新导出的入口（原 import 路径不变） | 976 B |

## 不改变的东西

- **调用方不改**：`db.ts` 只做 `export { … } from './db-…'`，所有既有 `from '../db'` / `from './db'` 保持原样。
- **逻辑与签名不变**：函数体逐行搬移，没有重命名、没有改 SQL、没有改降级分支。
- 唯一的机械改写是模块级可变状态：`db` / `dbFilePath` / `dataRevision` 由 `db-connection.ts` 导出（ESM live binding），两个缓存改成 `billingStateCacheSlot.value` / `statsCacheSlot.value` 槽对象——跨模块不能给 `let` 赋值，槽是等价的单一可变位置。`usageAnalyticsCache` 仍是同一个 `Map`。
- 三个原本文件内私有的 helper（`queueTurnForDatabase`、`turnOutboxPath`、`gatewayAccountLabel`、`safeJson`）改为 `export`，因为搬到了别的模块；没有对外语义变化（不经 `db.ts` 再导出）。

## 验证

| 命令 | 结果 |
|---|---|
| `git diff --stat` | 只涉及 `src/main/db.ts`（+12/−1055）与新增的 `src/main/db-*.ts`，无其他文件 |
| `npx vitest run src/main` | 294 files / 2844 tests 通过（3 skipped） |
| `npm run typecheck` | exit 0（node + web 两个配置） |
| `npm run build` | exit 0 |
| `node scripts/electron-security-smoke.mjs --dev` | exit 0（真实进程写 DB、outbox、历史、billing 面板） |
| 各模块大小 | 全部 < 20,000 B（最大 `db-billing-state.ts` 15,477 B） |

## 既有问题（本次不处理）

`src/main/source-control/workspace-choices.test.ts › paginates bounded refs, searches beyond the first 1,000 and rejects stale page cursors` 在整批并行跑 `src/main` 时偶发 5 s 超时，单跑该文件 7 项全过（8.6 s）。属机器负载下的既有脆弱点，与本批改动无关（该测试只碰 git 与临时目录）。没有放宽超时、没有跳过。
