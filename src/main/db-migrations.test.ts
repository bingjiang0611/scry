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

function indexes(db: MigrationTestDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA index_list("${table}")`).all() as Array<{ name: string }>).map((row) => row.name)
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
      expect(indexes(db, 'spans')).toEqual(expect.arrayContaining(['idx_spans_tool', 'idx_spans_danger_level', 'idx_spans_run']))
      expect(indexes(db, 'file_ops')).toEqual(expect.arrayContaining([
        'idx_file_ops_session', 'idx_file_ops_span', 'idx_file_ops_identity'
      ]))
      expect(indexes(db, 'usage_ledger')).toEqual(expect.arrayContaining([
        'idx_usage_ledger_canonical', 'idx_usage_ledger_run', 'idx_usage_ledger_span'
      ]))
      expect(columns(db, 'billing_sync_state')).toEqual(expect.arrayContaining(['provider', 'last_sync_ts', 'last_error']))
    } finally {
      db.close()
    }
  })

  it('deduplicates every future file_ops identity before adding the v11 unique index', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 10))
      const insert = db.prepare(
        `INSERT INTO file_ops (span_id, session_id, op, path, source, confidence, lines_added, lines_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      insert.run('span-1', 'session-a', 'write', '/repo/a.ts', 'tool-input', 'exact', null, null)
      insert.run('span-1', 'session-b', 'write', '/repo/a.ts', 'tool-input', 'inferred', 1, 2)
      migrateDatabase(db.asProductionDatabase())
      expect(db.prepare('SELECT COUNT(*) n FROM file_ops').get()).toEqual({ n: 1 })
      expect(indexes(db, 'file_ops')).toContain('idx_file_ops_identity')
    } finally {
      db.close()
    }
  })

  it('removes only legacy Skill reference spans in v12', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 11))
      const insert = db.prepare('INSERT INTO spans (id, kind, input_preview) VALUES (?, ?, ?)')
      insert.run('explicit-skill', 'skill', JSON.stringify({ skill: 'kami' }))
      insert.run('file-reference', 'skill', JSON.stringify({ source: 'skill_file', path: '/repo/.claude/skills/kami/render.py' }))
      insert.run('bash-reference', 'skill', JSON.stringify({ source: 'skill_path_in_bash', command: 'git show' }))
      insert.run('ordinary-tool', 'tool', JSON.stringify({ source: 'skill_path_in_command' }))

      migrateDatabase(db.asProductionDatabase())

      expect(db.prepare('SELECT id FROM spans ORDER BY id').all()).toEqual([
        { id: 'explicit-skill' },
        { id: 'ordinary-tool' }
      ])
    } finally {
      db.close()
    }
  })

  it('keeps replayed file evidence idempotent', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase())
      const insert = db.prepare(
        `INSERT OR IGNORE INTO file_ops (span_id, session_id, op, path, source, confidence, lines_added, lines_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const row = ['span-1', 'session-1', 'write', '/repo/a.ts', 'tool-input', 'exact', null, null]
      insert.run(...row)
      insert.run(...row)
      expect(db.prepare('SELECT COUNT(*) n FROM file_ops').get()).toEqual({ n: 1 })
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
