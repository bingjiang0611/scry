import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ORCHESTRATION_MIGRATIONS, ORCHESTRATION_PROJECTION_SCHEMA_VERSION } from './schema'
import { OrchestrationStoreError } from './types'

export interface MigrateOrchestrationOptions {
  logId?: string
}

export function migrateOrchestrationDatabase(
  db: Database.Database,
  migrations: readonly (readonly string[])[] = ORCHESTRATION_MIGRATIONS,
  options: MigrateOrchestrationOptions = {}
): void {
  let version = db.pragma('user_version', { simple: true }) as number
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new OrchestrationStoreError('orchestration_db_corrupt', `Invalid orchestration user_version: ${String(version)}`)
  }
  if (version > migrations.length) {
    throw new OrchestrationStoreError(
      'orchestration_schema_newer',
      `Orchestration database schema version ${version} is newer than supported version ${migrations.length}`
    )
  }

  while (version < migrations.length) {
    const nextVersion = version + 1
    const statements = migrations[version]
    const apply = db.transaction(() => {
      for (const statement of statements) {
        db.prepare(statement).run()
      }
      db.pragma(`user_version = ${nextVersion}`)
    })
    apply()
    version = nextVersion
  }

  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orch_meta'")
    .get()
  if (hasMeta) {
    const initMeta = db.transaction(() => {
      const insert = db.prepare('INSERT OR IGNORE INTO orch_meta (key, value) VALUES (?, ?)')
      insert.run('log_id', options.logId ?? randomUUID())
      insert.run('pruned_through', '0')
      insert.run('projection_schema_version', String(ORCHESTRATION_PROJECTION_SCHEMA_VERSION))
      insert.run('legacy_ledger_seq', '0')
      insert.run('legacy_catalog_sha256', '')
    })
    initMeta()
  }
}
