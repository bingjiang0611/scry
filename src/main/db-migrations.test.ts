import type Database from 'better-sqlite3'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DB_MIGRATIONS, migrateDatabase } from './db-migrations'
import { DELETE_MODEL_USAGE_FOR_SPAN_SQL } from './span-ledger'

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
      expect(columns(db, 'model_usage')).toEqual(expect.arrayContaining([
        'upstream_provider', 'context_tokens', 'context_model', 'context_provider', 'context_source', 'context_quality'
      ]))
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

  it('removes only same-turn Skill injection shadows in v13', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 12))
      const insert = db.prepare('INSERT INTO spans (id, run_id, kind, name, input_preview) VALUES (?, ?, ?, ?, ?)')
      insert.run('direct', 'run-1', 'skill', 'kami', JSON.stringify({ source: 'qoder_tool' }))
      insert.run('shadow', 'run-1', 'skill', 'kami', JSON.stringify({ source: 'skill_injection' }))
      insert.run('injection-only', 'run-2', 'skill', 'kami', JSON.stringify({ source: 'skill_injection' }))

      migrateDatabase(db.asProductionDatabase())

      expect(db.prepare('SELECT id FROM spans WHERE kind = \'skill\' ORDER BY id').all()).toEqual([
        { id: 'direct' },
        { id: 'injection-only' }
      ])
    } finally {
      db.close()
    }
  })

  it('replaces provider-less pre-v14 model usage when the same span is replayed', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 13))
      db.prepare('INSERT INTO model_usage (span_id, model, input_tokens) VALUES (?, ?, ?)')
        .run('span-replay', 'shared-model', 10)
      migrateDatabase(db.asProductionDatabase())

      db.prepare(DELETE_MODEL_USAGE_FOR_SPAN_SQL).run('span-replay')
      db.prepare(
        `INSERT INTO model_usage (span_id, model, upstream_provider, input_tokens)
         VALUES (?, ?, ?, ?)`
      ).run('span-replay', 'shared-model', 'provider-a', 20)

      expect(db.prepare(
        'SELECT upstream_provider provider, input_tokens input FROM model_usage WHERE span_id = ?'
      ).all('span-replay')).toEqual([{ provider: 'provider-a', input: 20 }])
    } finally {
      db.close()
    }
  })

  it('keeps same-name model usage from different upstream providers distinct in v14', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase())
      const insert = db.prepare(
        `INSERT INTO model_usage (span_id, model, upstream_provider, input_tokens)
         VALUES (?, ?, ?, ?)`
      )
      insert.run('span-1', 'shared-model', 'provider-a', 10)
      insert.run('span-1', 'shared-model', 'provider-b', 20)
      expect(db.prepare(
        'SELECT upstream_provider provider, input_tokens input FROM model_usage ORDER BY upstream_provider'
      ).all()).toEqual([
        { provider: 'provider-a', input: 10 },
        { provider: 'provider-b', input: 20 }
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
