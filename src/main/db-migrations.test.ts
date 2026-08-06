import type Database from 'better-sqlite3'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DB_MIGRATIONS, migrateDatabase } from './db-migrations'

// Production uses better-sqlite3 rebuilt for Electron's ABI, which Node-based Vitest cannot load.
// This adapter keeps the exact SQL/transaction behavior while executing against Node's SQLite.
class MigrationTestDatabase {
  private readonly db = new DatabaseSync(':memory:')

  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.db.prepare(sql)
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    if (/^user_version$/i.test(source.trim())) {
      const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      return options?.simple ? row.user_version : row
    }
    this.db.exec(`PRAGMA ${source}`)
    return undefined
  }

  transaction<T>(operation: () => T): () => T {
    return () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close(): void {
    this.db.close()
  }

  asProductionDatabase(): Database.Database {
    return this as unknown as Database.Database
  }
}

function columns(db: MigrationTestDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name)
}

describe('SQLite migrations', () => {
  it('migrates a fresh database atomically to the current version', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase())
      expect(db.pragma('user_version', { simple: true })).toBe(DB_MIGRATIONS.length)
      expect(columns(db, 'sessions')).toContain('project_id')
      expect(columns(db, 'spans')).toEqual(expect.arrayContaining(['danger_level', 'danger_reason']))
      expect(columns(db, 'human_interventions')).toEqual(expect.arrayContaining([
        'run_id', 'question_id', 'kind', 'resolution', 'request_json', 'response_json', 'duration_ms'
      ]))
    } finally {
      db.close()
    }
  })

  it('resumes old partially applied v2 and v3 schemas without duplicate-column failure', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 2))
      db.pragma('user_version = 1')
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 2))
      expect(columns(db, 'sessions').filter((name) => name === 'project_id')).toHaveLength(1)

      db.prepare('ALTER TABLE spans ADD COLUMN danger_level TEXT').run()
      db.pragma('user_version = 2')
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 3))
      expect(columns(db, 'spans').filter((name) => name === 'danger_level')).toHaveLength(1)
      expect(columns(db, 'spans')).toContain('danger_reason')
      expect(db.pragma('user_version', { simple: true })).toBe(3)
    } finally {
      db.close()
    }
  })

  it('rolls DDL back without advancing user_version when one statement fails', () => {
    const db = new MigrationTestDatabase()
    try {
      expect(() => migrateDatabase(db.asProductionDatabase(), [[
        'CREATE TABLE should_rollback (id INTEGER)',
        'THIS IS NOT SQL'
      ]])).toThrow()
      expect(db.pragma('user_version', { simple: true })).toBe(0)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'").get()).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
