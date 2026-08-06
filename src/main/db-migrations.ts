import type Database from 'better-sqlite3'
import { DDL_V1, DDL_V2, DDL_V3, DDL_V4, DDL_V5, DDL_V6, DDL_V7, DDL_V8 } from './span-ledger'

export const DB_MIGRATIONS: readonly (readonly string[])[] = [
  DDL_V1,
  DDL_V2,
  DDL_V3,
  DDL_V4,
  DDL_V5,
  DDL_V6,
  DDL_V7,
  DDL_V8
]

const ADD_COLUMN = /^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\b/i

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: string }>
  return rows.some((row) => row.name === column)
}

function runMigrationStatement(db: Database.Database, statement: string): void {
  const addColumn = statement.match(ADD_COLUMN)
  if (addColumn && columnExists(db, addColumn[1], addColumn[2])) return
  db.prepare(statement).run()
}

export function migrateDatabase(
  db: Database.Database,
  migrations: readonly (readonly string[])[] = DB_MIGRATIONS
): void {
  let version = db.pragma('user_version', { simple: true }) as number
  while (version < migrations.length) {
    const nextVersion = version + 1
    const apply = db.transaction(() => {
      for (const statement of migrations[version]) runMigrationStatement(db, statement)
      db.pragma(`user_version = ${nextVersion}`)
    })
    apply()
    version = nextVersion
  }
}
