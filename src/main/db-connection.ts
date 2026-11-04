// SQLite 连接、模块级缓存与迁移闸控。schema/行映射/查询 SQL 在 span-ledger.ts。
// 这里是唯一持有连接、缓存槽与失效入口的模块；其它 db-* 模块只读这些槽。
// P0（RFC v2.4）：可信数据底座的持久化层。schema/行映射/查询 SQL 在纯模块 span-ledger.ts，
// 本文件只负责路径注入 + 预编译语句执行 + 迁移闸控。WAL + user_version 增量迁移。
// 路径来自 storage-paths 的注入（main 或 daemon 各自提供 userData），这里不碰 Electron。
// 原生模块，打包要 asarUnpack。加载失败（EDR/ABI）整体降级 no-op，不连累 app 启动。
import type Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import { chmodSync, existsSync } from 'node:fs'
import { type DbStats, type UsageAnalytics, type UsageAnalyticsRangeDays } from '../shared/trace'
import { migrateDatabase } from './db-migrations'
import { storageDbFilePath } from './storage-paths'
import type { BillingGuardianState } from '../shared/billing'
import type { ProviderId } from '../shared/provider'
import { deleteSessionDataRows, resolveSessionDataRunIds, type SessionDeleteDatabase } from './session-data-delete'

export let db: Database.Database | null = null
export let dbFilePath: string | null = null
export let dataRevision = 0
export const billingStateCacheSlot: { value?: { revision: number; value: BillingGuardianState } } = { value: undefined }
export const statsCacheSlot: { value?: { revision: number; observedAt: number; value: DbStats } } = { value: undefined }
export const usageAnalyticsCache = new Map<UsageAnalyticsRangeDays, { revision: number; toDay: string; value: UsageAnalytics }>()
export const invalidateQueryCaches = (): void => {
  dataRevision++
  billingStateCacheSlot.value = undefined
  statsCacheSlot.value = undefined
  usageAnalyticsCache.clear()
}
const require = createRequire(import.meta.url)
export let billingEnvProvider: () => NodeJS.ProcessEnv = () => process.env

export function setBillingEnvProvider(provider: () => NodeJS.ProcessEnv): void {
  billingEnvProvider = provider
  invalidateQueryCaches()
}

export function initDb(): void {
  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    dbFilePath = storageDbFilePath()
    db = new Database(dbFilePath)
    chmodSync(dbFilePath, 0o600)
    db.pragma('journal_mode = WAL')
    db.pragma('secure_delete = ON')
    migrateDatabase(db)
    for (const file of [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600)
    }
    invalidateQueryCaches()
  } catch (e) {
    try { db?.close() } catch { /* retain the original initialization error */ }
    db = null // 降级：sqlite 不可用就不写不查，app 照常跑
    console.warn('[scry] sqlite 初始化失败，观测分析降级:', (e as Error)?.message)
  }
}

export function deleteSessionData(args: {
  providerId: ProviderId
  cwd: string
  externalSessionId: string
  runIds: Iterable<string>
}): { status: 'deleted' | 'not_present' | 'unavailable'; runIds: string[]; deletedRows: number; error?: string } {
  if (!db) {
    const file = dbFilePath ?? storageDbFilePath()
    return existsSync(file)
      ? { status: 'unavailable', runIds: [...args.runIds], deletedRows: 0, error: 'SQLite 当前不可用，无法确认会话数据已清除' }
      : { status: 'not_present', runIds: [...args.runIds], deletedRows: 0 }
  }
  try {
    const result = deleteSessionDataRows(db as unknown as SessionDeleteDatabase, args)
    if (result.deletedRows > 0) invalidateQueryCaches()
    return { status: 'deleted', ...result }
  } catch (error) {
    return {
      status: 'unavailable',
      runIds: [...args.runIds],
      deletedRows: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function resolveSessionRunIds(args: {
  providerId: ProviderId
  cwd: string
  externalSessionId: string
  runIds: Iterable<string>
}): { status: 'ready' | 'not_present' | 'unavailable'; runIds: string[]; conflicts: string[]; error?: string } {
  if (!db) {
    const file = dbFilePath ?? storageDbFilePath()
    return existsSync(file)
      ? { status: 'unavailable', runIds: [], conflicts: [], error: 'SQLite 当前不可用，无法校验会话 runId 归属' }
      : { status: 'not_present', runIds: [...args.runIds], conflicts: [] }
  }
  try {
    const resolution = resolveSessionDataRunIds(db as unknown as SessionDeleteDatabase, args)
    return { status: 'ready', runIds: resolution.runIds, conflicts: resolution.conflicts }
  } catch (error) {
    return { status: 'unavailable', runIds: [], conflicts: [], error: error instanceof Error ? error.message : String(error) }
  }
}
