// The database entry point. The work is split by responsibility so each module stays
// reviewable: connection/caches (db-connection), outbox (db-outbox), turn writes
// (db-turns), billing state and sync (db-billing-state, db-billing-sync), statistics
// (db-stats). Importers keep importing from here.
//
// 原生模块，打包要 asarUnpack。加载失败（EDR/ABI）整体降级 no-op，不连累 app 启动。
// configureStorage is re-exported here so a bundle that only pulls db.ts (the
// analytics credits UI smoke) can inject storage without a second entry point.
export { configureStorage } from './storage-paths'
export { setBillingEnvProvider, initDb, deleteSessionData, resolveSessionRunIds } from './db-connection'
export type { RecordTurnArgs } from './db-types'
export { turnOutboxSessionRunIds, deleteTurnOutboxSessionRows, replayDatabaseTurnOutbox } from './db-outbox'
export { recordTurn } from './db-turns'
export { billingStateQuery, UPSERT_BILLING_SYNC_STATE_SQL } from './db-billing-state'
export { syncBillingAdmin, importBillingFixture } from './db-billing-sync'
export { statsQuery, usageAnalyticsWithCreditsQuery, usageAnalyticsQuery } from './db-stats'
